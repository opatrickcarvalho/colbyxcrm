// ============================================================
// Expiry math — how much runway a confirmed payment buys.
//
// Pure. This is the single most consequential calculation in the
// billing feature: get it wrong in one direction and paying
// customers get locked out; wrong in the other and everyone gets
// free months. Every branch below is a decision, not an accident.
// ============================================================

import { addCycle, type AsaasCycle } from './cycles';

export interface ComputeExpiryInput {
  /**
   * The account's current `plan_expires_at`, or null when they have
   * never paid (or are mid-trial with the horizon already behind
   * them — same thing as far as this function cares).
   */
  currentExpiry: Date | null;
  cycle: AsaasCycle | string;
  now: Date;
}

export interface ComputedPeriod {
  periodStart: Date;
  periodEnd: Date;
}

/**
 * The window a payment buys.
 *
 *   periodStart = currentExpiry is in the future ? currentExpiry : now
 *   periodEnd   = periodStart + one cycle
 *
 * Why not anchor on the Asaas `dueDate`:
 *   A boleto's dueDate is when the invoice *should* have been paid.
 *   A customer who pays four days late would get a period anchored
 *   in the past, i.e. they'd pay for 30 days and receive 26. Anchor
 *   on wall-clock reality instead.
 *
 * Why early payment stacks (currentExpiry in the future):
 *   Renewing five days early gives 35 days of runway, not 30. This
 *   is what customers expect and it's what prevents the "I paid and
 *   lost days" support ticket. It also makes the common case —
 *   Asaas generating the next invoice a few days before the due
 *   date — behave correctly without special-casing.
 *
 * Why late payment does NOT backfill (currentExpiry in the past):
 *   After a 20-day lapse, anchoring on the stale currentExpiry
 *   would produce a periodEnd that is STILL in the past. The
 *   customer pays and is instantly locked out again — the worst
 *   possible outcome, and one that looks like theft. A lapsed
 *   account gets a fresh full cycle from today.
 *
 * Grace is deliberately absent here. `plan_expires_at` stays the
 * honest "paid through" date; the grace window is applied only in
 * `isEntitled()` / `account_is_entitled()`. Baking grace into the
 * horizon would compound it on every renewal.
 */
export function computeNewExpiry(input: ComputeExpiryInput): ComputedPeriod {
  const { currentExpiry, cycle, now } = input;

  const hasFutureHorizon =
    currentExpiry !== null &&
    !Number.isNaN(currentExpiry.getTime()) &&
    currentExpiry.getTime() > now.getTime();

  const periodStart = hasFutureHorizon
    ? new Date(currentExpiry.getTime())
    : new Date(now.getTime());
  const periodEnd = addCycle(periodStart, cycle);

  return { periodStart, periodEnd };
}

/**
 * Today in São Paulo as `YYYY-MM-DD`, for the Asaas `nextDueDate`
 * field.
 *
 * Asaas is a Brazilian processor and interprets bare dates in BRT.
 * Sending `new Date().toISOString().slice(0, 10)` from a UTC server
 * produces *tomorrow's* date for anything after 21:00 local, which
 * pushes the first invoice a day out and makes the "subscribe now,
 * pay now" flow show a due date the customer didn't choose. Format
 * in the target timezone explicitly.
 */
export function todayInSaoPaulo(now: Date = new Date()): string {
  // en-CA gives ISO-ordered parts (YYYY-MM-DD) without manual padding.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
