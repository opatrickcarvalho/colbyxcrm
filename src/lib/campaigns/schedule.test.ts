import { describe, expect, it } from 'vitest';

import {
  isWithinWindow,
  nextWindowOpening,
  parseScheduledAt,
  planSendTimes,
  type SendWindow,
} from './schedule';

// Reference calendar (all Monday-start weeks, verified independently of the
// host clock via `Date.UTC(...).getUTCDay()`):
//   2026-08-10 Monday    2026-08-14 Friday
//   2026-08-15 Saturday  2026-08-17 Monday (the following week)
//
// Assertions read `.toISOString()` / `.getTime()` rather than local getters
// like `.getHours()`, so nothing here depends on the host process's
// timezone — the suite must pass whether it runs in UTC (as CI does) or
// anywhere else.

function iso(s: string): Date {
  return new Date(s);
}

describe('planSendTimes', () => {
  it('spaces recipients exactly delaySeconds apart around the clock when jitterPct is 0', () => {
    const startAt = iso('2026-08-10T12:00:00.000Z');
    const times = planSendTimes({
      count: 5,
      startAt,
      delaySeconds: 60,
      jitterPct: 0,
      window: null,
    });
    expect(times.map((t) => t.toISOString())).toEqual([
      '2026-08-10T12:00:00.000Z',
      '2026-08-10T12:01:00.000Z',
      '2026-08-10T12:02:00.000Z',
      '2026-08-10T12:03:00.000Z',
      '2026-08-10T12:04:00.000Z',
    ]);
  });

  it('jitterPct: 0 ignores rng entirely', () => {
    const times = planSendTimes({
      count: 3,
      startAt: iso('2026-08-10T00:00:00.000Z'),
      delaySeconds: 30,
      jitterPct: 0,
      window: null,
      rng: () => 0.999999, // would blow the delay way up if it were used
    });
    expect(times[1].getTime() - times[0].getTime()).toBe(30000);
    expect(times[2].getTime() - times[1].getTime()).toBe(30000);
  });

  it('keeps a seeded jitter within the delay * (1 +/- jitterPct/100) bounds', () => {
    // Cycles through the extremes and the midpoint of rng()'s [0, 1) range.
    const seedSequence = [0, 0.25, 0.5, 0.75, 0.999999];
    let i = 0;
    const rng = () => seedSequence[i++ % seedSequence.length];

    const delaySeconds = 100;
    const jitterPct = 20; // gaps must land in [80, 120] seconds
    const times = planSendTimes({
      count: 8,
      startAt: iso('2026-08-10T00:00:00.000Z'),
      delaySeconds,
      jitterPct,
      window: null,
      rng,
    });

    for (let idx = 1; idx < times.length; idx++) {
      const gapSeconds =
        (times[idx].getTime() - times[idx - 1].getTime()) / 1000;
      expect(gapSeconds).toBeGreaterThanOrEqual(80);
      expect(gapSeconds).toBeLessThanOrEqual(120);
    }
  });

  it('pushes a startAt before the window opens forward to the opening', () => {
    const window: SendWindow = {
      start: '09:00',
      end: '17:00',
      days: [1, 2, 3, 4, 5], // Mon-Fri
      timeZone: 'UTC',
    };
    const times = planSendTimes({
      count: 1,
      startAt: iso('2026-08-10T06:00:00.000Z'), // Monday, before 09:00
      delaySeconds: 60,
      jitterPct: 0,
      window,
    });
    expect(times[0].toISOString()).toBe('2026-08-10T09:00:00.000Z');
  });

  it('continues past the window end on the next allowed day, at the opening time', () => {
    const window: SendWindow = {
      start: '09:00',
      end: '17:00',
      days: [1, 2, 3, 4, 5], // Mon-Fri
      timeZone: 'UTC',
    };
    const times = planSendTimes({
      count: 2,
      startAt: iso('2026-08-14T16:59:30.000Z'), // Friday, inside the window
      delaySeconds: 120, // pushes the 2nd recipient to 17:01:30 -> outside
      jitterPct: 0,
      window,
    });
    expect(times[0].toISOString()).toBe('2026-08-14T16:59:30.000Z');
    // Saturday/Sunday are not allowed, so it resumes the following Monday.
    expect(times[1].toISOString()).toBe('2026-08-17T09:00:00.000Z');
  });

  it('skips disallowed weekdays between now and the next allowed one', () => {
    const window: SendWindow = {
      start: '09:00',
      end: '17:00',
      days: [1, 5], // only Monday and Friday
      timeZone: 'UTC',
    };
    // Tuesday 2026-08-11, mid-window time but a disallowed day.
    const opening = nextWindowOpening(iso('2026-08-11T10:00:00.000Z'), window);
    expect(opening.toISOString()).toBe('2026-08-14T09:00:00.000Z'); // Friday
  });

  it('handles a window that crosses midnight', () => {
    const window: SendWindow = {
      start: '22:00',
      end: '06:00',
      days: [5], // Friday openings only
      timeZone: 'UTC',
    };

    // Opening segment: Friday night itself.
    expect(isWithinWindow(iso('2026-08-14T23:00:00.000Z'), window)).toBe(true);
    // Tail segment: after midnight, before 06:00, belongs to Friday's opening.
    expect(isWithinWindow(iso('2026-08-15T01:00:00.000Z'), window)).toBe(true);
    // Past the end of the tail segment: closed again.
    expect(isWithinWindow(iso('2026-08-15T07:00:00.000Z'), window)).toBe(false);
    // Daytime Friday, before the window opens: closed.
    expect(isWithinWindow(iso('2026-08-14T12:00:00.000Z'), window)).toBe(false);

    const times = planSendTimes({
      count: 2,
      startAt: iso('2026-08-14T20:00:00.000Z'), // Friday evening, before opening
      delaySeconds: 12 * 3600, // 12h gap pushes recipient 2 past 06:00 Saturday
      jitterPct: 0,
      window,
    });
    expect(times[0].toISOString()).toBe('2026-08-14T22:00:00.000Z');
    // Next Friday opening, a week later (only Friday is allowed).
    expect(times[1].toISOString()).toBe('2026-08-21T22:00:00.000Z');
  });

  it('throws when window.days is empty', () => {
    const window: SendWindow = {
      start: '09:00',
      end: '17:00',
      days: [],
      timeZone: 'UTC',
    };
    expect(() =>
      planSendTimes({
        count: 1,
        startAt: iso('2026-08-10T06:00:00.000Z'),
        delaySeconds: 60,
        jitterPct: 0,
        window,
      })
    ).toThrow(/days/i);
    expect(() =>
      nextWindowOpening(iso('2026-08-10T06:00:00.000Z'), window)
    ).toThrow(/days/i);
  });

  it('returns [] for count: 0', () => {
    expect(
      planSendTimes({
        count: 0,
        startAt: iso('2026-08-10T06:00:00.000Z'),
        delaySeconds: 60,
        jitterPct: 0,
        window: null,
      })
    ).toEqual([]);
  });

  it('always returns non-decreasing times, even with jitter and a window', () => {
    const window: SendWindow = {
      start: '09:00',
      end: '17:00',
      days: [1, 2, 3, 4, 5],
      timeZone: 'UTC',
    };
    let seed = 1;
    // Simple deterministic PRNG so the test is reproducible.
    const rng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const times = planSendTimes({
      count: 50,
      startAt: iso('2026-08-10T08:55:00.000Z'),
      delaySeconds: 90,
      jitterPct: 40,
      window,
      rng,
    });
    for (let idx = 1; idx < times.length; idx++) {
      expect(times[idx].getTime()).toBeGreaterThanOrEqual(
        times[idx - 1].getTime()
      );
    }
  });

  it('resolves an America/Sao_Paulo window correctly regardless of host timezone', () => {
    // America/Sao_Paulo has been a fixed UTC-3 offset since Brazil dropped
    // DST in 2019, so local 08:00 is always UTC 11:00.
    const window: SendWindow = {
      start: '08:00',
      end: '18:00',
      days: [1, 2, 3, 4, 5],
      timeZone: 'America/Sao_Paulo',
    };

    // 2026-08-10T11:30:00Z is 08:30 local on Monday -> inside the window.
    expect(isWithinWindow(iso('2026-08-10T11:30:00.000Z'), window)).toBe(true);
    // 2026-08-10T08:00:00Z is 05:00 local on Monday -> before the window opens.
    expect(isWithinWindow(iso('2026-08-10T08:00:00.000Z'), window)).toBe(false);

    const times = planSendTimes({
      count: 1,
      startAt: iso('2026-08-10T08:00:00.000Z'), // 05:00 local Monday
      delaySeconds: 60,
      jitterPct: 0,
      window,
    });
    // Pushed forward to 08:00 local, i.e. 11:00 UTC, same Monday.
    expect(times[0].toISOString()).toBe('2026-08-10T11:00:00.000Z');
  });
});

