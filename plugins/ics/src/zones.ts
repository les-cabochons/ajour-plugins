/*
 * Wall-clock times to Unix milliseconds in an IANA time zone, through the
 * platform's time zone data. ical.js handles zones a feed defines in
 * VTIMEZONE; these helpers cover floating times, all-day dates and TZIDs a
 * feed names without defining.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function formatter(zone: string) {
  let existing = formatters.get(zone);
  if (!existing) {
    existing = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, existing);
  }
  return existing;
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(epochMs: number, zone: string) {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

/**
 * The instant a wall-clock time names in a zone. A time skipped by a
 * daylight-saving jump moves forward; a repeated one takes the first instant.
 */
export function wallClockToEpoch(clock: WallClock, zone: string): number {
  const guess = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour ?? 0,
    clock.minute ?? 0,
    clock.second ?? 0,
  );
  const first = offsetAt(guess, zone);
  const candidate = guess - first;
  const second = offsetAt(candidate, zone);
  if (second === first) return candidate;
  const retry = guess - second;
  return offsetAt(retry, zone) === second ? retry : candidate;
}

export function parseLocalDate(value: string): WallClock {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`"${value}" is not a date as YYYY-MM-DD.`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/** The local date `days` after a date, as a wall clock at midnight. */
export function addDays(clock: WallClock, days: number): WallClock {
  const date = new Date(
    Date.UTC(clock.year, clock.month - 1, clock.day) + days * DAY_MS,
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** Midnight at the start of a local date in a zone. */
export function startOfDay(clock: WallClock, zone: string): number {
  return wallClockToEpoch(
    { year: clock.year, month: clock.month, day: clock.day },
    zone,
  );
}
