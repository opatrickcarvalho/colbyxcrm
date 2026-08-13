import { describe, expect, it } from 'vitest';

import { computeNewExpiry, todayInSaoPaulo } from './expiry';

// The money math. Every case below encodes a decision from the
// billing plan; changing one of them changes what customers get for
// what they paid, so treat a failure here as a spec question, not a
// test to update.

const NOW = new Date('2026-08-11T12:00:00.000Z');

describe('computeNewExpiry — fresh subscription', () => {
  it('starts the period at now when there is no horizon', () => {
    const { periodStart, periodEnd } = computeNewExpiry({
      currentExpiry: null,
      cycle: 'MONTHLY',
      now: NOW,
    });
    expect(periodStart.toISOString()).toBe(NOW.toISOString());
    expect(periodEnd.toISOString()).toBe('2026-09-11T12:00:00.000Z');
  });

  it('handles every cycle', () => {
    const end = (cycle: string) =>
      computeNewExpiry({ currentExpiry: null, cycle, now: NOW })
        .periodEnd.toISOString()
        .slice(0, 10);

    expect(end('WEEKLY')).toBe('2026-08-18');
    expect(end('BIWEEKLY')).toBe('2026-08-25');
    expect(end('MONTHLY')).toBe('2026-09-11');
    expect(end('BIMONTHLY')).toBe('2026-10-11');
    expect(end('QUARTERLY')).toBe('2026-11-11');
    expect(end('SEMIANNUALLY')).toBe('2027-02-11');
    expect(end('YEARLY')).toBe('2027-08-11');
  });
});

describe('computeNewExpiry — early renewal stacks', () => {
  it('anchors on the existing horizon when it is still in the future', () => {
    // Paying 5 days early must give 35 days of runway, not 30.
    // Otherwise the customer loses the days they already paid for and
    // opens a support ticket that is impossible to argue with.
    const currentExpiry = new Date('2026-08-16T12:00:00.000Z');
    const { periodStart, periodEnd } = computeNewExpiry({
      currentExpiry,
      cycle: 'MONTHLY',
      now: NOW,
    });
    expect(periodStart.toISOString()).toBe(currentExpiry.toISOString());
    expect(periodEnd.toISOString()).toBe('2026-09-16T12:00:00.000Z');
  });

  it('does not mutate the Date it was handed', () => {
    const currentExpiry = new Date('2026-08-16T12:00:00.000Z');
    const before = currentExpiry.getTime();
    computeNewExpiry({ currentExpiry, cycle: 'YEARLY', now: NOW });
    expect(currentExpiry.getTime()).toBe(before);
  });
});

describe('computeNewExpiry — late payment does not backfill', () => {
  it('anchors on now after a lapse', () => {
    // A 20-day lapse anchored on the stale horizon would produce a
    // periodEnd 20 days in the past: the customer pays and is locked
    // out in the same instant. Never do that.
    const { periodStart, periodEnd } = computeNewExpiry({
      currentExpiry: new Date('2026-07-22T12:00:00.000Z'),
      cycle: 'MONTHLY',
      now: NOW,
    });
    expect(periodStart.toISOString()).toBe(NOW.toISOString());
    expect(periodEnd.toISOString()).toBe('2026-09-11T12:00:00.000Z');
  });

  it('never returns a periodEnd in the past, however long the lapse', () => {
    for (const cycle of ['WEEKLY', 'MONTHLY', 'YEARLY']) {
      const { periodEnd } = computeNewExpiry({
        currentExpiry: new Date('2019-01-01T00:00:00.000Z'),
        cycle,
        now: NOW,
      });
      expect(periodEnd.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('treats an unparseable current horizon as no horizon', () => {
    const { periodStart } = computeNewExpiry({
      currentExpiry: new Date('nonsense'),
      cycle: 'MONTHLY',
      now: NOW,
    });
    expect(periodStart.toISOString()).toBe(NOW.toISOString());
  });
});

describe('computeNewExpiry — month-end clamping', () => {
  it('clamps Jan 31 + MONTHLY to the end of February', () => {
    // Naive setMonth arithmetic rolls this to Mar 2/3, quietly
    // gifting the customer extra days every January.
    const jan31 = new Date('2026-01-31T12:00:00.000Z');
    const { periodEnd } = computeNewExpiry({
      currentExpiry: null,
      cycle: 'MONTHLY',
      now: jan31,
    });
    expect(periodEnd.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('clamps into a leap February', () => {
    const jan31 = new Date('2028-01-31T12:00:00.000Z');
    const { periodEnd } = computeNewExpiry({
      currentExpiry: null,
      cycle: 'MONTHLY',
      now: jan31,
    });
    expect(periodEnd.toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('clamps Feb 29 + YEARLY to Feb 28 of a non-leap year', () => {
    const leapDay = new Date('2028-02-29T12:00:00.000Z');
    const { periodEnd } = computeNewExpiry({
      currentExpiry: null,
      cycle: 'YEARLY',
      now: leapDay,
    });
    expect(periodEnd.toISOString().slice(0, 10)).toBe('2029-02-28');
  });

  it('clamps Aug 31 + SEMIANNUALLY to the end of February', () => {
    const aug31 = new Date('2026-08-31T12:00:00.000Z');
    const { periodEnd } = computeNewExpiry({
      currentExpiry: null,
      cycle: 'SEMIANNUALLY',
      now: aug31,
    });
    expect(periodEnd.toISOString().slice(0, 10)).toBe('2027-02-28');
  });
});

describe('computeNewExpiry — unknown cycle', () => {
  it('throws rather than silently falling back to monthly', () => {
    // A silent fallback is a money bug that never surfaces: a YEARLY
    // customer billed correctly but granted one month of access.
    expect(() =>
      computeNewExpiry({ currentExpiry: null, cycle: 'FORTNIGHTLY', now: NOW })
    ).toThrow(/Unknown billing cycle/);
  });
});

describe('todayInSaoPaulo', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(todayInSaoPaulo(NOW)).toBe('2026-08-11');
  });

  it('uses BRT, not UTC, near midnight', () => {
    // Asaas interprets bare dates in Brazilian time. At 02:00 UTC it
    // is still the previous day in São Paulo (UTC-3); sending the UTC
    // date would push the first invoice a day out and show the
    // customer a due date they did not pick.
    expect(todayInSaoPaulo(new Date('2026-08-11T02:00:00.000Z'))).toBe(
      '2026-08-10'
    );
    // And just after local midnight it must roll over.
    expect(todayInSaoPaulo(new Date('2026-08-11T03:30:00.000Z'))).toBe(
      '2026-08-11'
    );
  });
});
