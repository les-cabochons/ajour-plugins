// Days and hours in the user's time zone. Ajour speaks in local dates,
// YYYY-MM-DD, and ChronOps in instants, so the time sync converts between
// them with the IANA time zone Ajour sends. Intl does the time zone work,
// since the plugin carries no library.

/** Year, month, day, hour, minute and second of an instant in a time zone, in that order. */
type WallClock = [number, number, number, number, number, number];

function wallClockIn(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return (instant: number): WallClock => {
    const parts: Record<string, number> = {};
    for (const part of format.formatToParts(instant)) {
      if (part.type !== "literal") parts[part.type] = Number(part.value);
    }
    return [parts.year!, parts.month!, parts.day!, parts.hour!, parts.minute!, parts.second!];
  };
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string) {
  const [year, month, day, hour, minute, second] = wallClockIn(timeZone)(instant);
  const wholeSecond = instant - (((instant % 1000) + 1000) % 1000);
  return Date.UTC(year, month - 1, day, hour, minute, second) - wholeSecond;
}

/**
 * The instant it is `hour`:00 on `localDate` in `timeZone`, in
 * milliseconds. The second pass corrects the offset on a day whose
 * daylight saving time changes between midnight UTC and that hour. When
 * daylight saving time skips that hour, as Chile skips midnight, it is
 * the instant the clock jumps, so a day never starts on the day before.
 */
export function instantAt(localDate: string, hour: number, timeZone: string) {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour);
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  if (wall - second === offsetAt(second, timeZone)) return second;
  // The two passes land on either side of the skipped hour.
  return Math.max(first, second);
}

/** A function that gives an instant's local date, YYYY-MM-DD, in `timeZone`. */
export function localDateIn(timeZone: string) {
  const wallClock = wallClockIn(timeZone);
  return (instant: number) => {
    const [year, month, day] = wallClock(instant);
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
}

/** The local date after `localDate`. */
export function dayAfter(localDate: string) {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
