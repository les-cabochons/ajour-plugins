/*
 * Fetches a calendar feed from its address. The address is a bearer secret:
 * anyone who has it can read the calendar. No error message built here may
 * contain it, and it is never sent anywhere but its own host.
 */

export const FEED_TIMEOUT_MS = 20_000;
export const MAX_FEED_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

export interface FetchFeedOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Accepts the https and webcal addresses calendars publish and returns the
 * https address to fetch. Outlook and Apple hand out webcal links.
 */
export function normalizeCalendarAddress(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Paste the calendar's ICS address.");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The calendar address is not a valid web address.");
  }
  if (url.protocol === "webcal:" || url.protocol === "webcals:") {
    url = new URL(`https:${url.href.slice(url.protocol.length)}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      "The calendar address must start with https:// or webcal://.",
    );
  }
  if (url.username || url.password) {
    throw new Error(
      "The calendar address must not contain a user name or password.",
    );
  }
  url.hash = "";
  return url.toString();
}

function statusMessage(status: number) {
  if (status === 401 || status === 403) {
    return `The calendar refused the address (HTTP ${status}). It may have been reset or unpublished. Copy the current address from your calendar's settings and update the connection.`;
  }
  if (status === 404 || status === 410) {
    return `The calendar address no longer exists (HTTP ${status}). It may have been reset or unpublished. Copy the current address from your calendar's settings and update the connection.`;
  }
  if (status === 429) {
    return "The calendar is limiting requests (HTTP 429). Try again in a few minutes.";
  }
  if (status >= 500) {
    return `The calendar service had an error (HTTP ${status}). Try again later.`;
  }
  return `The calendar address answered HTTP ${status} instead of a calendar.`;
}

async function readLimited(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(maxBytes);
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

function tooLarge(maxBytes: number) {
  return new Error(
    `The calendar is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. Publish a smaller calendar, or one with less detail.`,
  );
}

/** Returns the feed's text. Follows at most three redirects, all https. */
export async function fetchCalendarFeed(
  address: string,
  options: FetchFeedOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? FEED_TIMEOUT_MS);
  let url = normalizeCalendarAddress(address);

  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        signal,
        headers: { Accept: "text/calendar, */*;q=0.1" },
      });
    } catch (error) {
      if (signal.aborted) {
        throw new Error(
          "The calendar took longer than 20 seconds to answer. Try again later.",
        );
      }
      const code =
        error instanceof Error && "cause" in error
          ? (error.cause as { code?: unknown } | undefined)?.code
          : undefined;
      throw new Error(
        `Could not reach the calendar${typeof code === "string" ? ` (${code})` : ""}. Check your connection and the address.`,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("The calendar redirected without a new address.");
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new Error("The calendar redirected too many times.");
      }
      const next = new URL(location, url);
      if (next.protocol !== "https:") {
        throw new Error("The calendar redirected to an address without https.");
      }
      url = next.toString();
      continue;
    }

    if (!response.ok) {
      throw new Error(statusMessage(response.status));
    }

    const text = await readLimited(
      response,
      options.maxBytes ?? MAX_FEED_BYTES,
    );
    if (!/^\s*BEGIN:VCALENDAR/i.test(text.replace(/^﻿/, ""))) {
      throw new Error(
        "The address did not return a calendar. Use the ICS address, not the address of the calendar's web page.",
      );
    }
    return text;
  }
}
