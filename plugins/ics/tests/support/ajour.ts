import { readFileSync } from "node:fs";
import type { PluginConnection, PluginManifest } from "@ajour/plugin-sdk";
import {
  createFakeAjour,
  type FakeHttpRoute,
  type FakeResponder,
  type FakeResponseInit,
} from "@ajour/plugin-sdk/testing";
import { vi } from "vitest";

/*
 * Shared setup for the tests that use the SDK's fake `ajour`. The fake gets
 * the repository's own plugin.json, so it refuses what Ajour's broker would: a
 * request that is not a GET with an empty path, a header the manifest does not
 * list.
 */

export const manifest = JSON.parse(
  readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"),
) as PluginManifest;

export const CONNECTION_ID = "connection-1";

/** The address the user saved. The plugin never receives it. */
export const SECRET = "private-5f3a9c0d1e2f3a4b5c6d7e8f9a0b1c21e";
export const ADDRESS = `webcal://calendar.google.com/calendar/ical/me%40example.com/${SECRET}/basic.ics`;

export function fixture(name: string) {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

/** Installs a fake `ajour` whose one route answers the feed request. */
export function serveFeed(respond: FakeResponder<unknown>) {
  const route: FakeHttpRoute = {
    method: "GET",
    path: "",
    respond: respond as FakeHttpRoute["respond"],
  };
  const fake = createFakeAjour({ manifest, routes: [route] });
  vi.stubGlobal("ajour", fake);
  return fake;
}

export function feed(body: string, init: Omit<FakeResponseInit, "body"> = {}) {
  return serveFeed({ status: 200, ...init, body });
}

/** The connection as Ajour hands it to an API 4 operation: no secret field. */
export function connection(
  config: Record<string, string | number | boolean> = {},
): PluginConnection {
  return {
    id: CONNECTION_ID,
    pluginId: "ics",
    label: "Work",
    tenantLabel: "Google Calendar",
    autoSync: false,
    autoSyncIntervalMinutes: 15,
    connectedAt: 1,
    access: [],
    config,
  };
}

/** What the broker rejects with when it does not send. */
export function brokerError(code: "refused" | "limit" | "timeout" | "network", message: string) {
  return Object.assign(new Error(message), {
    name: "AjourRequestError" as const,
    code,
  });
}
