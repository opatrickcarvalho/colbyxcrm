import { describe, expect, it } from 'vitest';

import {
  BILLING_SETTINGS_FALLBACK,
  daysUntilExpiry,
  isBillingStatus,
  isEntitled,
  type BillingSettings,
  type BillingSnapshot,
} from './entitlement';

// Keep this file in lockstep with `account_is_entitled()` in
// supabase/migrations/053_billing_plans.sql. The SQL function is the
// real gate — it runs inside is_account_member(), so ~30 RLS policies
// inherit it — and this predicate only decides whether the API
// returns a friendly 402 first. If the two disagree, the customer
// sees an empty CRM with no error message and support cannot tell it
// apart from data loss. Same convention roles.test.ts uses to pin
// is_account_member's role CASE.

const NOW = new Date('2026-08-11T12:00:00.000Z');

const ON: BillingSettings = { enforcementEnabled: true, graceDays: 3 };
const OFF: BillingSettings = { enforcementEnabled: false, graceDays: 3 };

/** ISO string `days` from NOW. Negative for the past. */
function iso(days: number): string {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe('isEntitled — the kill switch', () => {
  it('returns true for everyone while enforcement is off', () => {
    // The rollback path: one UPDATE on platform_settings unlocks
    // every tenant. Nothing below it may be consulted.
    const hopelesslyExpired: BillingSnapshot = {
      plan_expires_at: iso(-3650),
      billing_exempt: false,
      billing_status: 'expired',
    };
    expect(isEntitled(hopelesslyExpired, OFF, NOW)).toBe(true);
  });

  it('stops short-circuiting once enforcement is on', () => {
    expect(isEntitled({ plan_expires_at: iso(-3650) }, ON, NOW)).toBe(false);
  });
});

describe('isEntitled — fail-open branches', () => {
  it.each<[string, BillingSnapshot | null | undefined]>([
    ['null snapshot (orphaned profile / failed lookup)', null],
    ['undefined snapshot', undefined],
    ['pre-053 schema: no billing columns at all', {}],
    ['explicit null horizon (never billed)', { plan_expires_at: null }],
    ['empty-string horizon', { plan_expires_at: '' }],
    ['unparseable horizon', { plan_expires_at: 'not-a-date' }],
  ])('%s => entitled', (_label, snapshot) => {
    // Every one of these is a deliberate fail-open. A bug that nulls
    // plan_expires_at costs a few days of revenue; a fail-closed
    // version locks out every paying customer in one afternoon,
    // silently, because RLS denials surface as EMPTY RESULTS.
    expect(isEntitled(snapshot, ON, NOW)).toBe(true);
  });

  it('treats a corrupted graceDays as the fallback rather than NaN', () => {
    // NaN arithmetic compares false, which would lock everyone out.
    const broken = { enforcementEnabled: true, graceDays: Number.NaN };
    expect(isEntitled({ plan_expires_at: iso(-1) }, broken, NOW)).toBe(true);
    expect(isEntitled({ plan_expires_at: iso(-10) }, broken, NOW)).toBe(false);
    expect(BILLING_SETTINGS_FALLBACK.graceDays).toBe(3);
  });
});

describe('isEntitled — exemption', () => {
  it('honours billing_exempt === true', () => {
    expect(
      isEntitled({ plan_expires_at: iso(-100), billing_exempt: true }, ON, NOW)
    ).toBe(true);
  });

  it('does not treat a missing billing_exempt as exempt on its own', () => {
    // It still passes, but via the null-horizon branch — not via
    // exemption. Pinning this stops a refactor from collapsing the
    // two and accidentally exempting everyone with a real horizon.
    expect(isEntitled({ plan_expires_at: iso(-100) }, ON, NOW)).toBe(false);
  });
});

describe('isEntitled — the horizon and its grace window', () => {
  it.each<[string, number, boolean]>([
    ['expires in 30 days', 30, true],
    ['expires tomorrow', 1, true],
    ['expired 1 day ago, inside 3-day grace', -1, true],
    ['expired 2.9 days ago, inside grace', -2.9, true],
    ['expired 3.1 days ago, past grace', -3.1, false],
    ['expired 30 days ago', -30, false],
  ])('%s => %s', (_label, days, expected) => {
    expect(isEntitled({ plan_expires_at: iso(days) }, ON, NOW)).toBe(expected);
  });

  it('uses a strict comparison at the exact grace boundary', () => {
    // deadline > now, not >=. A horizon that lands exactly on the
    // boundary is over.
    const exactlyAtBoundary = { plan_expires_at: iso(-3) };
    expect(isEntitled(exactlyAtBoundary, ON, NOW)).toBe(false);
  });

  it('respects a zero-day grace setting', () => {
    const noGrace: BillingSettings = { enforcementEnabled: true, graceDays: 0 };
    expect(isEntitled({ plan_expires_at: iso(0.001) }, noGrace, NOW)).toBe(
      true
    );
    expect(isEntitled({ plan_expires_at: iso(-0.001) }, noGrace, NOW)).toBe(
      false
    );
  });

  it('ignores billing_status entirely', () => {
    // billing_status is a denormalised LABEL maintained by the hourly
    // sweep. If the sweep stalls, labels go stale — access must not.
    // A stale 'expired' label with a live horizon still grants access,
    // and a stale 'active' label with a dead horizon still denies it.
    expect(
      isEntitled(
        { plan_expires_at: iso(30), billing_status: 'expired' },
        ON,
        NOW
      )
    ).toBe(true);
    expect(
      isEntitled(
        { plan_expires_at: iso(-30), billing_status: 'active' },
        ON,
        NOW
      )
    ).toBe(false);
  });

  it('ignores trial_ends_at entirely', () => {
    // One horizon, one gate. The trial is expressed by seeding
    // plan_expires_at; trial_ends_at exists only so the UI can say
    // "trial" instead of "paid".
    expect(
      isEntitled({ plan_expires_at: iso(-30), trial_ends_at: iso(30) }, ON, NOW)
    ).toBe(false);
  });
});

describe('daysUntilExpiry', () => {
  it('returns null when there is no horizon', () => {
    expect(daysUntilExpiry(null, NOW)).toBeNull();
    expect(daysUntilExpiry({}, NOW)).toBeNull();
    expect(daysUntilExpiry({ plan_expires_at: 'nonsense' }, NOW)).toBeNull();
  });

  it('counts whole days forward and goes negative after the horizon', () => {
    expect(daysUntilExpiry({ plan_expires_at: iso(7) }, NOW)).toBe(7);
    expect(daysUntilExpiry({ plan_expires_at: iso(0.5) }, NOW)).toBe(1);
    expect(daysUntilExpiry({ plan_expires_at: iso(-2) }, NOW)).toBe(-2);
  });
});

describe('isBillingStatus', () => {
  it('accepts exactly the six values in the accounts CHECK constraint', () => {
    for (const status of [
      'trialing',
      'active',
      'past_due',
      'expired',
      'cancelled',
      'exempt',
    ]) {
      expect(isBillingStatus(status)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isBillingStatus('suspended')).toBe(false);
    expect(isBillingStatus('')).toBe(false);
    expect(isBillingStatus(null)).toBe(false);
    expect(isBillingStatus(undefined)).toBe(false);
  });
});
