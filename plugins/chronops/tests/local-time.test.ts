import { describe, expect, it } from "vitest";
import { dayAfter, instantAt, localDateIn } from "../src/local-time.ts";

describe("instantAt", () => {
  it.each([
    // Toronto is UTC-5 in winter and UTC-4 in summer.
    ["2026-11-12", 9, "America/Toronto", "2026-11-12T14:00:00.000Z"],
    ["2026-07-15", 9, "America/Toronto", "2026-07-15T13:00:00.000Z"],
    ["2026-11-12", 0, "America/Toronto", "2026-11-12T05:00:00.000Z"],
    // Daylight saving time ends at 02:00 on November 1, 2026: midnight is still EDT, 09:00 is EST.
    ["2026-11-01", 0, "America/Toronto", "2026-11-01T04:00:00.000Z"],
    ["2026-11-01", 9, "America/Toronto", "2026-11-01T14:00:00.000Z"],
    // It starts at 02:00 on March 8, 2026.
    ["2026-03-08", 9, "America/Toronto", "2026-03-08T13:00:00.000Z"],
    // Chile skips midnight on September 6, 2026: the day starts at 01:00, UTC-3.
    ["2026-09-06", 0, "America/Santiago", "2026-09-06T04:00:00.000Z"],
    ["2026-09-06", 9, "America/Santiago", "2026-09-06T12:00:00.000Z"],
    // A day east of UTC whose midnight is skipped: Beirut on March 29, 2026.
    ["2026-03-29", 0, "Asia/Beirut", "2026-03-28T22:00:00.000Z"],
    // Offsets that are not whole hours, on both sides of UTC.
    ["2026-11-12", 9, "Asia/Kolkata", "2026-11-12T03:30:00.000Z"],
    ["2026-11-12", 9, "America/St_Johns", "2026-11-12T12:30:00.000Z"],
    ["2026-11-12", 9, "UTC", "2026-11-12T09:00:00.000Z"],
  ])("puts %s at %i:00 in %s at %s", (date, hour, timeZone, expected) => {
    expect(new Date(instantAt(date, hour, timeZone)).toISOString()).toBe(expected);
  });
});

describe("localDateIn", () => {
  it("gives the day of an instant where the user is, not in UTC", () => {
    const toronto = localDateIn("America/Toronto");
    expect(toronto(Date.parse("2026-11-10T03:30:00Z"))).toBe("2026-11-09");
    expect(toronto(Date.parse("2026-11-10T05:00:00Z"))).toBe("2026-11-10");
    expect(localDateIn("Asia/Kolkata")(Date.parse("2026-11-09T19:00:00Z"))).toBe("2026-11-10");
  });
});

describe("dayAfter", () => {
  it.each([
    ["2026-11-12", "2026-11-13"],
    ["2026-11-30", "2026-12-01"],
    ["2026-12-31", "2027-01-01"],
    ["2028-02-28", "2028-02-29"],
  ])("follows %s with %s", (date, next) => {
    expect(dayAfter(date)).toBe(next);
  });
});
