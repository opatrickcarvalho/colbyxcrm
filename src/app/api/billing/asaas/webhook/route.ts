import { timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveEventEffect } from '@/lib/billing/asaas/events';
import type { AsaasWebhookEvent } from '@/lib/billing/asaas/types';
import {
  applyPaidPayment,
  markEventFailed,
  markEventProcessed,
  markPastDue,
  recordAsaasEvent,
  recordInvoice,
  resolveAccountForPayment,
  reversePayment,
} from '@/lib/billing/store';

/**
 * POST /api/billing/asaas/webhook
 *
 * Where Asaas tells us money moved. This is the ONLY thing in the
 * product that grants entitlement.
 *
 * Auth
 * ----
 * The `asaas-access-token` header, compared in constant time against
 * ASAAS_WEBHOOK_TOKEN — the same shape as the four cron drains. This
 * route sits outside `/api/whatsapp/`, so middleware never touches it
 * and it must guard itself.
 *
 * Why it answers 200 even when processing fails
 * ---------------------------------------------
 * Asaas pauses the ENTIRE webhook queue after 15 consecutive non-2xx
 * responses, and undelivered events are deleted after 14 days. A
 * database blip during a Friday deploy would therefore freeze billing
 * for every tenant, silently, and then start dropping payments.
 *
 * The raw payload is stored in `asaas_events` BEFORE any business
 * logic runs, so a failure loses nothing: the row is marked `failed`
 * and the hourly sweep re-drives it. We trade "Asaas retries for us"
 * for "we retry ourselves", which is strictly better because we
 * control the retry budget.
 *
 * The one exception is 401. A misconfigured token SHOULD trip the
 * queue-pause alarm — that is a deployment error someone must see.
 *
 * Idempotency
 * -----------
 * Delivery is at-least-once, so duplicates are routine traffic.
 * `asaas_events.event_id` UNIQUE catches redelivery of the same
 * event; `subscription_payments.period_end IS NULL` catches the
 * distinct-but-equivalent PAYMENT_CONFIRMED / PAYMENT_RECEIVED pair
 * for one payment. See src/lib/billing/store.ts.
 */
export async function POST(request: Request) {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!expected) {
    // Same posture as the cron drains: unconfigured is 503, not 500.
    return NextResponse.json(
      { error: 'billing not configured' },
      { status: 503 }
    );
  }

  const supplied = request.headers.get('asaas-access-token') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let event: AsaasWebhookEvent;
  try {
    event = (await request.json()) as AsaasWebhookEvent;
  } catch {
    // A body we cannot parse will not parse on retry either.
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!event || typeof event.event !== 'string') {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const db = supabaseAdmin();

  // Resolve the tenant first so the stored event carries it even when
  // processing later fails — that's what makes a `failed` row
  // investigable.
  let accountId: string | null = null;
  try {
    accountId = await resolveAccountForPayment(db, event.payment);
  } catch (err) {
    console.error('[billing/webhook] account resolution error:', err);
  }

  const recorded = await recordAsaasEvent(db, event, accountId);

  if (!recorded) {
    // Could not even store the payload. This is the one internal
    // failure we cannot paper over, because nothing was persisted and
    // the sweep would have nothing to replay. Ask Asaas to retry.
    return NextResponse.json({ error: 'Storage failure' }, { status: 500 });
  }

  if (recorded.duplicate) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const effect = resolveEventEffect(event.event);

  if (effect === 'ignore') {
    await markEventProcessed(db, recorded.id, 'ignored', 'unhandled_event');
    return NextResponse.json({ ok: true, ignored: 'unhandled_event' });
  }

  if (!accountId || !event.payment?.id) {
    // Unmappable to a tenant. Recorded with the full payload so a
    // human can work out why; never an error, because retrying will
    // produce exactly the same result.
    await markEventProcessed(db, recorded.id, 'ignored', 'unknown_account');
    return NextResponse.json({ ok: true, ignored: 'unknown_account' });
  }

  try {
    const ctx = { accountId, payment: event.payment };
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
    await markEventProcessed(db, recorded.id, 'processed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[billing/webhook] processing error:', message);
    await markEventFailed(db, recorded.id, message);
    // Deliberately still 200 — see the header comment. The payload is
    // durable and /api/billing/cron will replay it within the hour.
    return NextResponse.json({ ok: true, deferred: true });
  }

  return NextResponse.json({ ok: true });
}
