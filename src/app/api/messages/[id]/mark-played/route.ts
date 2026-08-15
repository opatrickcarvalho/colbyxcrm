import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  LabelsNotAvailableError,
  resolveLabelCredentials,
} from '@/lib/whatsapp/label-write';
import { markMessagesRead } from '@/lib/whatsapp/providers';

/**
 * POST /api/messages/[id]/mark-played
 *
 * Sends WhatsApp's read receipt for exactly ONE inbound voice note, at
 * the moment the agent actually presses play on it — not the instant
 * the conversation is opened.
 *
 * Real WhatsApp clients hold a voice note's blue tick back until it is
 * actually played, unlike ordinary text which reads as soon as the
 * chat is opened. `/api/conversations/[id]/read` mirrors that by
 * excluding `content_type = 'audio'` from its batch, which makes this
 * route the only thing that ever marks a voice note read — wired to
 * the audio player's first play, in `MediaAudioBubble`.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: messageId } = await params;

    // RLS on `messages` (via conversations) scopes this to the caller's
    // account; the checks below just narrow to a row this call actually
    // makes sense for — a customer's own voice note, not our reply.
    const { data: message, error } = await ctx.supabase
      .from('messages')
      .select('message_id, content_type, sender_type')
      .eq('id', messageId)
      .maybeSingle();

    if (error) {
      console.error('[messages/mark-played] fetch failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (
      !message ||
      message.content_type !== 'audio' ||
      message.sender_type !== 'customer' ||
      !message.message_id
    ) {
      return NextResponse.json({ ok: true, marked: false });
    }

    const { host, token } = await resolveLabelCredentials(
      ctx.supabase,
      ctx.accountId
    );
    await markMessagesRead(host, token, [message.message_id]);

    return NextResponse.json({ ok: true, marked: true });
  } catch (error) {
    // Not on UAZAPI (or not connected) is not an error worth surfacing —
    // read receipts simply aren't available there.
    if (error instanceof LabelsNotAvailableError) {
      return NextResponse.json({ ok: true, marked: false, unavailable: true });
    }
    return toErrorResponse(error);
  }
}
