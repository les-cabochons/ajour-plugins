import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCalendarEvents, validateConnection } from "../src/plugin.ts";

const ADDRESS =
  "webcal://calendar.google.com/calendar/ical/me%40example.com/private-5f3a9c0d1e2f3a4b5c6d7e8f9a0b1c21e/basic.ics";
const google = readFileSync(new URL("./fixtures/google.ics", import.meta.url), "utf8");

function serve(body: string, status = 200) {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateConnection", () => {
  it("fetches the calendar and stores the https address and the email", async () => {
    const fetchMock = serve(google);

    await expect(
      validateConnection({ calendarUrl: ADDRESS, email: " Alex@Example.com " }),
    ).resolves.toEqual({
      normalizedConfig: {
        calendarUrl: ADDRESS.replace("webcal:", "https:"),
        email: "alex@example.com",
      },
      connectionSummary: {
        Calendar: "alex@example.com",
        "Time zone": "America/Toronto",
        Events: 9,
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses an invalid email and a missing address", async () => {
    serve(google);
    await expect(
      validateConnection({ calendarUrl: ADDRESS, email: "alex" }),
    ).rejects.toThrow("not a valid email address");
    await expect(validateConnection({})).rejects.toThrow(
      "Paste the calendar's ICS address",
    );
  });

  it("keeps the address out of the error when the calendar is gone", async () => {
    serve("gone", 404);
    const error = await validateConnection({ calendarUrl: ADDRESS }).catch(
      (reason: unknown) => reason as Error,
    );
    expect(error?.message).toContain("HTTP 404");
    expect(error?.message).not.toContain("private-5f3a");
  });
});

describe("listCalendarEvents", () => {
  it("returns the week's events for the connection", async () => {
    serve(google);

    const result = await listCalendarEvents(
      {
        id: "connection-1",
        pluginId: "ics",
        label: "Work",
        tenantLabel: "Google Calendar",
        autoSync: false,
        autoSyncIntervalMinutes: 15,
        connectedAt: 1,
        config: { calendarUrl: ADDRESS },
      },
      { from: "2026-10-12", to: "2026-10-18", timeZone: "America/Toronto" },
    );

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
});
