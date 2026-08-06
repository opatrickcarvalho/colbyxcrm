import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

// POST /api/whatsapp/group-broadcasts/[id]/cancel — stop a campaign
// still in flight. Only pending targets are cancelled; anything the
// cron already claimed (processing) or finished (sent/failed) is left
// alone so we never contradict a send that already happened.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const { data: broadcast, error: broadcastErr } = await supabase
      .from('whatsapp_group_broadcasts')
      .select('id, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (broadcastErr || !broadcast) {
      return NextResponse.json({ error: 'Group broadcast not found' }, { status: 404 });
    }
    if (broadcast.status === 'sent' || broadcast.status === 'failed') {
      return NextResponse.json(
        { error: `Cannot cancel a broadcast that already finished (${broadcast.status})` },
        { status: 400 }
      );
    }

    await supabase
      .from('whatsapp_group_broadcast_targets')
      .update({ status: 'cancelled' })
      .eq('broadcast_id', id)
      .eq('status', 'pending');

    const { data, error } = await supabase
      .from('whatsapp_group_broadcasts')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('[POST /api/whatsapp/group-broadcasts/[id]/cancel] error:', error);
      return NextResponse.json({ error: 'Failed to cancel group broadcast' }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
