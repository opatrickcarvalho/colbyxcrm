/**
 * Precomputes send instants for a WhatsApp campaign.
 *
 * The cron drain that actually fires messages only ever asks "what's due
 * now?" — it does not know about business hours, weekdays, or timezones.
 * That knowledge lives here, resolved once at campaign-creation time into a
 * concrete Date per recipient. Keeping the drain dumb means a recipient
 * scheduled for 17:55 in a window that closes at 18:00 never becomes a
 * "half sent" edge case at drain time: the plan already pushed it (or the
 * next one) past the boundary before it was ever stored.
 */

/** 'HH:MM' 24h local time. */
export interface SendWindow {
  start: string; // e.g. '08:00'
  end: string; // e.g. '18:00'; when end <= start the window crosses midnight
  days: number[]; // ISO weekdays, 1 = Monday .. 7 = Sunday. Empty array means "no day allowed".
  timeZone: string; // IANA, e.g. 'America/Sao_Paulo'
}

export interface PlanOptions {
  count: number;
  startAt: Date;
  delaySeconds: number;
  jitterPct: number; // 0-90; 20 means each gap is delay * (0.8 .. 1.2)
  window?: SendWindow | null; // null/undefined = send around the clock
  rng?: () => number; // defaults to Math.random
}

const MAX_COUNT = 20000;
const MAX_FORWARD_SEARCH_DAYS = 14;

/**
 * Local wall-clock reading of an instant, in a given IANA zone.
 *
 * `hourCycle: 'h23'` is set alongside the spec-mandated `hour12: false`
 * because some ICU builds still report midnight as hour "24" under
 * `hour12: false` alone; `h23` is the belt-and-suspenders fix that keeps
 * the hour in 0-23 regardless of host ICU quirks.
 */
function localParts(at: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const raw: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== 'literal') raw[part.type] = part.value;
  }
  return {
    year: Number(raw.year),
    month: Number(raw.month),
    day: Number(raw.day),
    hour: Number(raw.hour),
    minute: Number(raw.minute),
    second: Number(raw.second),
  };
}

/** ISO weekday (1 = Monday .. 7 = Sunday) for a plain calendar date. */
function isoWeekday(year: number, month: number, day: number): number {
  // A calendar date's weekday doesn't depend on timezone, so this is safe
  // to compute against UTC rather than the window's zone.
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return utcDay === 0 ? 7 : utcDay;
}

/**
 * The zone's offset from UTC, in minutes, at the given instant, defined so
 * that `localTime = instant + offset`. Varies across a DST transition,
 * which is exactly why `localToInstant` below has to sample it twice.
 */
function tzOffsetMinutes(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second
  );
  return (asUtc - at.getTime()) / 60000;
}

/**
 * Converts a local wall-clock reading (in `timeZone`) back to an instant.
 *
 * There's no direct API for this, so it's a round-trip: read the zone's
 * offset as if the naive UTC interpretation of the wall clock were already
 * correct, subtract it to get a candidate instant, then read the offset
 * *again* at that candidate. The second read matters right around a DST
 * transition — the offset that applies to the target wall-clock reading can
 * differ from the offset implied by the naive first guess, and using the
 * re-checked offset is what makes the candidate land on the correct side of
 * the transition.
 */
function localToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = tzOffsetMinutes(new Date(naiveUtcMs), timeZone);
  const candidateMs = naiveUtcMs - firstOffset * 60000;
  const recheckedOffset = tzOffsetMinutes(new Date(candidateMs), timeZone);
  return new Date(naiveUtcMs - recheckedOffset * 60000);
}

/**
 * A wall-clock date-time with no offset — exactly what an
 * `<input type="datetime-local">` produces ('2026-08-09T14:30'). Seconds
 * are optional; anything carrying a 'Z' or a ±HH:MM offset deliberately
 * fails this test and is left to `Date`.
 */
const NAIVE_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parses a campaign's requested start instant, returning null when the
 * value is not a usable date.
 *
 * The subtle case is a *naive* string. `new Date('2026-08-09T14:30')`
 * resolves it against whatever zone the process happens to run in — the
 * developer's laptop in dev, UTC on the host in production. So an
 * operator in UTC-3 picking 14:00 today would have it read as 11:00
 * their own time: either already past (rejected as "not in the future")
 * or, further out, silently three hours early. Interpreting it in the
 * campaign's own `timeZone` is the only reading that matches what the
 * person picking the time meant, and it makes the result independent of
 * where the server runs.
 */
