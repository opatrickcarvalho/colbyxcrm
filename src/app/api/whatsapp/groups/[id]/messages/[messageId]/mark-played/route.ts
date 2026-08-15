import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { markMessagesRead } from '@/lib/whatsapp/providers';
import {
  GroupsNotAvailableError,
  resolveGroupCredentials,
} from '@/lib/whatsapp/providers/uazapi-groups';

/**
 * POST /api/whatsapp/groups/[id]/messages/[messageId]/mark-played
 *
 * Group counterpart of `/api/messages/[id]/mark-played` — sends
 * WhatsApp's read receipt for exactly ONE inbound group voice note, at
 * the moment an agent actually presses play on it, same as the 1:1
 * inbox. `whatsapp_group_messages` has no `unread_count`/batch-read
 * concept to exclude audio from (see migration 043 — groups are an
 * activity feed, not an attendance queue), so this is the only thing
 * that ever sends a receipt for a group message.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id: groupId, messageId } = await params;

    const { data: group, error: groupErr } = await supabase
      .from('whatsapp_groups')
      .select('id')
      .eq('id', groupId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (groupErr || !group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    const { data: message, error } = await supabase
      .from('whatsapp_group_messages')
      .select('provider_message_id, content_type, direction')
      .eq('id', messageId)
      .eq('group_id', groupId)
      .maybeSingle();

    if (error) {
      console.error('[groups/mark-played] fetch failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (
      !message ||
      message.content_type !== 'audio' ||
      message.direction !== 'inbound' ||
      !message.provider_message_id
    ) {
      return NextResponse.json({ ok: true, marked: false });
    }

    const { host, token } = await resolveGroupCredentials(supabase, accountId);
    await markMessagesRead(host, token, [message.provider_message_id]);

    return NextResponse.json({ ok: true, marked: true });
  } catch (error) {
    if (error instanceof GroupsNotAvailableError) {
      return NextResponse.json({ ok: true, marked: false, unavailable: true });
    }
    return toErrorResponse(error);
  }
}
