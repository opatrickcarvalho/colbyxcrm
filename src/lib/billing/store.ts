// ============================================================
// Billing mutations. SERVICE ROLE ONLY.
//
// Every write in this file runs on `supabaseAdmin()`, because the
// authoritative writer is the Asaas webhook — an unauthenticated
// request with no session and therefore no `auth.uid()` for RLS to
// key off. That is also why none of the billing tables have write
// policies: there is no signed-in user who should ever be able to
// move their own `plan_expires_at`.
//
// Two idempotency layers, and they guard different things:
//
//   OUTER — `asaas_events.event_id` UNIQUE. Asaas delivers AT LEAST
//   ONCE, so the same evt_… arrives more than once as a matter of
//   routine. Handled by `recordAsaasEvent`.
//
//   INNER — `subscription_payments.period_end IS NULL`. Asaas fires
//   PAYMENT_CONFIRMED *and* PAYMENT_RECEIVED for the SAME payment.id
//   (provider accepted / funds landed). Those are two distinct
//   events with two distinct ids, so the outer key does not catch
//   them. Without the inner guard a single payment would buy two
//   cycles. Handled by `applyPaidPayment`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { toCents } from './asaas/api';
import type { AsaasPayment, AsaasWebhookEvent } from './asaas/types';
import { computeNewExpiry } from './expiry';
import { invalidateEntitlement } from './guard';

// ------------------------------------------------------------
// Event log / outer idempotency
// ------------------------------------------------------------

export interface RecordedEvent {
  id: string;
  /** True when this evt_… was already stored — do nothing further. */
  duplicate: boolean;
}

/**
 * Store the raw payload BEFORE processing it.
 *
 * Order matters: because the payload is durable before we touch any
 * business state, the webhook route can answer 200 even when
 * processing blows up, and the hourly sweep re-drives the `failed`
 * row. That is what makes the always-2xx policy safe — and the
 * always-2xx policy is what stops 15 consecutive failures from
 * INTERRUPTING the entire Asaas queue (after which events are
 * dropped for good in 14 days).
 */
export async function recordAsaasEvent(
  db: SupabaseClient,
  event: AsaasWebhookEvent,
  accountId: string | null
): Promise<RecordedEvent | null> {
  // Asaas has always sent an event id; if a delivery ever lacks one
  // we synthesise a stable key from the payment and event type so
  // two deliveries of the same fact still collide.
  const eventId =
    typeof event.id === 'string' && event.id
      ? event.id
      : `synthetic:${event.event}:${event.payment?.id ?? 'unknown'}`;

  const { data, error } = await db
    .from('asaas_events')
    .insert({
      event_id: eventId,
      event_type: String(event.event ?? 'unknown'),
      asaas_payment_id: event.payment?.id ?? null,
      asaas_subscription_id: event.payment?.subscription ?? null,
      account_id: accountId,
      payload: event,
    })
    .select('id')
    .maybeSingle();

  if (error) {
    // 23505 = unique_violation on idx_asaas_events_event_id. This is
    // NORMAL traffic under at-least-once delivery, not an error.
    if (error.code === '23505') return { id: '', duplicate: true };
    console.error('[billing/store] recordAsaasEvent error:', error.message);
    return null;
  }

  return { id: (data?.id as string) ?? '', duplicate: false };
}

export async function markEventProcessed(
  db: SupabaseClient,
  eventRowId: string,
  status: 'processed' | 'ignored',
  note?: string
): Promise<void> {
  if (!eventRowId) return;
  await db
    .from('asaas_events')
    .update({
      status,
      processed_at: new Date().toISOString(),
      error: note ?? null,
    })
    .eq('id', eventRowId);
}

export async function markEventFailed(
  db: SupabaseClient,
  eventRowId: string,
  message: string
): Promise<void> {
  if (!eventRowId) return;
  // Read-modify-write on `attempts` rather than an RPC: this runs at
  // most a handful of times per event and a lost increment only
  // means one extra replay.
  const { data } = await db
    .from('asaas_events')
    .select('attempts')
    .eq('id', eventRowId)
    .maybeSingle();

  await db
    .from('asaas_events')
    .update({
      status: 'failed',
      attempts: ((data?.attempts as number) ?? 0) + 1,
      error: message.slice(0, 1000),
    })
    .eq('id', eventRowId);
}

// ------------------------------------------------------------
// Account resolution
// ------------------------------------------------------------

/**
 * Work out which tenant a payment belongs to.
 *
 * Three routes, in order of reliability:
 *   1. `externalReference` — we set it to `accounts.id` when the
 *      subscription is created, so this is a direct answer.
 *   2. the local subscription row, keyed by Asaas subscription id.
 *   3. `accounts.asaas_customer_id`.
 *
 * Returns null when all three miss. The caller records the event as
 * `ignored` with reason `unknown_account` and answers 200 — never
 * throws. An unmappable event is a data question for a human, not a
 * reason to fail a delivery and march toward a queue interruption.
 */
