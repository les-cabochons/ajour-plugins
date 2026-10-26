import type {} from "@ajour/plugin-sdk/globals";

/*
 * Fetches a calendar feed through Ajour's broker. The feed's address is a
 * bearer secret: anyone who has it can read the calendar. It is the
 * connection's secret address, so the plugin never holds it. The plugin asks
 * for the feed with an empty path, and the broker builds the request from the
 * saved address (turning webcal:// into https://), follows up to three https
 * redirects to any host, and hands back the status, the headers and the body,
 * never the address the feed came from. No message built here can contain it.
 */

export const FEED_TIMEOUT_MS = 20_000;
/** The plugin's own cap. The broker refuses an answer over 8 MB before this. */
export const MAX_FEED_BYTES = 5 * 1024 * 1024;

export interface FetchFeedOptions {
  timeoutMs?: number;
  maxBytes?: number;
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

function tooLarge(maxBytes: number) {
  return new Error(
    `The calendar is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. Publish a smaller calendar, or one with less detail.`,
  );
}

function timedOut() {
  return new Error(
    "The calendar took longer than 20 seconds to answer. Try again later.",
  );
}

/**
 * What a request the broker did not send says. The broker's own messages are
 * fixed text that never holds the address, so the ones that tell the user what
 * to do (a redirect it refused, an address that is not an address) are kept.
 */
function brokerFailure(error: unknown, maxBytes: number) {
  const { name, code, message } = (error ?? {}) as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (name === "AjourRequestError" && typeof message === "string") {
    if (code === "timeout") return timedOut();
    if (code === "limit" && /larger than/.test(message)) {
      return tooLarge(maxBytes);
    }
    if (code === "refused" || code === "limit") return new Error(message);
  }
  return new Error(
    "Could not reach the calendar. Check your connection and the address.",
  );
}

/** Returns the feed's text, or throws an error that never holds the address. */
export async function fetchCalendarFeed(
  connectionId: string,
  options: FetchFeedOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_FEED_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? FEED_TIMEOUT_MS);

  let response: Awaited<ReturnType<typeof ajour.http>>;
  try {
    response = await ajour.http({
      connectionId,
      method: "GET",
      path: "",
      headers: { Accept: "text/calendar, */*;q=0.1" },
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw timedOut();
    throw brokerFailure(error, maxBytes);
  }

  if (!response.ok) {
    throw new Error(statusMessage(response.status));
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal.aborted) throw timedOut();
    throw brokerFailure(error, maxBytes);
  }
  // A string is never shorter in UTF-8 than it is long, so only a feed near
  // the cap needs its bytes counted.
  if (
    text.length > maxBytes ||
    (text.length * 3 > maxBytes &&
      new TextEncoder().encode(text).byteLength > maxBytes)
  ) {
    throw tooLarge(maxBytes);
  }
  if (!/^\s*BEGIN:VCALENDAR/i.test(text.replace(/^﻿/, ""))) {
    throw new Error(
      "The address did not return a calendar. Use the ICS address, not the address of the calendar's web page.",
    );
  }
  return text;
}
