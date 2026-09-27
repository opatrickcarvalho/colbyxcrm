import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { resumePendingExecution } from '@/lib/automations/engine';
import type { AutomationContext } from '@/lib/automations/engine';

/** How far past run_at a pending execution may still run. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();

  // Never run a wait step that's long overdue. After an outage (cron
  // not firing, app down, Supabase auth/PostgREST trouble) every
  // parked run whose timer expired meanwhile would otherwise fire at
  // once when the drain comes back — a burst of late WhatsApp messages
  // that reads as spam and risks getting the number banned. Anything
  // more than STALE_AFTER_MS past its run_at is discarded instead
  // (status 'failed' — the CHECK constraint has no 'expired' value —
  // plus a log entry saying why). The cron ticks every minute, so
  // normal lateness is seconds; this only trips after a real outage.
  const staleCutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data: discarded } = await admin
    .from('automation_pending_executions')
    .update({ status: 'failed' })
    .eq('status', 'pending')
    .lt('run_at', staleCutoff)
    .select('id, log_id');
  const discardedCount = discarded?.length ?? 0;
  if (discardedCount > 0) {
    console.warn(
      `[automations-cron] discarded ${discardedCount} overdue pending execution(s) (> ${STALE_AFTER_MS / 60000} min late)`
    );
    const logIds = discarded!
      .map((r) => r.log_id as string | null)
      .filter((id): id is string => !!id);
    if (logIds.length > 0) {
      await admin
        .from('automation_logs')
        .update({
          status: 'failed',
          error_message: `Execução descartada: passou mais de ${STALE_AFTER_MS / 60000} minutos do horário previsto (evita disparo em massa de mensagens atrasadas).`,
        })
        .in('id', logIds);
    }
  }

  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  if (!due || due.length === 0)
    return NextResponse.json({ processed: 0, discarded: discardedCount });

  let processed = 0;
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (!claim) continue;

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    });
    processed++;
  }

  return NextResponse.json({ processed, discarded: discardedCount });
}
