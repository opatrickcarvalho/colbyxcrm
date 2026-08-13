import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveEventEffect } from '@/lib/billing/asaas/events';
import { isAsaasConfigured } from '@/lib/billing/asaas/client';
import { listSubscriptionPayments } from '@/lib/billing/asaas/api';
import type {
  AsaasPayment,
  AsaasWebhookEvent,
} from '@/lib/billing/asaas/types';
import {
  applyPaidPayment,
  markEventFailed,
  markEventProcessed,
  markPastDue,
  recordInvoice,
  reversePayment,
  type PaymentContext,
} from '@/lib/billing/store';

const MAX_EVENT_ATTEMPTS = 5;
const STUCK_PENDING_AFTER_MS = 60 * 60 * 1000; // 1 hour

/**
 * GET /api/billing/cron
 *
 * The "hourly sweep" the Asaas webhook route's docstring has promised
 * since it was written (see src/app/api/billing/asaas/webhook/route.ts)
 * but that never actually existed. Two independent passes:
 *
 *   1. Replay `asaas_events` rows the webhook marked 'failed'. Same
 *      effect logic as the webhook itself (src/lib/billing/asaas/events.ts),
 *      run against the payload already stored locally — no Asaas call
 *      needed. Capped at MAX_EVENT_ATTEMPTS so a permanently broken
 *      payload doesn't get retried forever; it just sits `failed` for
 *      a human to look at.
 *
 *   2. Reconcile `account_subscriptions` stuck in `pending` for over an
 *      hour by asking Asaas directly for the subscription's latest
 *      payment. Covers what #1 cannot: a webhook delivery Asaas never
 *      attempted at all (its queue was interrupted, or it silently
 *      dropped the payload) — nothing was ever stored locally for #1
 *      to replay.
 *
 * Auth: reuses AUTOMATION_CRON_SECRET via the `x-cron-secret` header,
 * the exact shape of the other four drains (src/app/api/automations/cron,
 * src/app/api/flows/cron, src/app/api/whatsapp/scheduled-messages/cron,
 * src/app/api/whatsapp/group-broadcasts/cron) — one secret for the
 * operator to configure, not five.
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

  const db = supabaseAdmin();

  const replayed = await replayFailedEvents(db);
  // Reconciliation needs live Asaas API calls — skip it entirely on a
  // deployment that hasn't configured ASAAS_API_KEY rather than let
  // every call fail one by one.
  const reconciled = isAsaasConfigured()
    ? await reconcilePendingSubscriptions(db)
    : { checked: 0, updated: 0 };

  return NextResponse.json({ replayed, reconciled });
}

async function applyEffect(
  db: SupabaseClient,
  effect: 'record_invoice' | 'apply_paid' | 'mark_past_due' | 'reverse',
  ctx: PaymentContext
): Promise<void> {
  switch (effect) {
    case 'record_invoice':
      await recordInvoice(db, ctx);
      break;
    case 'apply_paid':
      await applyPaidPayment(db, ctx);
      break;
    case 'mark_past_due':
      await markPastDue(db, ctx);
      break;
    case 'reverse':
      await reversePayment(db, ctx);
      break;
  }
}

async function replayFailedEvents(db: SupabaseClient): Promise<{
  attempted: number;
  processed: number;
  failed: number;
}> {
  const { data: rows, error } = await db
    .from('asaas_events')
    .select('id, event_type, account_id, payload')
    .eq('status', 'failed')
    .lt('attempts', MAX_EVENT_ATTEMPTS)
    .order('received_at', { ascending: true })
    .limit(50);

  if (error) {
    console.error('[billing/cron] failed-events read error:', error.message);
  }
  if (!rows || rows.length === 0)
    return { attempted: 0, processed: 0, failed: 0 };

  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    const payload = row.payload as AsaasWebhookEvent;
    const accountId = row.account_id as string | null;
    const effect = resolveEventEffect(row.event_type);
    const rowId = row.id as string;

    // Same "never destructive, never throw on the unexpected" posture
    // as the webhook route: an event that still can't be resolved is
    // marked ignored, not retried forever.
    if (effect === 'ignore' || !accountId || !payload?.payment?.id) {
      await markEventProcessed(db, rowId, 'ignored', 'unresolvable_on_replay');
      continue;
    }

    try {
      await applyEffect(db, effect, { accountId, payment: payload.payment });
      await markEventProcessed(db, rowId, 'processed');
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[billing/cron] replay failed:', message);
      await markEventFailed(db, rowId, message);
      failed++;
    }
  }

  return { attempted: rows.length, processed, failed };
}

async function reconcilePendingSubscriptions(db: SupabaseClient): Promise<{
  checked: number;
  updated: number;
}> {
  const cutoff = new Date(Date.now() - STUCK_PENDING_AFTER_MS).toISOString();
  const { data: rows, error } = await db
    .from('account_subscriptions')
    .select('id, account_id, asaas_subscription_id')
    .eq('status', 'pending')
    .not('asaas_subscription_id', 'is', null)
    .lt('created_at', cutoff)
    .limit(50);

  if (error) {
    console.error(
      '[billing/cron] pending-subscriptions read error:',
      error.message
    );
  }
  if (!rows || rows.length === 0) return { checked: 0, updated: 0 };

  let updated = 0;

  for (const row of rows) {
    const subscriptionId = row.asaas_subscription_id as string;
    let payments: AsaasPayment[];
    try {
      payments = await listSubscriptionPayments(subscriptionId, 1);
    } catch (err) {
      console.error('[billing/cron] listSubscriptionPayments failed:', err);
      continue;
    }

    const payment = payments[0];
    if (!payment) continue;

    const ctx: PaymentContext = {
      accountId: row.account_id as string,
      payment,
    };
    try {
      if (
        payment.status === 'CONFIRMED' ||
        payment.status === 'RECEIVED' ||
        payment.status === 'RECEIVED_IN_CASH'
      ) {
        await applyPaidPayment(db, ctx);
        updated++;
      } else if (payment.status === 'OVERDUE') {
        await markPastDue(db, ctx);
        updated++;
      } else {
        // Still pending on Asaas's side too — just refresh the
        // invoice row/URL in case the original create-time fetch
        // (POST /api/billing/subscribe) missed it.
        await recordInvoice(db, ctx);
      }
    } catch (err) {
      console.error('[billing/cron] reconcile subscription failed:', err);
    }
  }

  return { checked: rows.length, updated };
}
