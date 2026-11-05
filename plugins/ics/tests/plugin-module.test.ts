import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import manifest from "../plugin.json";
import { fixture } from "./support/ajour.ts";

/*
 * The source entrypoint, `src/plugin.ts`, loaded the way Ajour's worker loads a
 * plugin: as an ES module whose named exports are the operations, running with
 * a frozen `ajour` global and nothing else. The global here is a small
 * stand-in for the broker's secret address: it keeps the address the user
 * saved to itself, rewrites webcal:// to https://, follows up to three https
 * redirects to any host, and answers with the status, the headers without the
 * addresses and the body. It refuses what the manifest does not declare.
 */

const SECRET = "private-5f3a9c0d1e2f3a4b5c6d7e8f9a0b1c21e";
const SAVED = `webcal://calendar.google.com/calendar/ical/me%40example.com/${SECRET}/basic.ics`;
const CONNECTION_ID = "connection-1";

interface Page {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** The fixture web, by https address. An address not listed answers 404. */
let web: Record<string, Page> = {};
/** The addresses the stand-in fetched, in order. Only the stand-in sees them. */
let fetched: string[] = [];
/** What each `ajour.http` call from the plugin carried. */
let calls: Record<string, unknown>[] = [];
/** Everything that crossed back to the plugin. */
let crossed: string[] = [];

let moduleExports: Record<string, (...args: any[]) => Promise<any>>;

const FEED = "https://calendar.google.com/calendar/ical/me%40example.com/" + SECRET + "/basic.ics";

function redirectTo(location: string): Page {
  return { status: 302, headers: { location } };
}

function brokerError(code: string, message: string) {
  return Object.assign(new Error(message), { name: "AjourRequestError", code });
}

/** What Ajour's broker does for a secret address, in miniature. */
function installAjour() {
  const allowedHeaders = new Set(manifest.network.requestHeaders.map((header) => header.toLowerCase()));
  const http = async (request: {
    connectionId: string;
    host?: string;
    method: string;
    path: string;
    query?: unknown;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  }) => {
    calls.push({ ...request });
    if (request.connectionId !== CONNECTION_ID) throw brokerError("refused", "This plugin has no connection with that id.");
    if (request.host !== undefined || request.method !== "GET" || request.path !== "" || request.query !== undefined) {
      throw brokerError("refused", "A secret address takes only a GET with an empty path and no query.");
    }
    for (const name of Object.keys(request.headers ?? {})) {
      if (!allowedHeaders.has(name.toLowerCase())) {
        throw brokerError("refused", `The manifest doesn't list the ${name} header.`);
      }
    }

    let url = new URL(SAVED.replace(/^webcals?:\/\//i, "https://"));
    const visited: string[] = [];
    for (let redirects = 0; ; redirects += 1) {
      fetched.push(url.href);
      const page = web[url.href] ?? { status: 404, body: `Not found: ${url.href}` };
      const location = page.headers?.location;
      if (page.status >= 300 && page.status < 400 && location !== undefined) {
        const next = new URL(location, url);
        if (next.protocol !== "https:") {
          throw brokerError("refused", "The connection's secret address redirected to an address that isn't https.");
        }
        if (redirects >= 3) {
          throw brokerError("refused", "The connection's secret address redirected more than 3 times.");
        }
        url = next;
        visited.push(url.href);
        continue;
      }
      // The addresses it led to are scrubbed like the secret, and never given away.
      let payload = page.body ?? "";
      for (const address of [SAVED, FEED, ...visited, ...fetched]) payload = payload.replaceAll(address, "[secret]");
      payload = payload.replaceAll(SECRET, "[secret]");
      const headers = Object.freeze(
        Object.fromEntries(
          Object.entries(page.headers ?? {}).filter(([name]) => !["location", "content-location", "link", "refresh"].includes(name)),
        ),
      );
      crossed.push(payload, JSON.stringify(headers));
      return Object.freeze({
        status: page.status,
        ok: page.status >= 200 && page.status < 300,
        headers,
        text: async () => payload,
        json: async () => JSON.parse(payload),
      });
    }
  };
  Object.defineProperty(globalThis, "ajour", {
    value: Object.freeze({
      http,
      publicFetch: async () => {
        throw new Error("The plugin has no public hosts.");
      },
      log: () => undefined,
    }),
    configurable: true,
    enumerable: true,
  });
}

/** The connection as Ajour hands it to an API 4 operation: no secret field. */
function connection(config: Record<string, string | number | boolean> = {}) {
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

const week = { from: "2026-10-12", to: "2026-10-18", timeZone: "America/Toronto" };

beforeAll(async () => {
  // Installed before the import, as the worker defines `ajour` before it imports the plugin.
  installAjour();
  moduleExports = await import("../src/plugin.ts");
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "ajour");
});

beforeEach(() => {
  web = { [FEED]: { status: 200, headers: { "content-type": "text/calendar" }, body: fixture("google.ics") } };
  fetched = [];
  calls = [];
  crossed = [];
});

describe("the source entrypoint", () => {
  it("exports one function per operation the worker may call", () => {
    expect(Object.keys(moduleExports).sort()).toEqual(["listCalendarEvents", "validateConnection"]);
    for (const operation of Object.values(moduleExports)) expect(typeof operation).toBe("function");
  });
});

describe("the source entrypoint, run through a stand-in broker", () => {
  it("validates a feed saved as a webcal address, and keeps the address out of the result", async () => {
    const result = await moduleExports.validateConnection!(connection({ email: " Alex@Example.com " }), {
      capabilities: ["calendar"],
    });

    expect(result).toEqual({
      normalizedConfig: { email: "alex@example.com" },
      connectionSummary: { Calendar: "alex@example.com", "Time zone": "America/Toronto", Events: 9 },
    });
    expect(fetched).toEqual([FEED]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each([1, 2, 3])("loads a feed behind %i https redirect(s), and the plugin never receives an address", async (hops) => {
    const hosts = ["https://cdn1.example.net/a.ics", "https://cdn2.example.org/b.ics?token=t0k3n", "https://cdn3.example.com/c.ics"];
    const chain = [FEED, ...hosts.slice(0, hops)];
    for (let hop = 0; hop < hops; hop += 1) web[chain[hop]!] = redirectTo(chain[hop + 1]!);
    web[chain[hops]!] = {
      status: 200,
      headers: { "content-type": "text/calendar", "content-location": chain[hops]! },
      body: fixture("google.ics").replace("BEGIN:VCALENDAR", `BEGIN:VCALENDAR\r\nX-SOURCE:${chain[hops]}`),
    };

    const result = await moduleExports.listCalendarEvents!(connection(), week);

    expect(result.events.map((event: { title: string }) => event.title)).toContain("Release night");
    expect(fetched).toEqual(chain);
    // Everything the plugin was handed, and everything it returned.
    const seen = JSON.stringify([crossed, result, calls]);
    for (const address of [SECRET, "calendar.google.com", ...hosts, "token=t0k3n"]) {
      expect(seen).not.toContain(address);
    }
    expect(seen).not.toContain("example.net");
  });

  it("asks only for the connection with an empty path and the one header the manifest lists", async () => {
    await moduleExports.listCalendarEvents!(connection(), week);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      connectionId: CONNECTION_ID,
      method: "GET",
      path: "",
      headers: { Accept: "text/calendar, */*;q=0.1" },
    });
    expect(Object.keys(calls[0]!).sort()).toEqual(["connectionId", "headers", "method", "path", "signal"]);
  });

  it("answers a fourth redirect or one away from https with the broker's message, not an address", async () => {
    web[FEED] = redirectTo("https://cdn1.example.net/a.ics");
    web["https://cdn1.example.net/a.ics"] = redirectTo("https://cdn2.example.net/a.ics");
    web["https://cdn2.example.net/a.ics"] = redirectTo("https://cdn3.example.net/a.ics");
    web["https://cdn3.example.net/a.ics"] = redirectTo("https://cdn4.example.net/a.ics");

    await expect(moduleExports.listCalendarEvents!(connection(), week)).rejects.toThrow(
      "The connection's secret address redirected more than 3 times.",
    );

    web[FEED] = redirectTo("http://plain.example.net/a.ics");
    await expect(moduleExports.listCalendarEvents!(connection(), week)).rejects.toThrow(
      "redirected to an address that isn't https",
    );
  });

  it.each([
    [401, "The calendar refused the address (HTTP 401)."],
    [403, "The calendar refused the address (HTTP 403)."],
    [404, "The calendar address no longer exists (HTTP 404)."],
    [410, "The calendar address no longer exists (HTTP 410)."],
    [429, "The calendar is limiting requests (HTTP 429)."],
    [502, "The calendar service had an error (HTTP 502)."],
  ])("explains HTTP %i with the same wording, and no address", async (status, wording) => {
    web[FEED] = { status, body: `Nope: ${SAVED}` };

    const error = await moduleExports.validateConnection!(connection(), { capabilities: ["calendar"] }).catch(
      (reason: Error) => reason,
    );

    expect(error.message).toContain(wording);
    expect(error.message).not.toContain(SECRET);
  });

  it("refuses a web page instead of a calendar", async () => {
    web[FEED] = { status: 200, body: "<!doctype html><title>Sign in</title>" };

    await expect(moduleExports.listCalendarEvents!(connection(), week)).rejects.toThrow("did not return a calendar");
  });

  it("refuses a feed over 5 MB that the broker let through", async () => {
    web[FEED] = { status: 200, body: `BEGIN:VCALENDAR\r\n${"x".repeat(5 * 1024 * 1024)}` };

    await expect(moduleExports.listCalendarEvents!(connection(), week)).rejects.toThrow("larger than 5 MB");
  });

  it("reads Outlook and Exchange feeds", async () => {
    web[FEED] = { status: 200, body: fixture("outlook.ics") };
    const outlook = await moduleExports.listCalendarEvents!(connection(), week);
    expect(outlook.events.map((event: { title: string }) => event.title)).toContain("1:1 with Maria");

    web[FEED] = { status: 200, body: fixture("exchange.ics") };
    const exchange = await moduleExports.listCalendarEvents!(connection({ email: "alex.trepanier@contoso.com" }), week);
    expect(exchange.events.find((event: { eventId: string }) => event.eventId === "exchange-sprint-review")).toMatchObject({
      response: "accepted",
      isOrganizer: true,
    });
  });

  it("rejects an invalid email without asking the broker", async () => {
    await expect(moduleExports.listCalendarEvents!(connection({ email: "alex" }), week)).rejects.toThrow(
      "not a valid email address",
    );
    expect(calls).toEqual([]);
  });
});
