// A test `ajour` global that enforces what the broker enforces from
// plugin.json, the endpoints and the headers, and answers from a responder:
// the fake MineHunter over HTTP, or a canned answer for an error class.
import { readFileSync } from "node:fs";
import type {
  Ajour,
  AjourRequestError,
  AjourRequestErrorCode,
  AjourHttpRequest,
  AjourResponse,
  PluginConnection,
  PluginHttpMethod,
} from "@ajour/plugin-sdk";
import { routeMatches } from "@ajour/plugin-sdk/testing";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")) as {
  network: {
    auth: { header: string };
    endpoints: { method: string; path: string }[];
    requestHeaders: string[];
    publicHosts?: string[];
  };
};

export interface RecordedRequest {
  method: PluginHttpMethod;
  path: string;
  query?: AjourHttpRequest["query"];
  /** Header names lowercase. */
  headers: Record<string, string>;
  /** The JSON body, parsed, when there is one. */
  body?: unknown;
}

export interface CannedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export type Responder = (request: RecordedRequest) => CannedResponse | Promise<CannedResponse>;

export interface RecordedPublicRequest {
  method: string;
  url: string;
  /** Header names lowercase. */
  headers: Record<string, string>;
}

/** Answers what the plugin fetches with `ajour.publicFetch`, such as the change marker's HEAD. */
export type PublicResponder = (request: RecordedPublicRequest) => CannedResponse | Promise<CannedResponse>;

export interface FakeAjour extends Ajour {
  requests: RecordedRequest[];
  publicRequests: RecordedPublicRequest[];
  logs: { level: string; message: string; fields?: Record<string, unknown> }[];
}

export const connection: PluginConnection = {
  id: "c1",
  pluginId: "chronops",
  label: "ChronOps",
  tenantLabel: "Wepoint",
  autoSync: true,
  autoSyncIntervalMinutes: 15,
  connectedAt: 1_700_000_000_000,
  config: { label: "ChronOps", tenantLabel: "Wepoint", forwarderUrl: "https://chronops-forwarder.example.test" },
  access: [],
};

export function requestError(code: AjourRequestErrorCode, message = `The broker reported ${code}.`): AjourRequestError {
  return Object.assign(new Error(message), { name: "AjourRequestError" as const, code });
}

/** A responder that answers a fixed status and JSON body. */
export function answer(status: number, json?: unknown, headers: Record<string, string> = {}): Responder {
  return () => ({
    status,
    headers: json === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
}

/**
 * A responder that forwards to the fake MineHunter the way the broker would,
 * with the personal token in X-ChronOps-Token, which the plugin never sees.
 */
export function forwardTo(url: string, token: string | undefined = "personal-token"): Responder {
  return async (request) => {
    const query = new URLSearchParams(Object.entries(request.query ?? {}).map(([name, value]) => [name, String(value)]));
    const search = query.size > 0 ? `?${query}` : "";
    const response = await fetch(`${url}${request.path}${search}`, {
      method: request.method,
      headers: { ...request.headers, ...(token === undefined ? {} : { "X-ChronOps-Token": token }) },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  };
}

/** Header names lowercase, as Ajour hands them to the plugin. */
function lowercaseHeaders(headers: Readonly<Record<string, string>> = {}) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function toResponse(canned: CannedResponse): AjourResponse {
  const text = canned.body ?? "";
  return {
    status: canned.status,
    ok: canned.status >= 200 && canned.status < 300,
    headers: lowercaseHeaders(canned.headers),
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/** A public responder that answers the change marker's HEAD from the fake MineHunter. */
export function markerOf(fake: { marker: { head(ifNoneMatch?: string): CannedResponse } }): PublicResponder {
  return (request) => fake.marker.head(request.headers["if-none-match"]);
}

export function createFakeAjour(respond: Responder, publicRespond?: PublicResponder): FakeAjour {
  const requests: RecordedRequest[] = [];
  const publicRequests: RecordedPublicRequest[] = [];
  const logs: FakeAjour["logs"] = [];
  const listed = new Set(manifest.network.requestHeaders.map((header) => header.toLowerCase()));
  const authHeader = manifest.network.auth.header.toLowerCase();
  return {
    requests,
    publicRequests,
    logs,
    async http(request) {
      if (request.body !== undefined && typeof request.body !== "string") {
        throw new Error("The ChronOps plugin sends JSON bodies as strings.");
      }
      const recorded: RecordedRequest = {
        method: request.method,
        path: request.path,
        ...(request.query === undefined ? {} : { query: request.query }),
        headers: lowercaseHeaders(request.headers),
        ...(request.body === undefined ? {} : { body: JSON.parse(request.body) }),
      };
      requests.push(recorded);
      if (request.host !== undefined || request.connectionId !== connection.id) {
        throw requestError("refused", `No connection ${request.connectionId} on host ${request.host ?? "base"}.`);
      }
      if (!manifest.network.endpoints.some((endpoint) => endpoint.method === request.method && routeMatches(endpoint.path, request.path))) {
        throw requestError("refused", `The manifest allows no ${request.method} ${request.path}.`);
      }
      for (const name of Object.keys(recorded.headers)) {
        if (name === authHeader || name === "authorization" || !listed.has(name)) {
          throw requestError("refused", `The manifest doesn't list the ${name} header.`);
        }
      }
      return toResponse(await respond(recorded));
    },
    // As the broker does: https on the default port, an exact host plugin.json
    // declares, GET or HEAD, and only the headers it lists.
    async publicFetch(url, init = {}) {
      const recorded: RecordedPublicRequest = { method: init.method ?? "GET", url, headers: lowercaseHeaders(init.headers) };
      publicRequests.push(recorded);
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.port !== "" || !(manifest.network.publicHosts ?? []).includes(parsed.hostname)) {
        throw requestError("refused", `The manifest declares no public host for ${url}.`);
      }
      for (const name of Object.keys(recorded.headers)) {
        if (!listed.has(name)) throw requestError("refused", `The manifest doesn't list the ${name} header.`);
      }
      if (publicRespond === undefined) throw requestError("network", `Nothing answers ${parsed.hostname}.`);
      return toResponse(await publicRespond(recorded));
    },
    log(level, message, fields) {
      logs.push({ level, message, ...(fields ? { fields } : {}) });
    },
  };
}
