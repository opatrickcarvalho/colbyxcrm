import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  LabelsNotAvailableError,
  resolveLabelCredentials,
} from '@/lib/whatsapp/label-write';
import { markMessagesRead } from '@/lib/whatsapp/providers';

/** WhatsApp only accepts a bounded batch; newest messages matter most. */
const MAX_BATCH = 50;

/**
 * POST /api/conversations/[id]/read
 *
 * Sends the READ RECEIPT for a conversation's inbound messages — the
 * thing that actually turns the customer's ticks blue on their phone.
 *
 * Opening a thread in the inbox previously only zeroed
 * `conversations.unread_count`, which is CRM-local bookkeeping that
 * WhatsApp never sees. That is why the CRM never sent a read receipt:
 * nothing ever told WhatsApp the message had been read.
 *
 * Only `customer` messages are marked — marking our own outbound
 * messages read is meaningless and WhatsApp rejects it.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: conversationId } = await params;

    // RLS on `messages` (via conversations) is what scopes this to the
    // caller's account; the filters below just narrow to the rows that
    // are actually receipt-eligible.
    const { data: rows, error } = await ctx.supabase
      .from('messages')
      .select('message_id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .not('message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(MAX_BATCH);

    if (error) {
      console.error('[conversations/read] fetch failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const ids = (rows ?? [])
      .map((r) => r.message_id as string | null)
      .filter((id): id is string => Boolean(id));

    if (ids.length === 0) {
      return NextResponse.json({ ok: true, marked: 0 });
    }

    const { host, token } = await resolveLabelCredentials(
      ctx.supabase,
      ctx.accountId
    );
    await markMessagesRead(host, token, ids);

    return NextResponse.json({ ok: true, marked: ids.length });
  } catch (error) {
    // Not on UAZAPI (or not connected) is not an error worth surfacing
    // to the inbox — read receipts simply aren't available there.
    if (error instanceof LabelsNotAvailableError) {
      return NextResponse.json({ ok: true, marked: 0, unavailable: true });
    }
    return toErrorResponse(error);
  }
}
