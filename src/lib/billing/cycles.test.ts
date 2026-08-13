import { describe, expect, it } from 'vitest';

import { addCycle, ASAAS_CYCLES, cycleLabelKey, isAsaasCycle } from './cycles';

const BASE = new Date('2026-08-11T12:00:00.000Z');

describe('ASAAS_CYCLES', () => {
  it('matches the CHECK constraint on plans.cycle (migration 053)', () => {
    expect([...ASAAS_CYCLES]).toEqual([
      'WEEKLY',
      'BIWEEKLY',
      'MONTHLY',
      'BIMONTHLY',
      'QUARTERLY',
      'SEMIANNUALLY',
      'YEARLY',
    ]);
  });
});

describe('addCycle', () => {
  it('advances by the right amount for every cycle', () => {
    const day = (cycle: string) =>
      addCycle(BASE, cycle).toISOString().slice(0, 10);

    expect(day('WEEKLY')).toBe('2026-08-18');
    expect(day('BIWEEKLY')).toBe('2026-08-25');
    expect(day('MONTHLY')).toBe('2026-09-11');
    expect(day('BIMONTHLY')).toBe('2026-10-11');
    expect(day('QUARTERLY')).toBe('2026-11-11');
    expect(day('SEMIANNUALLY')).toBe('2027-02-11');
    expect(day('YEARLY')).toBe('2027-08-11');
  });

  it('covers every declared cycle without throwing', () => {
    for (const cycle of ASAAS_CYCLES) {
      expect(() => addCycle(BASE, cycle)).not.toThrow();
    }
  });

  it('preserves the time of day', () => {
    expect(addCycle(BASE, 'MONTHLY').toISOString()).toBe(
      '2026-09-11T12:00:00.000Z'
    );
  });

  it('does not mutate its input', () => {
    const before = BASE.getTime();
    addCycle(BASE, 'YEARLY');
    expect(BASE.getTime()).toBe(before);
  });

  it('throws on an unknown cycle instead of defaulting to monthly', () => {
    // A silent monthly fallback would bill a YEARLY customer
    // correctly and grant them one month of access — a money bug
    // that never raises an error.
    expect(() => addCycle(BASE, 'FORTNIGHTLY')).toThrow(
      /Unknown billing cycle/
    );
    expect(() => addCycle(BASE, '')).toThrow(/Unknown billing cycle/);
    expect(() => addCycle(BASE, 'monthly')).toThrow(/Unknown billing cycle/);
  });
});

describe('isAsaasCycle', () => {
  it('accepts the declared cycles and nothing else', () => {
    for (const cycle of ASAAS_CYCLES) expect(isAsaasCycle(cycle)).toBe(true);
    expect(isAsaasCycle('monthly')).toBe(false);
    expect(isAsaasCycle('FORTNIGHTLY')).toBe(false);
    expect(isAsaasCycle(null)).toBe(false);
    expect(isAsaasCycle(12)).toBe(false);
  });
});

describe('cycleLabelKey', () => {
  it('builds the i18n suffix used under the Billing namespace', () => {
    expect(cycleLabelKey('MONTHLY')).toBe('cycle.MONTHLY');
    expect(cycleLabelKey('YEARLY')).toBe('cycle.YEARLY');
  });
});
