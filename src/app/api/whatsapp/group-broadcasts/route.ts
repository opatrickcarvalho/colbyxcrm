import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { validateSendMessageParams, SendMessageError } from '@/lib/whatsapp/send-message';
import {
  GROUP_CONTENT_TYPES,
  resolveGroupBroadcastDelaySeconds,
} from '@/lib/whatsapp/group-broadcast';
import {
  resolveGroupCredentials,
  GroupsNotAvailableError,
} from '@/lib/whatsapp/providers/uazapi-groups';
import { planSendTimes, parseScheduledAt, type SendWindow } from '@/lib/campaigns/schedule';
import { renderMessage, validateSpintax, type SpintaxVars } from '@/lib/campaigns/spintax';
import {
  resolveTargets,
  countTargets,
  firstName,
  TargetValidationError,
  type RawTargets,
} from '@/lib/campaigns/targets';

// Dashboard CRUD for whatsapp_group_broadcasts. The actual send happens
// later, out-of-band, via the cron drain route
// (src/app/api/whatsapp/group-broadcasts/cron/route.ts) — this route
// only ever persists a campaign row plus one target row per recipient
// (group, saved contact, or hand-typed phone — see 052_campaigns.sql),
// each pre-staggered by planSendTimes(). Deliberately a parallel system
// to src/app/api/whatsapp/broadcast (Meta/contact templates) — not
// built on top of it.
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get('limit')) || 50, 200);

    const { data, error } = await supabase
      .from('whatsapp_group_broadcasts')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[GET /api/whatsapp/group-broadcasts] error:', error);
      return NextResponse.json(
        { error: 'Failed to load group broadcasts' },
        { status: 500 }
      );
    }

    return NextResponse.json({ data: data ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
const DEFAULT_JITTER_PCT = 20;

/** `{ start, end, days } | null` from the request body -> a `SendWindow`,
 *  or null for "no restriction". Structural validation only — the actual
 *  time/weekday semantics are validated by planSendTimes()/isWithinWindow()
 *  down the line, which already produce descriptive errors. */
function parseWindowInput(input: unknown, timeZone: string): SendWindow | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('window must be an object with start, end, and days, or null');
  }
  const w = input as { start?: unknown; end?: unknown; days?: unknown };
  if (typeof w.start !== 'string' || typeof w.end !== 'string') {
    throw new Error('window.start and window.end are required "HH:MM" strings');
  }
  if (!Array.isArray(w.days) || w.days.some((d) => typeof d !== 'number')) {
    throw new Error('window.days must be an array of ISO weekday numbers (1 = Monday .. 7 = Sunday)');
  }
  return { start: w.start, end: w.end, days: w.days as number[], timeZone };
}

interface PlannedRecipient {
  groupId?: string;
  contactId?: string;
  phone?: string;
  vars: SpintaxVars;
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(
      `groupBroadcastCreate:${userId}`,
      RATE_LIMITS.groupBroadcastCreate
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const {
      name,
      content_type,
      content_text,
      media_url,
      filename,
      // Legacy top-level shape — kept working so existing callers don't break.
      group_ids: legacyGroupIds,
      delay_seconds,
      delay_jitter_pct,
      scheduled_at,
      timezone,
      window: windowInput,
      spintax_enabled,
      invisible_chars,
      audience_id,
      targets: targetsInput,
      save_audience_as,
    } = body as {
      name?: string;
      content_type?: string;
      content_text?: string | null;
      media_url?: string | null;
      filename?: string | null;
      group_ids?: string[];
      delay_seconds?: number;
      delay_jitter_pct?: number;
      scheduled_at?: string;
      timezone?: string;
      window?: { start: string; end: string; days: number[] } | null;
      spintax_enabled?: boolean;
      invisible_chars?: boolean;
      audience_id?: string;
      targets?: RawTargets;
      save_audience_as?: string;
    };

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!content_type || !(GROUP_CONTENT_TYPES as readonly string[]).includes(content_type)) {
      return NextResponse.json(
        { error: `content_type must be one of: ${GROUP_CONTENT_TYPES.join(', ')}` },
        { status: 400 }
      );
    }
    if (
      delay_seconds !== undefined &&
      (!Number.isFinite(delay_seconds) || delay_seconds < 1)
    ) {
      return NextResponse.json(
        { error: 'delay_seconds must be a number >= 1' },
        { status: 400 }
      );
    }
    if (delay_jitter_pct !== undefined && !Number.isFinite(delay_jitter_pct)) {
      return NextResponse.json(
        { error: 'delay_jitter_pct must be a finite number' },
        { status: 400 }
      );
    }

