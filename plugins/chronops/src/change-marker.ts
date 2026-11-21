// MineHunter's change marker (ChronOps ADR-0050): an empty blob per person in
// Azure Storage that every write of their Time Entries overwrites, so its
// ETag changes. The plugin reads a link to the person's marker from the
// Forwarder, keeps it in the cursor Ajour holds between calls, and checks
// the ETag with HEAD, which never reaches the Forwarder. It lists through
// the Forwarder only when the ETag moved, or when it can't tell.
import type { PluginConnection } from "@ajour/plugin-sdk";
import { forwarderRequest, jsonBody } from "./forwarder.ts";

/** The blob host plugin.json declares in publicHosts: MineHunter's markers account. */
export const MARKER_HOST = "stchronopsmarkers.blob.core.windows.net";
const MARKER_ROUTE = "/integration/change-marker";

const MINUTE_MS = 60_000;
/** A link this close to its expiry is replaced before the next check. */
const LINK_MARGIN_MS = 60 * MINUTE_MS;
/** Lists at least this often, so a marker write that failed can't hide a change for long. */
export const LIST_AT_LEAST_EVERY_MS = 60 * MINUTE_MS;
/** Without a marker to check, lists at most this often, as Ajour's poll did. */
export const LIST_AT_MOST_EVERY_MS = MINUTE_MS;
/** After MineHunter gave no link, asks again only after this long. */
const LINK_RETRY_MS = 15 * MINUTE_MS;

/**
 * What the plugin keeps in Ajour's cursor. Ajour holds it in memory only,
 * since `link` reads the marker until `expiresAt`.
 */
export interface MarkerCursor {
  v: 1;
  /** The window and time zone the last listing covered. */
  window: string;
  /** When the plugin last listed, in epoch milliseconds. */
  listedAt: number;
  /** The read-only link to the person's marker, and when it expires. */
  link?: string;
  expiresAt?: number;
  /**
   * The marker's ETag read just before the last listing; null when the blob
   * didn't exist yet, absent when it couldn't be read.
   */
  etag?: string | null;
  /** When to ask MineHunter for a link again, after it gave none. */
  retryLinkAt?: number;
}

/** The cursor's window: the dates and the time zone a listing covers. */
export function windowKey(request: { from: string; to: string; timeZone: string }) {
  return `${request.from}/${request.to}/${request.timeZone}`;
}

export function encodeCursor(cursor: MarkerCursor) {
  return JSON.stringify(cursor);
}

/** The cursor Ajour sent back, or undefined when there is none or it isn't one of this plugin's. */
export function decodeCursor(raw: string | undefined): MarkerCursor | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<MarkerCursor>;
    if (value.v !== 1 || typeof value.window !== "string" || typeof value.listedAt !== "number") return undefined;
    // A link must point at the declared host; anything else is dropped, and the plugin asks for a new one.
    if (value.link !== undefined && !usableLink(value.link)) {
      const { link: _link, expiresAt: _expiresAt, etag: _etag, ...rest } = value;
      return rest as MarkerCursor;
    }
    return value as MarkerCursor;
  } catch {
    return undefined;
  }
}

/** A link the plugin may use: https on the declared host, never another address. */
function usableLink(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === MARKER_HOST;
  } catch {
    return false;
  }
}

/**
 * Asks the Forwarder for a link to the token owner's marker. MineHunter
 * without the route, with the markers off (503), or with a link on another
 * host gives none, and so does any failure: the plugin then lists as before.
 */
async function fetchLink(connection: PluginConnection): Promise<{ link: string; expiresAt: number } | undefined> {
  try {
    const response = await forwarderRequest(connection, { method: "GET", path: MARKER_ROUTE });
    if (response.status !== 200) return undefined;
    const body = (await jsonBody(response)) as { url?: unknown; expiresAt?: unknown };
    const expiresAt = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
    if (!usableLink(body.url) || Number.isNaN(expiresAt)) return undefined;
    return { link: body.url, expiresAt };
  } catch {
    return undefined;
  }
}

type MarkerReading = { kind: "same" } | { kind: "moved"; etag: string | null } | { kind: "unreadable" };

/**
 * Reads the marker with HEAD. With `known`, the ETag the last listing saw,
 * it answers whether the marker is still there: 304, the same ETag, or a
 * blob still missing. A blob that doesn't exist yet reads as a null ETag.
 */
async function readMarker(link: string, known?: string | null): Promise<MarkerReading> {
  try {
    const response = await ajour.publicFetch(link, {
      method: "HEAD",
      headers: typeof known === "string" ? { "If-None-Match": known } : {},
    });
    if (response.status === 304) return { kind: "same" };
    if (response.status === 404) return known === null ? { kind: "same" } : { kind: "moved", etag: null };
    const etag = response.headers.etag;
    if (response.status !== 200 || etag === undefined) return { kind: "unreadable" };
    return etag === known ? { kind: "same" } : { kind: "moved", etag };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Whether a check round may answer unchanged without listing: Ajour sent
 * the cursor of a listing of the same window, under an hour old, and the
 * marker didn't move since. Without a marker to read, it waits a minute
 * after the last listing, as Ajour's poll did. A cursor that never had a
 * link lists now, and sets the marker up.
 */
export async function nothingChangedSince(cursor: MarkerCursor, window: string, now: number) {
  const age = now - cursor.listedAt;
  if (cursor.window !== window || age >= LIST_AT_LEAST_EVERY_MS || age < 0) return false;
  if (cursor.retryLinkAt !== undefined) return now < cursor.retryLinkAt && age < LIST_AT_MOST_EVERY_MS;
  if (cursor.link === undefined || cursor.expiresAt === undefined || cursor.expiresAt - now < LINK_MARGIN_MS) return false;
  if (cursor.etag === undefined) return age < LIST_AT_MOST_EVERY_MS;
  const reading = await readMarker(cursor.link, cursor.etag);
  if (reading.kind === "unreadable") return age < LIST_AT_MOST_EVERY_MS;
  return reading.kind === "same";
}

/**
 * The marker part of the next cursor, read just before a listing, so a
 * write that lands during the listing moves the marker after it: the link
 * from the cursor while it lasts, or a new one, and the marker's ETag now.
 * Without a link, the cursor says when to ask again.
 */
export async function markerBeforeListing(
  connection: PluginConnection,
  cursor: MarkerCursor,
  now: number,
): Promise<Pick<MarkerCursor, "link" | "expiresAt" | "etag" | "retryLinkAt">> {
  let link = cursor.link;
  let expiresAt = cursor.expiresAt;
  if (link === undefined || expiresAt === undefined || expiresAt - now < LINK_MARGIN_MS) {
    if (cursor.retryLinkAt !== undefined && now < cursor.retryLinkAt) return { retryLinkAt: cursor.retryLinkAt };
    const fetched = await fetchLink(connection);
    if (fetched === undefined) return { retryLinkAt: now + LINK_RETRY_MS };
    ({ link, expiresAt } = fetched);
  }
  const reading = await readMarker(link);
  return reading.kind === "moved" ? { link, expiresAt, etag: reading.etag } : { link, expiresAt };
}
