import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  resetGroupInviteCode,
  resolveGroupCredentials,
  GroupsNotAvailableError,
} from '@/lib/whatsapp/providers/uazapi-groups';

// POST /api/whatsapp/groups/[id]/invite-link — rotate the invite link.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { id } = await params;

    const limit = checkRateLimit(`groupManage:${userId}`, RATE_LIMITS.groupManage);
    if (!limit.success) return rateLimitResponse(limit);

    const { data: localGroup, error: fetchError } = await supabase
      .from('whatsapp_groups')
      .select('id, group_jid')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (fetchError || !localGroup) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
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

    let reset;
    try {
      reset = await resetGroupInviteCode(creds.host, creds.token, localGroup.group_jid);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown provider error';
      console.error(
        '[POST /api/whatsapp/groups/[id]/invite-link] uazapi call failed:',
        message
      );
      return NextResponse.json({ error: `WhatsApp API error: ${message}` }, { status: 502 });
    }

    const { error } = await supabase
      .from('whatsapp_groups')
      .update({ invite_link: reset.inviteLink || null })
      .eq('id', id)
      .eq('account_id', accountId);

    if (error) {
      console.error('[POST /api/whatsapp/groups/[id]/invite-link] update error:', error);
      return NextResponse.json(
        { error: 'Invite link was reset on WhatsApp but saving locally failed.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ invite_link: reset.inviteLink });
  } catch (error) {
    return toErrorResponse(error);
  }
}
