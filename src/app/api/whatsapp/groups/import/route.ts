import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  GroupsNotAvailableError,
  getGroupInfo,
  resolveGroupCredentials,
} from '@/lib/whatsapp/providers/uazapi-groups';

/**
 * POST /api/whatsapp/groups/import
 *
 * Starts tracking a WhatsApp group the number already belongs to
 * (picked from GET /api/whatsapp/groups/available) — the counterpart to
 * `POST /api/whatsapp/groups`, which only ever creates a brand-new
 * group. No `createGroup` call here: the group already exists on
 * WhatsApp, this just mirrors it locally so it starts appearing in the
 * Groups tab and its inbound messages stop being dropped by the webhook
 * (which only stores messages for groups it already recognises).
 *
 * Re-picking a group that was previously hidden (`status: 'archived'`,
 * via PATCH .../[id]) just flips it back to `active` rather than
 * re-fetching + re-inserting.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`groupManage:${userId}`, RATE_LIMITS.groupManage);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const group_jid = (body as { group_jid?: string } | null)?.group_jid;
    if (!group_jid) {
      return NextResponse.json({ error: 'group_jid is required' }, { status: 400 });
    }

    let creds;
    try {
      creds = await resolveGroupCredentials(supabase, accountId);
    } catch (err) {
      if (err instanceof GroupsNotAvailableError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    const { data: existing } = await supabase
      .from('whatsapp_groups')
      .select('*')
      .eq('account_id', accountId)
      .eq('group_jid', group_jid)
      .maybeSingle();

    if (existing) {
      if (existing.status === 'active') {
        return NextResponse.json({ data: existing });
      }
      const { data, error } = await supabase
        .from('whatsapp_groups')
        .update({ status: 'active' })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) {
        console.error('[POST /api/whatsapp/groups/import] re-enable error:', error);
        return NextResponse.json(
          { error: 'Failed to re-enable the group locally.' },
          { status: 500 }
        );
      }
      return NextResponse.json({ data });
    }

    let live;
    try {
      live = await getGroupInfo(creds.host, creds.token, group_jid);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown provider error';
      console.error('[POST /api/whatsapp/groups/import] getGroupInfo failed:', message);
      return NextResponse.json({ error: `WhatsApp API error: ${message}` }, { status: 502 });
    }

    const { data, error } = await supabase
      .from('whatsapp_groups')
      .insert({
        account_id: accountId,
        whatsapp_config_id: creds.configId,
        group_jid,
        name: live.name || group_jid,
        description: live.description || null,
        invite_link: live.inviteLink || null,
        participant_count: live.participantCount,
        is_announce: live.isAnnounce,
        is_locked: live.isLocked,
        created_by: userId,
      })
      .select()
      .single();

    if (error) {
      console.error('[POST /api/whatsapp/groups/import] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to save the group locally.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
