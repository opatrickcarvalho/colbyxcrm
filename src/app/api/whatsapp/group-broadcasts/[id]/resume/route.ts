import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { planSendTimes, type SendWindow } from '@/lib/campaigns/schedule';

// POST /api/whatsapp/group-broadcasts/[id]/resume — hand a paused
// campaign back to the cron drain.
//
// Just flipping the status back would not be enough: every still-
// pending target already has a `send_at` computed once, at creation
// time, by planSendTimes() — that's what gives the campaign its
// pacing (delay_seconds jittered by delay_jitter_pct, respecting the
// sending window). Those timestamps are all in the past by the time
// an operator resumes, so the cron's `send_at <= now()` query would
// treat every one of them as equally overdue and drain up to 50 in a
// single tick — the exact "byte-identical burst" pattern the pacing
// exists to avoid. So resume re-plans send_at for whatever is still
// 'pending', starting from now, with the same delay/jitter/window the
// campaign was created with — the remaining targets get a fresh,
// paced schedule instead of firing all at once.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const { data: broadcast, error: broadcastErr } = await supabase
      .from('whatsapp_group_broadcasts')
      .select(
        'id, status, sent_count, delay_seconds, delay_jitter_pct, window_start, window_end, window_days, timezone'
      )
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (broadcastErr || !broadcast) {
      return NextResponse.json({ error: 'Group broadcast not found' }, { status: 404 });
    }
    if (broadcast.status !== 'paused') {
      return NextResponse.json(
        { error: `Cannot resume a campaign that is ${broadcast.status}` },
        { status: 400 }
      );
    }

    // Ordered by the original send_at so the relative queue order
    // (e.g. "select all matching" order at creation) is preserved —
    // only the absolute timestamps move, not who goes first.
    const { data: pending, error: pendingErr } = await supabase
      .from('whatsapp_group_broadcast_targets')
      .select('id')
      .eq('broadcast_id', id)
      .eq('status', 'pending')
      .order('send_at', { ascending: true });

    if (pendingErr) {
      console.error('[POST /api/whatsapp/group-broadcasts/[id]/resume] targets fetch error:', pendingErr);
      return NextResponse.json({ error: 'Failed to load pending targets' }, { status: 500 });
    }

    if (pending && pending.length > 0) {
      const window: SendWindow | null =
        broadcast.window_start && broadcast.window_end
          ? {
              // Postgres TIME round-trips as 'HH:MM:SS'; the planner's
              // parser wants 'HH:MM' — same trim the cron route does.
              start: (broadcast.window_start as string).slice(0, 5),
              end: (broadcast.window_end as string).slice(0, 5),
              days: (broadcast.window_days as number[] | null) ?? [1, 2, 3, 4, 5, 6, 7],
              timeZone: (broadcast.timezone as string) || 'America/Sao_Paulo',
            }
          : null;

      let sendTimes: Date[];
      try {
        sendTimes = planSendTimes({
          count: pending.length,
          startAt: new Date(),
          delaySeconds: broadcast.delay_seconds as number,
          jitterPct: broadcast.delay_jitter_pct as number,
          window,
        });
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'Failed to re-plan send times' },
          { status: 400 }
        );
      }

      // One UPDATE per row — Postgres has no portable "zip this array
      // of ids to this array of values" bulk-update via supabase-js,
      // and campaign sizes here (low thousands at most, per the
      // audience picker's own SELECT_ALL_CAP) make row-at-a-time fine.
      for (let i = 0; i < pending.length; i++) {
        const { error: updErr } = await supabase
          .from('whatsapp_group_broadcast_targets')
          .update({ send_at: sendTimes[i].toISOString() })
          .eq('id', pending[i].id);
        if (updErr) {
          console.error(
            '[POST /api/whatsapp/group-broadcasts/[id]/resume] target reschedule error:',
            updErr
          );
        }
      }
    }

    const { data, error } = await supabase
      .from('whatsapp_group_broadcasts')
      .update({
        // Mirrors the cron's own convention: 'sending' once at least
        // one target has gone out, 'pending' if resuming before any
        // did (e.g. paused immediately after creation).
        status: (broadcast.sent_count ?? 0) > 0 ? 'sending' : 'pending',
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('[POST /api/whatsapp/group-broadcasts/[id]/resume] error:', error);
      return NextResponse.json({ error: 'Failed to resume group broadcast' }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
