// ============================================================
// Asaas billing cycles.
//
// The vocabulary is Asaas's own, verbatim — the same strings go in
// the `plans.cycle` column, in the POST /v3/subscriptions body, and
// out of their API. No mapping table means no mapping table to
// drift.
//
// Pure: `addCycle` takes a Date and returns a Date. date-fns does
// the month arithmetic because it clamps correctly (Jan 31 +
// 1 month = Feb 28/29, not Mar 3 — which is what a naive
// `setMonth` produces and would silently gift a customer three
// extra days every January).
// ============================================================

import { addDays, addMonths } from 'date-fns';

export type AsaasCycle =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'BIMONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUALLY'
  | 'YEARLY';

export const ASAAS_CYCLES: readonly AsaasCycle[] = [
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'BIMONTHLY',
  'QUARTERLY',
  'SEMIANNUALLY',
  'YEARLY',
] as const;

export function isAsaasCycle(value: unknown): value is AsaasCycle {
  return (
    typeof value === 'string' &&
    (ASAAS_CYCLES as readonly string[]).includes(value)
  );
}

/**
 * Advance `from` by exactly one billing cycle.
 *
 * Throws on an unknown cycle rather than falling back to monthly.
 * A silent fallback here would be a money bug that never surfaces:
 * a YEARLY customer quietly billed the right amount but granted one
 * month of access, or a typo'd cycle in the plan catalogue shipping
 * to production unnoticed. The CHECK constraint on `plans.cycle`
 * makes this unreachable from our own data — it fires only when
 * Asaas adds a cycle we haven't taught this file about, and that is
 * exactly when we want to hear about it loudly.
 */
export function addCycle(from: Date, cycle: AsaasCycle | string): Date {
  switch (cycle) {
    case 'WEEKLY':
      return addDays(from, 7);
    case 'BIWEEKLY':
      return addDays(from, 14);
    case 'MONTHLY':
      return addMonths(from, 1);
    case 'BIMONTHLY':
      return addMonths(from, 2);
    case 'QUARTERLY':
      return addMonths(from, 3);
    case 'SEMIANNUALLY':
      return addMonths(from, 6);
    case 'YEARLY':
      return addMonths(from, 12);
    default:
      throw new Error(`Unknown billing cycle: ${String(cycle)}`);
  }
}

/**
 * i18n key suffix for a cycle, e.g. `Billing.cycle.MONTHLY`.
 * Kept next to the type so adding a cycle forces you past both.
 */
export function cycleLabelKey(cycle: AsaasCycle): string {
  return `cycle.${cycle}`;
}
