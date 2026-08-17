import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

// POST /api/whatsapp/group-broadcasts/[id]/pause — stop claiming new
// targets for a campaign still in flight, without touching any of
// them. A target already 'processing' when this lands finishes
// normally (the cron only skips the CLAIM step for a paused campaign,
// see its status gate); everything still 'pending' just sits there
// until /resume re-plans it. Unlike /cancel, nothing here is
// terminal — see resume/route.ts for the reverse.
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
    if (broadcast.status !== 'pending' && broadcast.status !== 'sending') {
      return NextResponse.json(
        { error: `Cannot pause a campaign that is ${broadcast.status}` },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('whatsapp_group_broadcasts')
      .update({ status: 'paused' })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('[POST /api/whatsapp/group-broadcasts/[id]/pause] error:', error);
      return NextResponse.json({ error: 'Failed to pause group broadcast' }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
