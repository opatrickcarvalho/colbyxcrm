import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

// POST /api/whatsapp/group-broadcasts/[id]/targets/remove
//
// Drop one or more recipients from a campaign that's already been
// created, without touching the rows around them. Body: { target_ids }.
//
// Only 'pending' rows are ever touched — the same restriction /cancel
// already applies to the whole campaign, scoped here to specific rows:
// a target that already sent, failed, or is mid-send ('processing')
// is a historical record of something that actually happened, and
// deleting or relabelling it would falsify `sent_count`/`failed_count`
// and the "what did we actually send" audit trail. Marked 'cancelled'
// (the same status /cancel already uses), not hard-deleted, so it's
// still visible in the campaign's target list as "removed" rather than
// silently vanishing.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const body = await request.json().catch(() => null);
    const targetIds = Array.isArray(body?.target_ids)
      ? body.target_ids.filter((v: unknown): v is string => typeof v === 'string')
      : [];
    if (targetIds.length === 0) {
      return NextResponse.json({ error: 'target_ids is required' }, { status: 400 });
    }

    const { data: broadcast, error: broadcastErr } = await supabase
      .from('whatsapp_group_broadcasts')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (broadcastErr || !broadcast) {
      return NextResponse.json({ error: 'Group broadcast not found' }, { status: 404 });
    }

    const { data, error } = await supabase
      .from('whatsapp_group_broadcast_targets')
      .update({ status: 'cancelled' })
      .eq('broadcast_id', id)
      .eq('status', 'pending')
      .in('id', targetIds)
      .select('id');

    if (error) {
      console.error(
        '[POST /api/whatsapp/group-broadcasts/[id]/targets/remove] error:',
        error
      );
      return NextResponse.json({ error: 'Failed to remove targets' }, { status: 500 });
    }

    return NextResponse.json({ removed: data?.length ?? 0 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
