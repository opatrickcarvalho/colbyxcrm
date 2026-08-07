import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

/**
 * PATCH /api/conversations/[id]/mark-unread
 *
 * WhatsApp's "mark as unread" — no dedicated flag exists (or is
 * needed): `conversations.unread_count` already drives both the
 * numeric badge and gets zeroed client-side when a conversation opens
 * (message-thread.tsx). Bumping it back to at least 1 reproduces the
 * same "green dot" behavior without a schema change.
 *
 * RLS on `conversations` (is_account_member) is what actually scopes
 * this to the caller's account — the explicit `.eq('id', ...)` below
 * just narrows to the one row the request asked for.
 */
export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: conversationId } = await params;

    const { data: conversation, error: fetchError } = await ctx.supabase
      .from('conversations')
      .select('id, unread_count')
      .eq('id', conversationId)
      .maybeSingle();

    if (fetchError) {
      console.error('[mark-unread] fetch failed:', fetchError.message);
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    if ((conversation.unread_count ?? 0) < 1) {
      const { error: updateError } = await ctx.supabase
        .from('conversations')
        .update({ unread_count: 1 })
        .eq('id', conversationId);

      if (updateError) {
        console.error('[mark-unread] update failed:', updateError.message);
        return NextResponse.json(
          { error: updateError.message },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
