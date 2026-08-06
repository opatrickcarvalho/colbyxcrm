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

// Dashboard CRUD for whatsapp_group_broadcasts. The actual send happens
// later, out-of-band, via the cron drain route
// (src/app/api/whatsapp/group-broadcasts/cron/route.ts) — this route
// only ever persists a campaign row plus one target row per group,
// each pre-staggered by the configured delay. Deliberately a parallel
// system to src/app/api/whatsapp/broadcast (Meta/contact templates) —
// not built on top of it.
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
      group_ids,
      delay_seconds,
      scheduled_at,
    } = body as {
      name?: string;
      content_type?: string;
      content_text?: string | null;
      media_url?: string | null;
      filename?: string | null;
      group_ids?: string[];
      delay_seconds?: number;
      scheduled_at?: string;
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
    if (!Array.isArray(group_ids) || group_ids.length === 0) {
      return NextResponse.json(
        { error: 'group_ids must be a non-empty array' },
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
    // see src/lib/whatsapp/providers/capabilities.ts). This is the one
    // gate that makes the whole feature UAZAPI-only.
    let creds;
    try {
      creds = await resolveGroupCredentials(supabase, accountId);
    } catch (err) {
      if (err instanceof GroupsNotAvailableError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    // Scope + validate every target group belongs to this account and
    // is still active, instead of silently dropping bad ids.
    const { data: groups, error: groupsError } = await supabase
      .from('whatsapp_groups')
      .select('id, status')
      .eq('account_id', accountId)
      .in('id', group_ids);

    if (groupsError) {
      console.error('[POST /api/whatsapp/group-broadcasts] groups lookup error:', groupsError);
      return NextResponse.json({ error: 'Failed to validate groups' }, { status: 500 });
    }

    const foundIds = new Set((groups ?? []).map((g) => g.id));
    const missing = group_ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Groups not found in this account: ${missing.join(', ')}` },
        { status: 400 }
      );
    }
    const inactive = (groups ?? []).filter((g) => g.status !== 'active').map((g) => g.id);
    if (inactive.length > 0) {
      return NextResponse.json(
        { error: `Groups are archived and cannot receive a broadcast: ${inactive.join(', ')}` },
        { status: 400 }
      );
    }

    const resolvedDelaySeconds =
      delay_seconds ?? (await resolveGroupBroadcastDelaySeconds(supabase, accountId));

    let scheduledDate: Date | undefined;
    if (scheduled_at) {
      scheduledDate = new Date(scheduled_at);
      if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
        return NextResponse.json(
          { error: 'scheduled_at must be a valid future date/time' },
          { status: 400 }
        );
      }
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
        status: 'pending',
        total_targets: group_ids.length,
        scheduled_at: scheduledDate?.toISOString() ?? null,
      })
      .select()
      .single();

    if (insertError || !broadcast) {
      console.error('[POST /api/whatsapp/group-broadcasts] insert error:', insertError);
      return NextResponse.json({ error: 'Failed to create group broadcast' }, { status: 500 });
    }

    const base = scheduledDate ?? new Date();
    const targets = group_ids.map((groupId, index) => ({
      broadcast_id: broadcast.id,
      group_id: groupId,
      send_at: new Date(base.getTime() + index * resolvedDelaySeconds * 1000).toISOString(),
      status: 'pending' as const,
    }));

    const { error: targetsError } = await supabase
      .from('whatsapp_group_broadcast_targets')
      .insert(targets);

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

    return NextResponse.json({ data: broadcast }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
