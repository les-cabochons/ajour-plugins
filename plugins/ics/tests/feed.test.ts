import { describe, expect, it, vi } from "vitest";
import { fetchCalendarFeed, normalizeCalendarAddress } from "../src/feed.js";

const SECRET = "private-5f3a9c0d1e2f3a4b5c6d7e8f9a0b1c21e";
const ADDRESS = `https://calendar.google.com/calendar/ical/me%40example.com/${SECRET}/basic.ics`;
const CALENDAR = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

function respond(body: string, init: ResponseInit = {}) {
  return new Response(body, { status: 200, ...init });
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).not.toContain(SECRET);
  return message;
}

describe("calendar address", () => {
  it("turns webcal into https and drops the fragment", () => {
    expect(
      normalizeCalendarAddress(" webcal://outlook.office365.com/owa/calendar/a/b/calendar.ics#x "),
    ).toBe("https://outlook.office365.com/owa/calendar/a/b/calendar.ics");
  });

  it("refuses plain http, embedded credentials and non-addresses without echoing them", () => {
    expect(() => normalizeCalendarAddress(`http://example.com/${SECRET}.ics`)).toThrow(
      "must start with https:// or webcal://",
    );
    expect(() => normalizeCalendarAddress(`https://me:${SECRET}@example.com/a.ics`)).toThrow(
      "user name or password",
    );
    expect(() => normalizeCalendarAddress(SECRET)).toThrow("not a valid web address");
    expect(() => normalizeCalendarAddress("")).toThrow("Paste the calendar's ICS address");
  });
});

describe("fetchCalendarFeed", () => {
  it("returns the calendar after https redirects", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect("/calendar/ical/next.ics"))
      .mockResolvedValueOnce(respond(`﻿${CALENDAR}`));

    await expect(fetchCalendarFeed(ADDRESS, { fetchImpl })).resolves.toContain(
      "BEGIN:VCALENDAR",
    );
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "https://calendar.google.com/calendar/ical/next.ics",
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses a redirect to http and too many redirects", async () => {
    await failure(
      fetchCalendarFeed(ADDRESS, {
        fetchImpl: async () => redirect(`http://evil.example/${SECRET}`),
      }),
    ).then((message) => expect(message).toContain("without https"));

    await failure(
      fetchCalendarFeed(ADDRESS, {
        fetchImpl: async () => redirect("https://calendar.google.com/again.ics"),
      }),
    ).then((message) => expect(message).toContain("too many times"));
  });

  it("explains a reset address without repeating it", async () => {
    const message = await failure(
      fetchCalendarFeed(ADDRESS, {
        fetchImpl: async () => respond(`Not found: ${ADDRESS}`, { status: 404 }),
      }),
    );
    expect(message).toContain("no longer exists (HTTP 404)");
  });

  it("refuses a web page instead of a calendar", async () => {
    const message = await failure(
      fetchCalendarFeed(ADDRESS, {
        fetchImpl: async () => respond("<!doctype html><title>Sign in</title>"),
      }),
    );
    expect(message).toContain("did not return a calendar");
  });

  it("stops reading past the size limit, declared or streamed", async () => {
    await failure(
      fetchCalendarFeed(ADDRESS, {
        maxBytes: 10,
        fetchImpl: async () =>
          respond(CALENDAR, { headers: { "content-length": "999999999" } }),
      }),
    ).then((message) => expect(message).toContain("larger than"));

    await failure(
      fetchCalendarFeed(ADDRESS, {
        maxBytes: 10,
        fetchImpl: async () => respond(CALENDAR),
      }),
    ).then((message) => expect(message).toContain("larger than"));
  });

  it("gives up after the timeout", async () => {
    const message = await failure(
      fetchCalendarFeed(ADDRESS, {
        timeoutMs: 20,
        fetchImpl: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      }),
    );
    expect(message).toContain("longer than 20 seconds");
  });

  it("reports a network failure by its code only", async () => {
    const message = await failure(
      fetchCalendarFeed(ADDRESS, {
        fetchImpl: async () => {
          throw new TypeError(`fetch failed for ${ADDRESS}`, {
            cause: { code: "ENOTFOUND" },
          });
        },
      }),
    );
    expect(message).toBe(
      "Could not reach the calendar (ENOTFOUND). Check your connection and the address.",
    );
  });
});
