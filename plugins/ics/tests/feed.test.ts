import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCalendarFeed } from "../src/feed.ts";
import {
  ADDRESS,
  CONNECTION_ID,
  SECRET,
  brokerError,
  feed,
  serveFeed,
} from "./support/ajour.ts";

// A byte order mark, and a character that takes three bytes in UTF-8.
const BOM = String.fromCharCode(0xfeff);
const EURO = String.fromCharCode(0x20ac);
const CALENDAR = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The error the fetch rejects with, checked never to hold the address. */
async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).not.toContain(SECRET);
  expect(message).not.toContain(ADDRESS);
  expect(message).not.toContain("calendar.google.com");
  return message;
}

describe("fetchCalendarFeed", () => {
  it("asks the broker for the connection's address with an empty path, and no address of its own", async () => {
    const fake = feed(`${BOM}${CALENDAR}`);

    await expect(fetchCalendarFeed(CONNECTION_ID)).resolves.toContain(
      "BEGIN:VCALENDAR",
    );

    expect(fake.requests).toEqual([
      {
        connectionId: CONNECTION_ID,
        method: "GET",
        path: "",
        headers: { accept: "text/calendar, */*;q=0.1" },
      },
    ]);
    expect(JSON.stringify(fake.requests)).not.toContain("http");
  });

  it.each([
    [401, "The calendar refused the address (HTTP 401)."],
    [403, "The calendar refused the address (HTTP 403)."],
    [404, "The calendar address no longer exists (HTTP 404)."],
    [410, "The calendar address no longer exists (HTTP 410)."],
    [429, "The calendar is limiting requests (HTTP 429). Try again in a few minutes."],
    [500, "The calendar service had an error (HTTP 500). Try again later."],
    [503, "The calendar service had an error (HTTP 503). Try again later."],
  ])("explains HTTP %i without repeating the address", async (status, wording) => {
    feed(`Not found: ${ADDRESS}`, { status });

    const message = await failure(fetchCalendarFeed(CONNECTION_ID));

    expect(message).toContain(wording);
  });

  it("tells a reset address to be copied again", async () => {
    feed("gone", { status: 404 });

    await expect(fetchCalendarFeed(CONNECTION_ID)).rejects.toThrow(
      "It may have been reset or unpublished. Copy the current address from your calendar's settings and update the connection.",
    );
  });

  it("names any other status", async () => {
    feed("", { status: 418 });

    await expect(fetchCalendarFeed(CONNECTION_ID)).rejects.toThrow(
      "The calendar address answered HTTP 418 instead of a calendar.",
    );
  });

  it("refuses a web page instead of a calendar", async () => {
    feed("<!doctype html><title>Sign in</title>");

    const message = await failure(fetchCalendarFeed(CONNECTION_ID));

    expect(message).toContain("did not return a calendar");
  });

  it("refuses an answer over the plugin's cap, even one the broker let through", async () => {
    feed(CALENDAR);
    await failure(fetchCalendarFeed(CONNECTION_ID, { maxBytes: 10 })).then(
      (message) => expect(message).toContain("larger than"),
    );

    // Three bytes a character: short in characters, long in bytes.
    feed(`BEGIN:VCALENDAR\r\n${EURO.repeat(10)}`);
    await failure(fetchCalendarFeed(CONNECTION_ID, { maxBytes: 40 })).then(
      (message) => expect(message).toContain("larger than"),
    );
  });

  it("caps the feed at 5 MB", async () => {
    feed(`BEGIN:VCALENDAR\r\n${"x".repeat(5 * 1024 * 1024)}`);

    await expect(fetchCalendarFeed(CONNECTION_ID)).rejects.toThrow(
      "The calendar is larger than 5 MB.",
    );
  });

  it("reads a feed just under the cap", async () => {
    feed(`BEGIN:VCALENDAR\r\n${"x".repeat(5 * 1024 * 1024 - 100)}`);

    await expect(fetchCalendarFeed(CONNECTION_ID)).resolves.toContain(
      "BEGIN:VCALENDAR",
    );
  });

  it("gives up after the timeout, cancelling the request", async () => {
    let cancelled = false;
    const fake = serveFeed(() => new Promise<never>(() => undefined));
    const http = fake.http.bind(fake);
    vi.stubGlobal("ajour", {
      ...fake,
      http: (request: Parameters<typeof http>[0]) => {
        request.signal?.addEventListener("abort", () => {
          cancelled = true;
        });
        return http(request);
      },
    });

    const message = await failure(fetchCalendarFeed(CONNECTION_ID, { timeoutMs: 20 }));

    expect(message).toBe(
      "The calendar took longer than 20 seconds to answer. Try again later.",
    );
    expect(cancelled).toBe(true);
  });

  it("uses a 20 second timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    feed(CALENDAR);

    await fetchCalendarFeed(CONNECTION_ID);

    expect(timeout).toHaveBeenCalledWith(20_000);
    timeout.mockRestore();
  });

  it("words the broker's own timeout the same way", async () => {
    serveFeed(() => {
      throw brokerError("timeout", "The service took too long to answer.");
    });

    await expect(fetchCalendarFeed(CONNECTION_ID)).rejects.toThrow(
      "The calendar took longer than 20 seconds to answer. Try again later.",
    );
  });

  it("words a service the broker could not reach without a code or an address", async () => {
    serveFeed(() => {
      throw brokerError("network", "The service couldn't be reached.");
    });

    const message = await failure(fetchCalendarFeed(CONNECTION_ID));

    expect(message).toBe(
      "Could not reach the calendar. Check your connection and the address.",
    );
  });

  it("words an answer over the broker's 8 MB cap as the calendar being too large", async () => {
    serveFeed(() => {
      throw brokerError("limit", "The service's answer is larger than 8 MB.");
    });

    await expect(fetchCalendarFeed(CONNECTION_ID)).rejects.toThrow(
      "The calendar is larger than 5 MB. Publish a smaller calendar",
    );
  });

  it("passes on what the broker refuses, such as a redirect it would not follow", async () => {
    serveFeed(() => {
      throw brokerError(
        "refused",
        "The connection's secret address redirected more than 3 times.",
      );
    });

    await expect(fetchCalendarFeed(CONNECTION_ID)).rejects.toThrow(
      "The connection's secret address redirected more than 3 times.",
    );
  });

  it("does not repeat an error it does not know", async () => {
    serveFeed(() => {
      throw new TypeError(`something broke for ${ADDRESS}`);
    });

    const message = await failure(fetchCalendarFeed(CONNECTION_ID));

    expect(message).toBe(
      "Could not reach the calendar. Check your connection and the address.",
    );
  });
});
