import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  updateGroupParticipants,
  resolveGroupCredentials,
  GroupsNotAvailableError,
  type GroupParticipantAction,
} from '@/lib/whatsapp/providers/uazapi-groups';

const VALID_ACTIONS = new Set<GroupParticipantAction>([
  'add',
  'remove',
  'promote',
  'demote',
]);

// POST /api/whatsapp/groups/[id]/participants
// Body: { action: 'add'|'remove'|'promote'|'demote', participants: string[] }
export async function POST(
  request: Request,
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

    const body = await request.json().catch(() => null);
    const { action, participants } = (body ?? {}) as {
      action?: string;
      participants?: string[];
    };

    if (!action || !VALID_ACTIONS.has(action as GroupParticipantAction)) {
      return NextResponse.json(
        { error: 'action must be one of add, remove, promote, demote' },
        { status: 400 }
      );
    }
    if (!Array.isArray(participants) || participants.length === 0) {
      return NextResponse.json(
        { error: 'participants must be a non-empty array' },
        { status: 400 }
      );
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

    let result;
    try {
      result = await updateGroupParticipants(creds.host, creds.token, {
        groupjid: localGroup.group_jid,
        participants,
        action: action as GroupParticipantAction,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown provider error';
      console.error(
        '[POST /api/whatsapp/groups/[id]/participants] uazapi call failed:',
        message
      );
      return NextResponse.json({ error: `WhatsApp API error: ${message}` }, { status: 502 });
    }

    // Best-effort local mirror — the WhatsApp-side mutation already
    // happened regardless of whether this write succeeds, so failures
    // here are logged, not surfaced as the action having failed.
    const { error: updateErr } = await supabase
      .from('whatsapp_groups')
      .update({ participant_count: result.group.participantCount })
      .eq('id', id)
      .eq('account_id', accountId);
    if (updateErr) {
      console.error(
        '[POST /api/whatsapp/groups/[id]/participants] local mirror failed:',
        updateErr.message
      );
    }

    return NextResponse.json({
      results: result.results,
      participant_count: result.group.participantCount,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
