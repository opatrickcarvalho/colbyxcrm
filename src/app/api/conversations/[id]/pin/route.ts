import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

const MAX_PINS_PER_USER = 3;

/**
 * POST /api/conversations/[id]/pin
 *
 * Personal pin — mirrors WhatsApp's own "pin chat" (max 3), but
 * scoped per agent (user_id) rather than per WhatsApp number, since
 * several agents can share one inbox here. The cap is enforced here
 * rather than as a DB constraint so a full pin list returns a
 * friendly 409 instead of a raw unique/check violation.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: conversationId } = await params;

    const { count, error: countError } = await ctx.supabase
      .from('conversation_pins')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', ctx.userId);

    if (countError) {
      console.error('[pin] count failed:', countError.message);
      return NextResponse.json({ error: countError.message }, { status: 500 });
    }
    if ((count ?? 0) >= MAX_PINS_PER_USER) {
      return NextResponse.json(
        { error: `You can only pin up to ${MAX_PINS_PER_USER} conversations` },
        { status: 409 }
      );
    }

    const { error: insertError } = await ctx.supabase
      .from('conversation_pins')
      .insert({
        conversation_id: conversationId,
        account_id: ctx.accountId,
        user_id: ctx.userId,
      });

    // Already pinned (unique violation) is not an error from the
    // caller's point of view — the end state they asked for already
    // holds.
    if (insertError && insertError.code !== '23505') {
      console.error('[pin] insert failed:', insertError.message);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: conversationId } = await params;

    const { error } = await ctx.supabase
      .from('conversation_pins')
      .delete()
      .eq('conversation_id', conversationId)
      .eq('user_id', ctx.userId);

    if (error) {
      console.error('[pin] delete failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
