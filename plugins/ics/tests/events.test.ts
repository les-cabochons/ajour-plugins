import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeCalendar, listEvents, parseCalendar } from "../src/events.ts";

function fixture(name: string) {
  return parseCalendar(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

const utc = (month: number, day: number, hour: number, minute = 0) =>
  Date.UTC(2026, month - 1, day, hour, minute);

const week = { from: "2026-10-12", to: "2026-10-18", timeZone: "America/Toronto" };

describe("Google Calendar feed", () => {
  const events = listEvents(fixture("google.ics"), week);
  const byTitle = (title: string) => events.filter((event) => event.title === title);

  it("expands the standup, skips the excluded day and keeps the cancelled one", () => {
    const standups = events.filter((event) => event.eventId === "standup-123@google.com");

    expect(
      standups.map((event) => [event.startsAt, event.endsAt, event.title, event.status]),
    ).toEqual([
      [utc(10, 12, 13), utc(10, 12, 13, 15), "Daily standup", "confirmed"],
      [utc(10, 14, 13), utc(10, 14, 13, 15), "Daily standup", "confirmed"],
      [utc(10, 15, 14), utc(10, 15, 14, 15), "Daily standup (moved)", "confirmed"],
      [utc(10, 16, 13), utc(10, 16, 13, 15), "Daily standup", "cancelled"],
    ]);
    expect(standups.every((event) => event.seriesId === "standup-123@google.com")).toBe(true);
    expect(standups.every((event) => event.response === "accepted")).toBe(true);
  });

  it("reports all-day, declined, organized and free events", () => {
    expect(byTitle("Offsite day")).toEqual([
      {
        eventId: "offsite-1@google.com",
        startsAt: utc(10, 13, 4),
        endsAt: utc(10, 14, 4),
        allDay: true,
        title: "Offsite day",
        status: "confirmed",
        response: "accepted",
        isOrganizer: false,
        busy: false,
      },
    ]);
    expect(byTitle("Vendor demo")[0]).toMatchObject({
      startsAt: utc(10, 14, 18),
      response: "declined",
      isOrganizer: false,
    });
    expect(byTitle("Nordic kickoff")[0]).toMatchObject({
      startsAt: utc(10, 15, 15),
      endsAt: utc(10, 15, 16),
      response: "accepted",
      isOrganizer: true,
    });
  });

  it("keeps an event that runs into the week and drops ones that end at its start or come after", () => {
    expect(byTitle("Release night")[0]).toMatchObject({
      startsAt: utc(10, 12, 3),
      endsAt: utc(10, 12, 5),
      status: "tentative",
    });
    expect(byTitle("Ends at midnight before the week")).toEqual([]);
    expect(byTitle("Next week")).toEqual([]);
  });

  it("returns only the contract's fields, ordered by start", () => {
    const allowed = new Set([
      "eventId",
      "seriesId",
      "startsAt",
      "endsAt",
      "allDay",
      "title",
      "status",
      "response",
      "busy",
      "isOrganizer",
    ]);
    expect(events.flatMap(Object.keys).filter((key) => !allowed.has(key))).toEqual([]);
    expect(JSON.stringify(events)).not.toMatch(/meet\.google|roadmap|Main Street|maria@/);
    expect(events.map((event) => event.startsAt)).toEqual(
      [...events.map((event) => event.startsAt)].sort((a, b) => a - b),
    );
  });

  it("describes the calendar for the connection summary", () => {
    expect(describeCalendar(fixture("google.ics"))).toEqual({
      name: "alex@example.com",
      timeZone: "America/Toronto",
      eventCount: 9,
    });
  });
});

describe("Outlook feed", () => {
  const root = fixture("outlook.ics");

  it("reads Windows-named zones from their VTIMEZONE, Outlook busy states and all-day spans", () => {
    const events = listEvents(root, week);

    expect(
      events.map((event) => [event.title, event.startsAt, event.endsAt, event.busy, event.allDay]),
    ).toEqual([
      ["Training", utc(10, 12, 4), utc(10, 14, 4), false, true],
      ["Pay invoices", utc(10, 14, 12, 30), utc(10, 14, 12, 45), false, false],
      ["1:1 with Maria", utc(10, 15, 18), utc(10, 15, 19), true, false],
      ["Architecture review", utc(10, 16, 17), utc(10, 16, 18, 30), true, false],
    ]);
    expect(events.every((event) => event.response === "accepted")).toBe(true);
    expect(events.find((event) => event.title === "1:1 with Maria")?.seriesId).toBe(
      "040000008200E00074C5B7101A82E00800000000A1B2C3D4E5F6",
    );
  });

  it("follows the end of daylight saving time and the series' end", () => {
    const november = listEvents(root, {
      from: "2026-11-02",
      to: "2026-11-08",
      timeZone: "America/Toronto",
    });
    expect(november.map((event) => event.startsAt)).toEqual([utc(11, 5, 19)]);

    expect(
      listEvents(root, { from: "2027-01-04", to: "2027-01-10", timeZone: "America/Toronto" }),
    ).toEqual([]);
  });
});

describe("Exchange feed", () => {
  const root = fixture("exchange.ics");
  const options = { ...week, email: "Alex.Trepanier@contoso.com" };

  it("handles quoted zone ids, DURATION, folded titles and the user's reply", () => {
    const events = listEvents(root, options);
    const review = events.find((event) => event.eventId === "exchange-sprint-review");

    expect(review).toMatchObject({
      startsAt: utc(10, 15, 19, 30),
      endsAt: utc(10, 15, 20, 30),
      title:
        "Acme sprint review and planning for the checkout API team, with the platform group",
      isOrganizer: true,
      response: "accepted",
    });
    expect(events.find((event) => event.eventId === "exchange-west-coast-sync")).toMatchObject({
      startsAt: utc(10, 14, 16),
      endsAt: utc(10, 14, 16, 30),
      response: "tentative",
    });
    expect(events.find((event) => event.eventId === "exchange-other-team")).toMatchObject({
      response: "unknown",
      isOrganizer: false,
    });
  });

  it("reads floating times in the user's zone", () => {
    const toronto = listEvents(root, options).find(
      (event) => event.eventId === "exchange-floating-focus",
    );
    const paris = listEvents(root, { ...options, timeZone: "Europe/Paris" }).find(
      (event) => event.eventId === "exchange-floating-focus",
    );

    expect(toronto?.startsAt).toBe(utc(10, 13, 17));
    expect(paris?.startsAt).toBe(utc(10, 13, 11));
  });

  it("reports an unknown reply without the user's email when others attend", () => {
    const review = listEvents(root, week).find(
      (event) => event.eventId === "exchange-sprint-review",
    );
    expect(review?.response).toBe("unknown");
    expect(review?.isOrganizer).toBeUndefined();
  });
});

describe("edge cases", () => {
  const calendar = (...events: string[]) =>
    parseCalendar(
      ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n"),
    );

  it("cuts long titles and keeps going past a malformed event", () => {
    const root = calendar(
      "BEGIN:VEVENT",
      "UID:broken",
      "DTSTART:not-a-date",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:long",
      `SUMMARY:${"x".repeat(300)}`,
      "DTSTART:20261014T150000Z",
      "DTEND:20261014T160000Z",
      "END:VEVENT",
    );

    const events = listEvents(root, week);
    expect(events.map((event) => event.eventId)).toEqual(["long"]);
    expect(events[0]?.title).toHaveLength(200);
  });

  it("expands a long-running daily series quickly", () => {
    const root = calendar(
      "BEGIN:VEVENT",
      "UID:daily",
      "SUMMARY:Daily",
      "DTSTART:20100104T140000Z",
      "DTEND:20100104T141500Z",
      "RRULE:FREQ=DAILY",
      "END:VEVENT",
    );

    const started = performance.now();
    const events = listEvents(root, week);
    expect(events).toHaveLength(7);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("refuses data that is not iCalendar", () => {
    expect(() => parseCalendar("<html>Sign in</html>")).toThrow(
      "not valid iCalendar data",
    );
  });
});
