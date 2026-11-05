import { afterEach, describe, expect, it, vi } from "vitest";
import { listCalendarEvents, validateConnection } from "../src/plugin.ts";
import { SECRET, connection, feed, fixture } from "./support/ajour.ts";

const context = { capabilities: ["calendar" as const] };
const week = { from: "2026-10-12", to: "2026-10-18", timeZone: "America/Toronto" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateConnection", () => {
  it("fetches the calendar once and returns the email, not the address", async () => {
    const fake = feed(fixture("google.ics"));

    await expect(
      validateConnection(connection({ email: " Alex@Example.com " }), context),
    ).resolves.toEqual({
      normalizedConfig: { email: "alex@example.com" },
      connectionSummary: {
        Calendar: "alex@example.com",
        "Time zone": "America/Toronto",
        Events: 9,
      },
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ connectionId: "connection-1", method: "GET", path: "" });
  });

  it("returns an empty config when there is no email", async () => {
    feed(fixture("outlook.ics"));

    const result = await validateConnection(connection(), context);

    expect(result.normalizedConfig).toEqual({});
  });

  it("refuses an invalid email before it asks for the calendar", async () => {
    const fake = feed(fixture("google.ics"));

    await expect(
      validateConnection(connection({ email: "alex" }), context),
    ).rejects.toThrow("not a valid email address");
    expect(fake.requests).toEqual([]);
  });

  it("keeps the address out of the error when the calendar is gone", async () => {
    feed(`Not found: https://calendar.google.com/${SECRET}`, { status: 404 });

    const error = await validateConnection(connection(), context).catch(
      (reason: unknown) => reason as Error,
    );

    expect(error?.message).toContain("HTTP 404");
    expect(error?.message).not.toContain(SECRET);
  });
});

describe("listCalendarEvents", () => {
  it("returns the week's Google events for the connection", async () => {
    feed(fixture("google.ics"));

    const result = await listCalendarEvents(connection(), week);

    expect(result.events.map((event) => event.title)).toEqual([
      "Release night",
      "Daily standup",
      "Offsite day",
      "Daily standup",
      "Vendor demo",
      "Daily standup (moved)",
      "Nordic kickoff",
      "Daily standup",
    ]);
  });

  it("returns the week's Outlook events", async () => {
    feed(fixture("outlook.ics"));

    const result = await listCalendarEvents(connection(), week);

    expect(result.events.map((event) => event.title)).toEqual([
      "Training",
      "Pay invoices",
      "1:1 with Maria",
      "Architecture review",
    ]);
  });

  it("returns the week's Exchange events, with the user's reply from their email", async () => {
    feed(fixture("exchange.ics"));

    const result = await listCalendarEvents(
      connection({ email: "Alex.Trepanier@contoso.com" }),
      week,
    );

    expect(
      result.events.find((event) => event.eventId === "exchange-sprint-review"),
    ).toMatchObject({ response: "accepted", isOrganizer: true });
    expect(
      result.events.find((event) => event.eventId === "exchange-other-team"),
    ).toMatchObject({ response: "unknown", isOrganizer: false });
  });

  it("says what is wrong with the feed", async () => {
    feed("<html></html>");

    await expect(listCalendarEvents(connection(), week)).rejects.toThrow(
      "did not return a calendar",
    );
  });
});
