import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

// GET /api/whatsapp/group-broadcasts/[id] — campaign detail + its
// per-group targets, for the campaign progress screen.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const { data: broadcast, error: broadcastErr } = await supabase
      .from('whatsapp_group_broadcasts')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (broadcastErr || !broadcast) {
      return NextResponse.json({ error: 'Group broadcast not found' }, { status: 404 });
    }

    const { data: targets, error: targetsErr } = await supabase
      .from('whatsapp_group_broadcast_targets')
      .select('*, group:whatsapp_groups(id, name)')
      .eq('broadcast_id', id)
      .order('send_at', { ascending: true });

    if (targetsErr) {
      console.error('[GET /api/whatsapp/group-broadcasts/[id]] targets error:', targetsErr);
      return NextResponse.json({ error: 'Failed to load targets' }, { status: 500 });
    }

    return NextResponse.json({ data: { ...broadcast, targets: targets ?? [] } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
