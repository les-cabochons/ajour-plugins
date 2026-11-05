// A copy of the parts of Ajour's plugin API 4 contract this plugin uses. The
// SDK is not published yet, so the plugin keeps its own copy, as the other
// plugins of this repository do, and never imports Ajour code.
// Reference: Ajour's packages/plugin-sdk, and les-cabochons/ajour#502 for
// the project source snapshot.

export type PluginFieldValue = string | number | boolean;
export type PluginFieldValues = Record<string, PluginFieldValue>;

/** The connection each operation receives, without its secret fields. */
export interface PluginConnection {
  id: string;
  pluginId: string;
  label: string;
  tenantLabel: string;
  autoSync: boolean;
  autoSyncIntervalMinutes: number;
  connectedAt: number;
  lastSyncAt?: number;
  /** Only the fields that are not secret. The token never reaches the plugin. */
  config: PluginFieldValues;
  /** The access choices the connection turned on. This plugin declares none. */
  access: string[];
}

/** The second argument of `validateConnection`, the capabilities that are on. */
export interface ValidationContext {
  capabilities: string[];
}

export interface ValidationResult {
  normalizedConfig: PluginFieldValues;
  connectionSummary?: Record<string, PluginFieldValue>;
  /** What the connection page should warn about, such as a token with more rights than needed. */
  warnings?: string[];
}

// The project source capability, les-cabochons/ajour#502. Ajour shows
// `source.label` wherever it names the source and never hard-codes a product.

export interface ProjectSourceSnapshot {
  source: { label: string; url?: string };
  /** When the source's hours are from, ISO 8601. */
  asOf: string;
  /** Whether the source knows the user's own hours, and why not when it does not. */
  me?: { hoursAvailable: boolean; hoursNote?: string };
  projects: ProjectSourceProject[];
}

export interface ProjectSourceProject {
  remoteId: string;
  name: string;
  code: string;
  url?: string;
  client?: string;
  complete: boolean;
  /** YYYY-MM-DD. */
  startsOn?: string;
  /** YYYY-MM-DD. */
  endsOn?: string;
  budget?: ProjectSourceBudget;
  tasks: ProjectSourceTask[];
}

/** The source's own health reading of a budget. */
export type ProjectSourceBudgetStatus = "ok" | "warning" | "over" | "unknown";

export interface ProjectSourceBudget {
  unit: "hours" | "money";
  total?: number;
  consumed: number;
  /** May be negative. `status` says whether that is over. */
  remaining?: number;
  status?: ProjectSourceBudgetStatus;
}

export interface ProjectSourceTask {
  remoteId: string;
  name: string;
  /** How the source groups the project's tasks, such as a phase. */
  group?: string;
  closed: boolean;
  billable?: boolean;
  estimateHours?: number;
  assigned: boolean;
  myHours?: number;
}

/**
 * Ajour's bounds on a snapshot, as les-cabochons/ajour#558 shipped them. Text
 * bounds are in characters; `projects` and `tasks` count one snapshot's.
 */
export const PROJECT_SOURCE_BOUNDS = {
  label: 80,
  remoteId: 100,
  name: 240,
  code: 120,
  group: 120,
  client: 240,
  hoursNote: 300,
  url: 500,
  projects: 200,
  tasks: 10_000,
} as const;

export interface ProjectSourceSyncRequest {
  /** The cursor the last sync returned, opaque to Ajour. An ETag for ChronOps. */
  cursor?: string;
}

export type ProjectSourceSyncResult =
  | { snapshot: ProjectSourceSnapshot; cursor?: string }
  | { unchanged: true };

// The `ajour` global, the plugin's one way to the network. Ajour's broker
// builds the URL from the connection's base address and attaches the token.

export type PluginHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AjourHttpRequest {
  connectionId: string;
  host?: string;
  method: PluginHttpMethod;
  /** A path the manifest's endpoints allow, relative to the base address. */
  path: string;
  query?: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>;
  /** Only headers the manifest lists. The broker sets the auth header. */
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array | ArrayBuffer;
  signal?: AbortSignal;
}

/** An answer, read whole. Header names are lowercase. */
export interface AjourResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string>>;
  text(): Promise<string>;
  json<Value = unknown>(): Promise<Value>;
}

/**
 * Why the broker did not send a request: `refused` when the manifest does
 * not allow it, `limit` when too large or frequent, `timeout`, or `network`
 * when the service could not be reached.
 */
export type AjourRequestErrorCode = "refused" | "limit" | "timeout" | "network";

export interface AjourRequestError extends Error {
  name: "AjourRequestError";
  code: AjourRequestErrorCode;
}

export type AjourLogLevel = "debug" | "info" | "warn" | "error";
export type AjourLogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface Ajour {
  http(request: AjourHttpRequest): Promise<AjourResponse>;
  publicFetch(url: string, init?: { method?: "GET" | "HEAD"; headers?: Readonly<Record<string, string>>; signal?: AbortSignal }): Promise<AjourResponse>;
  /** Fields hold ids and counts, never content or secrets. */
  log(level: AjourLogLevel, message: string, fields?: AjourLogFields): void;
}

declare global {
  var ajour: Ajour;
}

export function isAjourRequestError(error: unknown): error is AjourRequestError {
  return error instanceof Error && error.name === "AjourRequestError";
}
