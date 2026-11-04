// A test `ajour` global that enforces what the broker enforces from
// plugin.json, the endpoints and the headers, and answers from a responder:
// the fake MineHunter over HTTP, or a canned answer for an error class.
import { readFileSync } from "node:fs";
import type {
  Ajour,
  AjourRequestError,
  AjourRequestErrorCode,
  AjourResponse,
  PluginConnection,
  PluginHttpMethod,
} from "../src/contract.ts";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")) as {
  network: {
    auth: { header: string };
    endpoints: { method: string; path: string }[];
    requestHeaders: string[];
  };
};

export interface RecordedRequest {
  method: PluginHttpMethod;
  path: string;
  /** Header names lowercase. */
  headers: Record<string, string>;
}

export interface CannedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export type Responder = (request: RecordedRequest) => CannedResponse | Promise<CannedResponse>;

export interface FakeAjour extends Ajour {
  requests: RecordedRequest[];
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
 * A responder that forwards to the fake MineHunter the way the broker would:
 * with the personal token in X-ChronOps-Token, which the plugin never sees.
 */
export function forwardTo(url: string, token: string | undefined = "personal-token"): Responder {
  return async (request) => {
    const response = await fetch(`${url}${request.path}`, {
      method: request.method,
      headers: { ...request.headers, ...(token === undefined ? {} : { "X-ChronOps-Token": token }) },
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  };
}

function toResponse(canned: CannedResponse): AjourResponse {
  const text = canned.body ?? "";
  return {
    status: canned.status,
    ok: canned.status >= 200 && canned.status < 300,
    headers: Object.fromEntries(Object.entries(canned.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

export function createFakeAjour(respond: Responder): FakeAjour {
  const requests: RecordedRequest[] = [];
  const logs: FakeAjour["logs"] = [];
  const listed = new Set(manifest.network.requestHeaders.map((header) => header.toLowerCase()));
  const authHeader = manifest.network.auth.header.toLowerCase();
  return {
    requests,
    logs,
    async http(request) {
      const recorded: RecordedRequest = {
        method: request.method,
        path: request.path,
        headers: Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
      };
      requests.push(recorded);
      if (request.host !== undefined || request.connectionId !== connection.id) {
        throw requestError("refused", `No connection ${request.connectionId} on host ${request.host ?? "base"}.`);
      }
      if (!manifest.network.endpoints.some((endpoint) => endpoint.method === request.method && endpoint.path === request.path)) {
        throw requestError("refused", `The manifest allows no ${request.method} ${request.path}.`);
      }
      for (const name of Object.keys(recorded.headers)) {
        if (name === authHeader || name === "authorization" || !listed.has(name)) {
          throw requestError("refused", `The manifest doesn't list the ${name} header.`);
        }
      }
      return toResponse(await respond(recorded));
    },
    async publicFetch(url) {
      throw requestError("refused", `The manifest declares no public host for ${url}.`);
    },
    log(level, message, fields) {
      logs.push({ level, message, ...(fields ? { fields } : {}) });
    },
  };
}