export async function resolveAccountForPayment(
  db: SupabaseClient,
  payment: AsaasPayment | undefined
): Promise<string | null> {
  if (!payment) return null;

  const ref = payment.externalReference;
  if (typeof ref === 'string' && /^[0-9a-f-]{36}$/i.test(ref)) {
    const { data } = await db
      .from('accounts')
      .select('id')
      .eq('id', ref)
      .maybeSingle();
    if (data?.id) return data.id as string;
  }

  if (payment.subscription) {
    const { data } = await db
      .from('account_subscriptions')
      .select('account_id')
      .eq('asaas_subscription_id', payment.subscription)
      .maybeSingle();
    if (data?.account_id) return data.account_id as string;
  }

  if (payment.customer) {
    const { data } = await db
      .from('accounts')
      .select('id')
      .eq('asaas_customer_id', payment.customer)
      .maybeSingle();
    if (data?.id) return data.id as string;
  }

  return null;
}

async function findSubscriptionRow(
  db: SupabaseClient,
  accountId: string,
  asaasSubscriptionId: string | null | undefined
): Promise<{ id: string; cycle: string } | null> {
  if (asaasSubscriptionId) {
    const { data } = await db
      .from('account_subscriptions')
      .select('id, cycle')
      .eq('asaas_subscription_id', asaasSubscriptionId)
      .maybeSingle();
    if (data) return { id: data.id as string, cycle: data.cycle as string };
  }

  // Fall back to the account's live subscription — covers a payment
  // that arrives before we managed to store the Asaas id.
  const { data } = await db
    .from('account_subscriptions')
    .select('id, cycle')
    .eq('account_id', accountId)
    .in('status', ['pending', 'active', 'past_due'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data ? { id: data.id as string, cycle: data.cycle as string } : null;
}

// ------------------------------------------------------------
// Payment effects
// ------------------------------------------------------------

export interface PaymentContext {
  accountId: string;
  payment: AsaasPayment;
}

/**
 * An invoice exists (PAYMENT_CREATED / UPDATED / RESTORED).
 * Records it and surfaces the payable link. Grants NOTHING.
 */
export async function recordInvoice(
  db: SupabaseClient,
  ctx: PaymentContext
): Promise<void> {
  const { accountId, payment } = ctx;
  const subscription = await findSubscriptionRow(
    db,
    accountId,
    payment.subscription
  );

  await upsertPaymentRow(db, accountId, payment, subscription?.id ?? null);

  if (subscription && payment.invoiceUrl) {
    await db
      .from('account_subscriptions')
      .update({
        latest_invoice_url: payment.invoiceUrl,
        next_due_date: payment.dueDate ?? null,
      })
      .eq('id', subscription.id);
  }
}

/** Insert-or-update the invoice row WITHOUT touching the period. */
async function upsertPaymentRow(
  db: SupabaseClient,
  accountId: string,
  payment: AsaasPayment,
  subscriptionRowId: string | null
): Promise<void> {
  const row = {
    account_id: accountId,
    subscription_id: subscriptionRowId,
    asaas_payment_id: payment.id,
    asaas_subscription_id: payment.subscription ?? null,
    status: String(payment.status ?? 'UNKNOWN'),
    billing_type: payment.billingType ?? null,
    value_cents: toCents(payment.value),
    due_date: payment.dueDate ?? null,
    invoice_url: payment.invoiceUrl ?? null,
  };

  // onConflict on the UNIQUE asaas_payment_id. Note this deliberately
  // does NOT include period_start/period_end — those are owned
  // exclusively by applyPaidPayment's guarded update, and letting an
  // upsert clear them would re-arm the extension and hand out a free
  // cycle on the next duplicate delivery.
  const { error } = await db
    .from('subscription_payments')
    .upsert(row, { onConflict: 'asaas_payment_id' });

  if (error) {
    console.error('[billing/store] upsertPaymentRow error:', error.message);
    throw new Error(`Failed to record payment ${payment.id}`);
  }
}

/**
 * Money arrived. Push the entitlement horizon forward — at most once
 * per payment, ever.
 *
 * The `.is("period_end", null)` filter is the whole trick. Asaas
 * sends CONFIRMED then RECEIVED for one payment, each with its own
 * event id, so the outer dedupe cannot help. Whichever of the two
 * lands first claims the window by writing period_end; the second
 * one's UPDATE matches zero rows, gets no row back, and skips the
 * extension. `asaas_payment_id` is UNIQUE, so this is safe against
 * two concurrent deliveries as well: the row-level lock serialises
 * them and only one sees period_end still null.
 */
export async function applyPaidPayment(
  db: SupabaseClient,
  ctx: PaymentContext
): Promise<{ extended: boolean }> {
  const { accountId, payment } = ctx;

  const subscription = await findSubscriptionRow(
    db,
    accountId,
    payment.subscription
  );
  await upsertPaymentRow(db, accountId, payment, subscription?.id ?? null);

  const { data: account, error: accountErr } = await db
    .from('accounts')
    .select('plan_expires_at')
    .eq('id', accountId)
    .maybeSingle();

  if (accountErr) {
    throw new Error(`Failed to read account ${accountId}`);
  }

  const now = new Date();
  const currentExpiry = account?.plan_expires_at
    ? new Date(account.plan_expires_at as string)
    : null;

  // The cycle comes from the local subscription snapshot, not from
  // the plan: a price/cycle change must not retroactively alter what
  // an existing subscriber is getting.
  const cycle = subscription?.cycle ?? 'MONTHLY';
  const { periodStart, periodEnd } = computeNewExpiry({
    currentExpiry,
    cycle,
    now,
  });

  const paidAt =
    payment.paymentDate ??
    payment.clientPaymentDate ??
    payment.confirmedDate ??
    now.toISOString();

  const { data: claimed, error: claimErr } = await db
    .from('subscription_payments')
    .update({
      status: String(payment.status ?? 'RECEIVED'),
      paid_at: paidAt,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
    })
    .eq('asaas_payment_id', payment.id)
    .is('period_end', null)
    .select('id')
    .maybeSingle();

  if (claimErr) {
    throw new Error(`Failed to claim payment ${payment.id}`);
  }

  if (!claimed) {
    // Already bought its window. Keep the status fresh (CONFIRMED ->
    // RECEIVED is real information) but do not move the horizon.
    await db
      .from('subscription_payments')
      .update({ status: String(payment.status ?? 'RECEIVED') })
      .eq('asaas_payment_id', payment.id);
    return { extended: false };
  }

  const { error: accountUpdErr } = await db
    .from('accounts')
    .update({
      plan_expires_at: periodEnd.toISOString(),
      billing_status: 'active',
    })
    .eq('id', accountId);

  if (accountUpdErr) {
    throw new Error(`Failed to extend account ${accountId}`);
  }

  if (subscription) {
    await db
      .from('account_subscriptions')
      .update({
        status: 'active',
        next_due_date: payment.dueDate ?? null,
        latest_invoice_url: payment.invoiceUrl ?? null,
      })
      .eq('id', subscription.id);
  }

  // The customer just paid; don't make them wait out the 30s guard
  // cache before their queued messages start moving again.
  invalidateEntitlement(accountId);

  return { extended: true };
}

/**
 * The invoice lapsed (PAYMENT_OVERDUE).
 *
 * Labels only. `plan_expires_at` is deliberately untouched: the
 * customer paid for the window they are currently in, and the grace
 * period covers the tail. Rolling the horizon back here would lock
 * out someone who is still inside the period they bought.
 */
export async function markPastDue(
  db: SupabaseClient,
  ctx: PaymentContext
): Promise<void> {
  const { accountId, payment } = ctx;
  const subscription = await findSubscriptionRow(
    db,
    accountId,
    payment.subscription
  );
  await upsertPaymentRow(db, accountId, payment, subscription?.id ?? null);

  await db
    .from('accounts')
    .update({ billing_status: 'past_due' })
    .eq('id', accountId);

  if (subscription) {
    await db
      .from('account_subscriptions')
      .update({ status: 'past_due' })
      .eq('id', subscription.id);
  }
}

/**
 * Refund / chargeback / deletion. Claw the horizon back to where it
 * was before this payment bought its window.
 *
 * Uses the stored `period_start` rather than subtracting a cycle:
 * subtraction would be wrong whenever the payment stacked onto an
 * existing horizon, and `period_start` is the exact value that was
 * there beforehand.
 */
export async function reversePayment(
  db: SupabaseClient,
  ctx: PaymentContext
): Promise<void> {
  const { accountId, payment } = ctx;

  const { data: row } = await db
    .from('subscription_payments')
    .select('id, period_start, period_end')
    .eq('asaas_payment_id', payment.id)
    .maybeSingle();

  await db
    .from('subscription_payments')
    .update({ status: String(payment.status ?? 'REFUNDED') })
    .eq('asaas_payment_id', payment.id);

  // Never granted anything, so there is nothing to take back.
  if (!row?.period_start) return;

  const { data: account } = await db
    .from('accounts')
    .select('plan_expires_at')
    .eq('id', accountId)
    .maybeSingle();

  const currentExpiry = account?.plan_expires_at
    ? new Date(account.plan_expires_at as string)
    : null;
  const periodEnd = row.period_end ? new Date(row.period_end as string) : null;

  // Only roll back if the horizon still reflects THIS payment.
  // A later payment may have already pushed it further out, and
  // clawing that back would punish a customer who paid twice.
  if (
    currentExpiry &&
    periodEnd &&
    currentExpiry.getTime() > periodEnd.getTime()
  ) {
    return;
  }

  await db
    .from('accounts')
    .update({
      plan_expires_at: row.period_start,
      billing_status: 'past_due',
    })
    .eq('id', accountId);

  const subscription = await findSubscriptionRow(
    db,
    accountId,
    payment.subscription
  );
  if (subscription) {
    await db
      .from('account_subscriptions')
      .update({ status: 'past_due' })
      .eq('id', subscription.id);
  }

  invalidateEntitlement(accountId);
}
