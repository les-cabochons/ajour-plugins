import { vi } from "vitest";
import type { PluginConnection, PluginManifest } from "@ajour/plugin-sdk";
import { createFakeAjour, type FakeAjour, type FakeResponseInit, type RecordedHttpRequest } from "@ajour/plugin-sdk/testing";
import manifestJson from "../../plugin.json";

/** The repository's own manifest: the fake refuses any request it does not declare, as Ajour's broker does. */
export const manifest = manifestJson as unknown as PluginManifest;

export const CONNECTION_ID = "connection-1";

/** The connection an API 4 operation receives: no token, which stays with Ajour's broker. */
export function pluginConnection(
  config: Record<string, string | number | boolean> = {},
  overrides: Partial<PluginConnection> = {},
): PluginConnection {
  return {
    id: CONNECTION_ID,
    pluginId: "github",
    label: "Work",
    tenantLabel: "Acme",
    autoSync: true,
    autoSyncIntervalMinutes: 5,
    connectedAt: 1,
    access: [],
    config: { hostUrl: "https://github.com", ...config },
    ...overrides,
  };
}

/** A request as a test reads it: the JSON body parsed. */
export interface SeenRequest {
  /** The derived host the request names: `rest` or `graphql`. */
  host: string | undefined;
  method: string;
  path: string;
  query: RecordedHttpRequest["query"];
  headers: Record<string, string>;
  contentType: string | undefined;
  body?: any;
  /** `GET rest /repos/acme/api/issues/7`, for assertions on a request list. */
  label: string;
}

export function json(body: unknown, status = 200): FakeResponseInit {
  return { status, json: body };
}

function seen(request: RecordedHttpRequest): SeenRequest {
  return {
    host: request.host,
    method: request.method,
    path: request.path,
    query: request.query,
    headers: request.headers,
    contentType: request.headers["content-type"],
    ...(request.bodyText !== undefined ? { body: JSON.parse(request.bodyText) } : {}),
    label: `${request.method} ${request.host ?? "base"} ${request.path}`,
  };
}

/**
 * Installs an `ajour` global that answers every endpoint of every derived host
 * the manifest declares with `respond`, and refuses the rest. `requests` lists
 * what the plugin sent that reached a route.
 */
export function installAjour(respond: (request: SeenRequest) => FakeResponseInit | Promise<FakeResponseInit>) {
  const requests: SeenRequest[] = [];
  const fake: FakeAjour = createFakeAjour({
    manifest,
    routes: (manifest.network?.derivedHosts ?? []).flatMap((host) =>
      host.endpoints.map((endpoint) => ({
        host: host.id,
        method: endpoint.method,
        path: endpoint.path,
        respond: (recorded: RecordedHttpRequest) => {
          const request = seen(recorded);
          requests.push(request);
          return respond(request);
        },
      })),
    ),
  });
  vi.stubGlobal("ajour", fake);
  return { requests, fake };
}

export interface GraphQLCall {
  query: string;
  variables: Record<string, unknown>;
}

/**
 * GitHub's GraphQL endpoint answered by `handler`, which returns the `data`
 * or an Error for GraphQL `errors`. REST answers `rest` when given, or `[]`.
 */
export function stubGitHub(
  handler: (call: GraphQLCall) => unknown,
  rest: (request: SeenRequest) => FakeResponseInit | Promise<FakeResponseInit> = () => json([]),
) {
  const calls: GraphQLCall[] = [];
  const installed = installAjour((request) => {
    if (request.host === "rest") return rest(request);
    const call = request.body as GraphQLCall;
    calls.push(call);
    const data = handler(call);
    return json(data instanceof Error ? { errors: [{ message: data.message }] } : { data });
  });
  return { calls, ...installed };
}