export function parseScheduledAt(value: string, timeZone: string): Date | null {
  const naive = NAIVE_DATETIME_RE.exec(value.trim());
  if (!naive) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const [year, month, day, hour, minute, second] = [
    naive[1],
    naive[2],
    naive[3],
    naive[4],
    naive[5],
    naive[6] ?? '0',
  ].map(Number);

  // `Date.UTC` silently rolls impossible components over (month 13 becomes
  // January of the next year, 31 February becomes 3 March), which would
  // turn a malformed request into a plausible-looking date instead of a
  // rejection. The regex only proves the shape, so the values are range-
  // and calendar-checked here before any conversion happens.
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    return null;
  }

  return localToInstant(year, month, day, hour, minute, second, timeZone);
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseHHMM(value: string): { hour: number; minute: number } {
  const match = HHMM_RE.exec(value);
  if (!match) {
    throw new Error(
      `schedule: invalid time '${value}', expected 24h 'HH:MM' (e.g. '08:00').`
    );
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function assertValidDays(days: number[]): void {
  if (days.length === 0) {
    throw new Error(
      'schedule: window.days is empty, so the window can never open.'
    );
  }
  for (const d of days) {
    if (!Number.isInteger(d) || d < 1 || d > 7) {
      throw new Error(
        `schedule: invalid weekday ${d} in window.days (expected an integer 1-7, 1 = Monday).`
      );
    }
  }
}

/**
 * Is `at` inside `window`, evaluated on the window's own timezone clock?
 *
 * For a window that crosses midnight (`end <= start`, including the
 * `end === start` case, which reads as "open all 24 hours on allowed
 * days"), an instant can fall in one of two segments: the same local day as
 * the opening (checked against `days` directly), or the tail after
 * midnight and before `end` — which belongs to a window that opened
 * *yesterday*, so it's `days` for the previous local weekday that governs.
 */
export function isWithinWindow(at: Date, window: SendWindow): boolean {
  const { hour: startHour, minute: startMinute } = parseHHMM(window.start);
  const { hour: endHour, minute: endMinute } = parseHHMM(window.end);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;

  const local = localParts(at, window.timeZone);
  const nowMinutes = local.hour * 60 + local.minute;
  const weekday = isoWeekday(local.year, local.month, local.day);

  if (endMinutes > startMinutes) {
    // Same-day window: no midnight crossing to reason about.
    return (
      window.days.includes(weekday) &&
      nowMinutes >= startMinutes &&
      nowMinutes < endMinutes
    );
  }

  // Midnight-crossing window.
  if (nowMinutes >= startMinutes) {
    return window.days.includes(weekday); // today's opening segment
  }
  if (nowMinutes < endMinutes) {
    const previousWeekday = weekday === 1 ? 7 : weekday - 1;
    return window.days.includes(previousWeekday); // yesterday's tail segment
  }
  return false;
}

/**
 * The next instant, at or after `at`, when `window` opens (local clock
 * reads `window.start` on an allowed weekday). Used only to push a
 * candidate send time that already fell outside the window forward to a
 * valid one — it is not meant to be called when `at` is already inside the
 * window.
 *
 * Search is capped at `MAX_FORWARD_SEARCH_DAYS` days so an unsatisfiable
 * window (most commonly `days: []`) fails fast with a descriptive error
 * instead of looping forever.
 */
export function nextWindowOpening(at: Date, window: SendWindow): Date {
  assertValidDays(window.days);
  const { hour: startHour, minute: startMinute } = parseHHMM(window.start);
  parseHHMM(window.end); // validate shape even though only `start` is used below

  const local = localParts(at, window.timeZone);

  for (let offset = 0; offset <= MAX_FORWARD_SEARCH_DAYS; offset++) {
    // Date.UTC normalises month/year rollover for us, so `day + offset`
    // beyond the month's length just works.
    const dayCursor = new Date(
      Date.UTC(local.year, local.month - 1, local.day + offset)
    );
    const year = dayCursor.getUTCFullYear();
    const month = dayCursor.getUTCMonth() + 1;
    const day = dayCursor.getUTCDate();
    const weekday = isoWeekday(year, month, day);
    if (!window.days.includes(weekday)) continue;

    const candidate = localToInstant(
      year,
      month,
      day,
      startHour,
      startMinute,
      0,
      window.timeZone
    );
    if (candidate.getTime() >= at.getTime()) return candidate;
  }

  throw new Error(
    `schedule: window never opens within ${MAX_FORWARD_SEARCH_DAYS} days ` +
      `(start='${window.start}', days=[${window.days.join(',')}], timeZone='${window.timeZone}').`
  );
}

/** `delaySeconds` jittered by up to `jitterPct`, floored at 1 second. */
function jitteredGapSeconds(
  delaySeconds: number,
  jitterPct: number,
  rng: () => number
): number {
  const factor = 1 + (rng() * 2 - 1) * (jitterPct / 100);
  return Math.max(1, Math.round(delaySeconds * factor));
}

export function planSendTimes(options: PlanOptions): Date[] {
  const { count, startAt, delaySeconds, window, rng = Math.random } = options;

  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `planSendTimes: count must be a non-negative integer, got ${count}.`
    );
  }
  if (count > MAX_COUNT) {
    throw new Error(
      `planSendTimes: count must be <= ${MAX_COUNT}, got ${count}.`
    );
  }
  if (!Number.isFinite(delaySeconds) || delaySeconds < 1) {
    throw new Error(
      `planSendTimes: delaySeconds must be a number >= 1, got ${delaySeconds}.`
    );
  }
  if (!Number.isFinite(options.jitterPct)) {
    throw new Error(
      `planSendTimes: jitterPct must be a finite number, got ${options.jitterPct}.`
    );
  }
  if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime())) {
    throw new Error('planSendTimes: startAt must be a valid Date.');
  }
  const jitterPct = Math.min(90, Math.max(0, options.jitterPct));

  if (count === 0) return [];

  const results: Date[] = [];
  let current =
    window && !isWithinWindow(startAt, window)
      ? nextWindowOpening(startAt, window)
      : startAt;
  results.push(current);

  for (let i = 1; i < count; i++) {
    const gapSeconds = jitteredGapSeconds(delaySeconds, jitterPct, rng);
    let next = new Date(current.getTime() + gapSeconds * 1000);
    if (window && !isWithinWindow(next, window)) {
      next = nextWindowOpening(next, window);
    }
    results.push(next);
    current = next;
  }

  return results;
}