    try {
      validateSendMessageParams({
        messageType: content_type,
        contentText: content_text,
        mediaUrl: media_url,
      });
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    // Groups only exist on UAZAPI (Meta has no group support at all —
    // see src/lib/whatsapp/providers/capabilities.ts). Every campaign
    // row needs a whatsapp_config_id regardless of what kind of
    // recipients it targets, so this gate stays unconditional — group
    // broadcasts are, and remain, a UAZAPI-only feature end to end.
    let creds;
    try {
      creds = await resolveGroupCredentials(supabase, accountId);
    } catch (err) {
      if (err instanceof GroupsNotAvailableError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    // ---- gather raw target ids from every source (legacy top-level
    // group_ids, the new `targets` object, and an optional seed
    // audience), then validate the union once. ----
    const rawTargets: RawTargets = {
      group_ids: [...(legacyGroupIds ?? []), ...(targetsInput?.group_ids ?? [])],
      contact_ids: [...(targetsInput?.contact_ids ?? [])],
      phones: [...(targetsInput?.phones ?? [])],
    };

    if (audience_id) {
      const { data: audience, error: audienceErr } = await supabase
        .from('campaign_audiences')
        .select('id')
        .eq('id', audience_id)
        .eq('account_id', accountId)
        .maybeSingle();
      if (audienceErr) {
        console.error('[POST /api/whatsapp/group-broadcasts] audience lookup error:', audienceErr);
        return NextResponse.json({ error: 'Failed to load audience' }, { status: 500 });
      }
      if (!audience) {
        return NextResponse.json({ error: 'Audience not found in this account' }, { status: 404 });
      }
      const { data: members, error: membersErr } = await supabase
        .from('campaign_audience_members')
        .select('group_id, contact_id, phone')
        .eq('audience_id', audience_id);
      if (membersErr) {
        console.error('[POST /api/whatsapp/group-broadcasts] audience members error:', membersErr);
        return NextResponse.json({ error: 'Failed to load audience members' }, { status: 500 });
      }
      for (const m of members ?? []) {
        if (m.group_id) rawTargets.group_ids!.push(m.group_id as string);
        else if (m.contact_id) rawTargets.contact_ids!.push(m.contact_id as string);
        else if (m.phone) rawTargets.phones!.push(m.phone as string);
      }
    }

    let resolved;
    try {
      resolved = await resolveTargets(supabase, accountId, rawTargets);
    } catch (err) {
      if (err instanceof TargetValidationError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    const totalTargets = countTargets(resolved);
    if (totalTargets === 0) {
      return NextResponse.json(
        { error: 'At least one target (group, contact, or phone) is required' },
        { status: 400 }
      );
    }

    const spintaxEnabled = spintax_enabled ?? true;
    const invisibleChars = invisible_chars ?? false;
    const resolvedTimezone = timezone || DEFAULT_TIMEZONE;

    // A template that fails to parse must be rejected up front, not
    // discovered per-recipient at render time — renderMessage() itself
    // never throws (it falls back to a stripped literal), so this is
    // the only gate.
    const shouldRenderSpintax =
      spintaxEnabled && content_type !== 'audio' && !!content_text && content_text.trim().length > 0;
    if (shouldRenderSpintax) {
      const check = validateSpintax(content_text!);
      if (!check.ok) {
        return NextResponse.json(
          { error: `Invalid spintax template: ${check.error}` },
          { status: 400 }
        );
      }
    }

    let window: SendWindow | null;
    try {
      window = parseWindowInput(windowInput, resolvedTimezone);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid window' },
        { status: 400 }
      );
    }

    let scheduledDate: Date;
    if (scheduled_at) {
      // A caller that sends a bare wall-clock time ('2026-08-09T14:30')
      // means it in the campaign's zone, not the server's — see
      // parseScheduledAt(). Anything with a 'Z' or an offset, which is
      // what the composer now sends, is already unambiguous.
      const parsed = parseScheduledAt(scheduled_at, resolvedTimezone);
      if (!parsed || parsed.getTime() <= Date.now()) {
        return NextResponse.json(
          { error: 'scheduled_at must be a valid future date/time' },
          { status: 400 }
        );
      }
      scheduledDate = parsed;
    } else {
      scheduledDate = new Date();
    }

    const resolvedDelaySeconds =
      delay_seconds ?? (await resolveGroupBroadcastDelaySeconds(supabase, accountId));
    const jitterPct = delay_jitter_pct ?? DEFAULT_JITTER_PCT;

    // Stable order: groups, then contacts, then phones. Only the pairing
    // between this array and the planSendTimes() output matters — the
    // order itself carries no meaning to the drain, which only reads
    // `send_at`.
    const recipients: PlannedRecipient[] = [
      ...resolved.groupIds.map((groupId) => ({ groupId, vars: {} as SpintaxVars })),
      ...resolved.contacts.map((c) => ({
        contactId: c.id,
        vars: {
          nome: c.name ?? '',
          primeiro_nome: firstName(c.name),
          telefone: c.phone,
        } as SpintaxVars,
      })),
      ...resolved.phones.map((phone) => ({ phone, vars: {} as SpintaxVars })),
    ];

    let sendTimes;
    try {
      sendTimes = planSendTimes({
        count: recipients.length,
        startAt: scheduledDate,
        delaySeconds: resolvedDelaySeconds,
        jitterPct,
        window,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to plan send times' },
        { status: 400 }
      );
    }

    const { data: broadcast, error: insertError } = await supabase
      .from('whatsapp_group_broadcasts')
      .insert({
        account_id: accountId,
        whatsapp_config_id: creds.configId,
        created_by: userId,
        name: name.trim(),
        content_type,
        content_text: content_text || null,
        media_url: media_url || null,
        filename: filename || null,
        delay_seconds: resolvedDelaySeconds,
        delay_jitter_pct: jitterPct,
        window_start: window?.start ?? null,
        window_end: window?.end ?? null,
        window_days: window?.days ?? null,
        timezone: resolvedTimezone,
        spintax_enabled: spintaxEnabled,
        invisible_chars: invisibleChars,
        audience_id: audience_id ?? null,
        status: 'pending',
        total_targets: recipients.length,
        scheduled_at: scheduled_at ? scheduledDate.toISOString() : null,
      })
      .select()
      .single();

    if (insertError || !broadcast) {
      console.error('[POST /api/whatsapp/group-broadcasts] insert error:', insertError);
      return NextResponse.json({ error: 'Failed to create group broadcast' }, { status: 500 });
    }

    const targetRows = recipients.map((r, i) => ({
      broadcast_id: broadcast.id,
      group_id: r.groupId ?? null,
      contact_id: r.contactId ?? null,
      phone: r.phone ?? null,
      send_at: sendTimes[i].toISOString(),
      status: 'pending' as const,
      rendered_text: shouldRenderSpintax
        ? renderMessage(content_text!, { vars: r.vars, invisibleChars })
        : null,
    }));

    const { error: targetsError } = await supabase
      .from('whatsapp_group_broadcast_targets')
      .insert(targetRows);

    if (targetsError) {
      console.error('[POST /api/whatsapp/group-broadcasts] targets insert error:', targetsError);
      await supabase
        .from('whatsapp_group_broadcasts')
        .update({ status: 'failed' })
        .eq('id', broadcast.id);
      return NextResponse.json(
        { error: 'Group broadcast created but failed to schedule targets' },
        { status: 500 }
      );
    }

    // Best-effort: persisting the reusable audience must never fail the
    // campaign that already has its rows written above.
    if (save_audience_as && save_audience_as.trim()) {
      const { data: audienceRow, error: audienceCreateErr } = await supabase
        .from('campaign_audiences')
        .insert({ account_id: accountId, user_id: userId, name: save_audience_as.trim() })
        .select('id')
        .single();

      if (audienceCreateErr || !audienceRow) {
        console.error(
          '[POST /api/whatsapp/group-broadcasts] save_audience_as create error:',
          audienceCreateErr
        );
      } else {
        const memberRows = [
          ...resolved.groupIds.map((groupId) => ({ audience_id: audienceRow.id, group_id: groupId })),
          ...resolved.contacts.map((c) => ({ audience_id: audienceRow.id, contact_id: c.id })),
          ...resolved.phones.map((phone) => ({ audience_id: audienceRow.id, phone })),
        ];
        const { error: memberInsertErr } = await supabase
          .from('campaign_audience_members')
          .insert(memberRows);
        if (memberInsertErr) {
          console.error(
            '[POST /api/whatsapp/group-broadcasts] save_audience_as members error:',
            memberInsertErr
          );
        }
      }
    }

    return NextResponse.json(
      {
        id: broadcast.id,
        total_targets: recipients.length,
        first_send_at: sendTimes[0].toISOString(),
        last_send_at: sendTimes[sendTimes.length - 1].toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