describe('isWithinWindow', () => {
  it('rejects a disallowed weekday even inside the time-of-day range', () => {
    const window: SendWindow = {
      start: '09:00',
      end: '17:00',
      days: [1, 2, 3, 4, 5],
      timeZone: 'UTC',
    };
    // 2026-08-15 is a Saturday.
    expect(isWithinWindow(iso('2026-08-15T12:00:00.000Z'), window)).toBe(false);
  });
});

describe('parseScheduledAt', () => {
  // The regression this function exists for: an operator in UTC-3 picking
  // 14:00 in a `datetime-local` input meant 17:00Z, not 14:00Z. Reading
  // the naive string in the server's zone is what made a same-day time
  // look like it was in the past.
  it('reads a naive wall-clock string in the given zone, not the host zone', () => {
    expect(
      parseScheduledAt('2026-08-09T14:00', 'America/Sao_Paulo')?.toISOString()
    ).toBe('2026-08-09T17:00:00.000Z');
    expect(parseScheduledAt('2026-08-09T14:00', 'UTC')?.toISOString()).toBe(
      '2026-08-09T14:00:00.000Z'
    );
  });

  it('accepts optional seconds in the naive form', () => {
    expect(
      parseScheduledAt('2026-08-09T14:00:30', 'America/Sao_Paulo')?.toISOString()
    ).toBe('2026-08-09T17:00:30.000Z');
  });

  it('leaves an explicit offset or Z alone — the zone argument must not shift it', () => {
    expect(
      parseScheduledAt('2026-08-09T17:00:00.000Z', 'America/Sao_Paulo')?.toISOString()
    ).toBe('2026-08-09T17:00:00.000Z');
    expect(
      parseScheduledAt('2026-08-09T14:00:00-03:00', 'UTC')?.toISOString()
    ).toBe('2026-08-09T17:00:00.000Z');
  });

  it('returns null for anything that is not a date', () => {
    expect(parseScheduledAt('', 'UTC')).toBeNull();
    expect(parseScheduledAt('amanhã de manhã', 'UTC')).toBeNull();
  });

  // Date.UTC() would roll these over into a plausible-looking instant
  // (month 13 -> January of the next year, 31 February -> 3 March), which
  // is worse than a 400: the campaign would fire on a date nobody asked
  // for.
  it('rejects out-of-range and non-existent calendar dates instead of rolling them over', () => {
    expect(parseScheduledAt('2026-13-45T99:99', 'UTC')).toBeNull();
    expect(parseScheduledAt('2026-02-31T10:00', 'UTC')).toBeNull();
    expect(parseScheduledAt('2026-08-09T24:00', 'UTC')).toBeNull();
    expect(parseScheduledAt('2027-02-29T10:00', 'UTC')).toBeNull();
    // ...but a real leap day still parses.
    expect(parseScheduledAt('2028-02-29T10:00', 'UTC')?.toISOString()).toBe(
      '2028-02-29T10:00:00.000Z'
    );
  });
});

describe('nextWindowOpening', () => {
  it('throws a descriptive error when the window is unsatisfiable', () => {
    const window: SendWindow = {
      start: '09:00',
      end: '17:00',
      days: [],
      timeZone: 'UTC',
    };
    expect(() =>
      nextWindowOpening(iso('2026-08-10T06:00:00.000Z'), window)
    ).toThrow('window.days is empty');
  });
});
