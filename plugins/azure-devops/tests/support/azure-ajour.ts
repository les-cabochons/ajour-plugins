import { vi } from "vitest";
import type { PluginConnection, PluginManifest } from "@ajour/plugin-sdk";
import {
  createFakeAjour,
  type FakeAjour,
  type FakeHttpRoute,
  type FakeResponseInit,
  type RecordedHttpRequest,
} from "@ajour/plugin-sdk/testing";
import manifestJson from "../../plugin.json";

/** The repository's own manifest: the fake refuses any request it does not declare, as Ajour's broker does. */
export const manifest = manifestJson as unknown as PluginManifest;

export const CONNECTION_ID = "connection-1";
export const ORGANIZATION_URL = "https://dev.azure.com/contoso";

/** Every access choice the manifest declares, as a connection that turned them all on has them. */
export const ALL_ACCESS: string[] = (manifest.connectionAccess ?? []).map((choice) => choice.id);
/** A read-only connection: only the choice that is always on. */
export const READ_ONLY_ACCESS: string[] = (manifest.connectionAccess ?? [])
  .filter((choice) => choice.always)
  .map((choice) => choice.id);

/** The connection an API 4 operation receives: no token, which stays with Ajour's broker. */
export function pluginConnection(
  config: Record<string, string | number | boolean> = {},
  overrides: Partial<PluginConnection> = {},
): PluginConnection {
  return {
    id: CONNECTION_ID,
    pluginId: "azure_devops",
    label: "Contoso",
    tenantLabel: "Contoso Entra",
    autoSync: false,
    autoSyncIntervalMinutes: 15,
    connectedAt: 1,
    access: ALL_ACCESS,
    config: { organizationUrl: ORGANIZATION_URL, queryScope: "assigned_to_me", ...config },
    ...overrides,
  };
}

interface DerivedForm {
  whenHost?: string;
  host: string;
  pathPrefix?: string;
  keepBasePath?: boolean;
}

/** The address a derived host's requests go to for a base address, by the manifest's forms, as Ajour derives it. */
export function deriveAddress(forms: readonly DerivedForm[], baseAddress: string) {
  const base = new URL(baseAddress);
  const baseHost = base.hostname.toLowerCase();
  for (const form of forms) {
    let match = "";
    if (form.whenHost?.startsWith("*.")) {
      const suffix = `.${form.whenHost.slice(2)}`;
      match = baseHost.slice(0, -suffix.length);
      if (!baseHost.endsWith(suffix) || !match || match.includes(".")) continue;
    } else if (form.whenHost && form.whenHost !== baseHost) {
      continue;
    }
    const host = form.host.replaceAll("{host}", baseHost).replaceAll("{match}", match);
    const port = host === baseHost && base.port ? `:${base.port}` : "";
    const basePath = form.keepBasePath === false ? "" : base.pathname.replace(/\/+$/, "");
    return `${base.protocol}//${host}${port}${basePath}${form.pathPrefix ?? ""}`;
  }
  throw new Error(`No form applies to ${baseAddress}.`);
}

/** The URL the broker would build for a recorded request, from the base address. */
export function urlOf(request: RecordedHttpRequest, baseAddress = ORGANIZATION_URL) {
  const derived = request.host
    ? manifest.network?.derivedHosts?.find((candidate) => candidate.id === request.host)
    : undefined;
  const address = derived ? deriveAddress(derived.forms, baseAddress) : baseAddress.replace(/\/+$/, "");
  const url = new URL(`${address}${request.path}`);
  for (const [key, raw] of Object.entries(request.query ?? {})) {
    for (const value of Array.isArray(raw) ? raw : [raw]) url.searchParams.append(key, String(value));
  }
  return url;
}

/** A request as a fetch-style test handler reads it. Header names are lowercase. */
export interface FetchLikeInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type FetchLikeHandler = (url: string, init: FetchLikeInit) => Response | Promise<Response>;

async function fakeAnswer(response: Response): Promise<FakeResponseInit> {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

/** One route per endpoint the manifest declares, on the base address and each derived host. */
function manifestRoutes(respond: FakeHttpRoute["respond"]): FakeHttpRoute[] {
  const network = manifest.network;
  return [
    ...(network?.endpoints ?? []).map((endpoint) => ({ method: endpoint.method, path: endpoint.path, respond })),
    ...(network?.derivedHosts ?? []).flatMap((host) =>
      (host.endpoints ?? []).map((endpoint) => ({
        host: host.id,
        method: endpoint.method,
        path: endpoint.path,
        respond,
      })),
    ),
  ];
}

export interface InstallOptions {
  /** The access choices every connection turned on. Default: all of them. */
  access?: readonly string[];
  /** The Organization URL the broker builds addresses from. */
  baseAddress?: string;
}

/**
 * Installs the SDK's fake `ajour`, with this repository's manifest, so a
 * request outside it (an endpoint, a derived host, a header, or an endpoint
 * whose access choice is off) is refused as Ajour's broker refuses it. Every
 * request that passes is answered by `respond`. `requests` lists what the
 * plugin sent, refused ones included.
 */
export function installAjour(
  respond: (request: RecordedHttpRequest) => FakeResponseInit | Promise<FakeResponseInit>,
  options: InstallOptions = {},
) {
  const turnedOn = options.access ?? ALL_ACCESS;
  // The fake reads each connection's choices by id; every connection here turned on the same.
  const access = new Proxy({} as Record<string, readonly string[]>, { get: () => turnedOn });
  const fake: FakeAjour = createFakeAjour({ manifest, access, routes: manifestRoutes(respond) });
  vi.stubGlobal("ajour", fake);
  return fake;
}

/**
 * The fake `ajour`, answered by a fetch-style handler: it receives the URL the
 * broker would build and the request's method, lowercase headers and body, and
 * answers with a `Response`. `fetchMock` records each call as `[url, init]`,
 * as the tests read `fetch` calls before plugin API 4.
 */
export function stubAzureFetch(handler: FetchLikeHandler, options: InstallOptions = {}) {
  const fetchMock = vi.isMockFunction(handler) ? handler : vi.fn(handler);
  const fake = installAjour(async (request) => {
    const init: FetchLikeInit = {
      method: request.method,
      headers: request.headers,
      ...(request.bodyText !== undefined ? { body: request.bodyText } : {}),
    };
    return await fakeAnswer(await fetchMock(urlOf(request, options.baseAddress).href, init));
  }, options);
  return { fetchMock, fake, requests: fake.requests };
}

/** A request as an assertion names it: `PATCH /_apis/wit/workitems/42`, with `identities` before a derived host's path. */
export function label(request: RecordedHttpRequest) {
  return `${request.method} ${request.host ? `${request.host} ` : ""}${request.path}`;
}
