// ============================================================
// Entitlement predicate — the TypeScript mirror of the SQL
// function `account_is_entitled()` (migration 053).
//
// KEEP THE TWO IN LOCKSTEP. The SQL version is the real gate (it
// runs inside `is_account_member()`, so every RLS policy inherits
// it); this one exists so route handlers can return a friendly
// 402 instead of letting the caller discover the block as a set of
// mysteriously empty result sets. If they ever disagree, the user
// sees an empty CRM with no error — the single worst failure mode
// this feature has.
//
// Pure on purpose: no imports, no env reads, no clock of its own.
// `now` is a parameter so the tests can pin it.
// ============================================================

/** Denormalised label on `accounts.billing_status`. Never the gate. */
export type BillingStatus =
  'trialing' | 'active' | 'past_due' | 'expired' | 'cancelled' | 'exempt';

export const BILLING_STATUSES: readonly BillingStatus[] = [
  'trialing',
  'active',
  'past_due',
  'expired',
  'cancelled',
  'exempt',
] as const;

export function isBillingStatus(value: unknown): value is BillingStatus {
  return (
    typeof value === 'string' &&
    (BILLING_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The billing columns of an `accounts` row, as they arrive from
 * PostgREST.
 *
 * Every field is optional and accepts `null`/`undefined` because a
 * deployment that has NOT yet run migration 053 returns a row with
 * none of these columns at all. `isEntitled` treats that as entitled
 * — see the fail-open note below.
 */
export interface BillingSnapshot {
  billing_status?: string | null;
  plan_id?: string | null;
  /** ISO timestamp. THE entitlement horizon — "paid through". */
  plan_expires_at?: string | null;
  /** ISO timestamp. Label only; deliberately NOT part of the gate. */
  trial_ends_at?: string | null;
  billing_exempt?: boolean | null;
}

/** Platform-wide knobs from `platform_settings`. */
export interface BillingSettings {
  /** The kill switch. False ⇒ nobody is ever gated. */
  enforcementEnabled: boolean;
  /** Days past `plan_expires_at` that still count as entitled. */
  graceDays: number;
}

/** Safe default for any caller that cannot reach the settings table. */
export const BILLING_SETTINGS_FALLBACK: BillingSettings = {
  enforcementEnabled: false,
  graceDays: 3,
};

/**
 * Is this account allowed to use the CRM?
 *
 * Mirrors `account_is_entitled()` in 053 clause for clause:
 *
 *   NOT enforcement_enabled
 *   OR billing_exempt
 *   OR plan_expires_at IS NULL
 *   OR plan_expires_at + grace_days > now()
 *
 * Fail-open in three places, all deliberate:
 *
 *   1. Kill switch off  => entitled. The rollback path.
 *   2. `plan_expires_at` null/absent => entitled. Covers both a
 *      pre-053 schema and an account that was never billed. A bug
 *      that nulls the column costs a few days of revenue; a
 *      fail-closed version locks out every paying customer at once.
 *   3. Unparseable date => entitled, same reasoning.
 *
 * Grace is applied HERE and only here. Writing it into
 * `plan_expires_at` would compound it on every renewal and quietly
 * gift the customer an extra window per cycle.
 */
export function isEntitled(
  snapshot: BillingSnapshot | null | undefined,
  settings: BillingSettings,
  now: Date = new Date()
): boolean {
  if (!settings.enforcementEnabled) return true;

  // No row at all — an orphaned profile or a failed lookup. The
  // caller has bigger problems than billing; don't add a lockout on
  // top of them.
  if (!snapshot) return true;

  // `=== true` rather than truthiness: PostgREST hands back
  // `undefined` on a pre-053 schema, and `undefined` must not read
  // as "not exempt and therefore checkable" — it must fall through
  // to the null-horizon branch below, which is also fail-open.
  if (snapshot.billing_exempt === true) return true;

  const horizon = snapshot.plan_expires_at;
  if (horizon === null || horizon === undefined || horizon === '') return true;

  const expires = new Date(horizon);
  if (Number.isNaN(expires.getTime())) return true;

  // Guard the grace value itself: a corrupted platform_settings row
  // must not turn into NaN arithmetic, which would compare false and
  // lock everyone out.
  const graceDays =
    Number.isFinite(settings.graceDays) && settings.graceDays >= 0
      ? settings.graceDays
      : BILLING_SETTINGS_FALLBACK.graceDays;

  const deadline = expires.getTime() + graceDays * 24 * 60 * 60 * 1000;
  return deadline > now.getTime();
}

/**
 * Whole days left before `plan_expires_at`, for the UI countdown.
 * Negative once the horizon has passed (the customer may still be
 * inside the grace window — that's what `isEntitled` is for).
 *
 * Returns null when there is no horizon to count down to.
 */
export function daysUntilExpiry(
  snapshot: BillingSnapshot | null | undefined,
  now: Date = new Date()
): number | null {
  const horizon = snapshot?.plan_expires_at;
  if (!horizon) return null;
  const expires = new Date(horizon);
  if (Number.isNaN(expires.getTime())) return null;
  return Math.ceil((expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}
