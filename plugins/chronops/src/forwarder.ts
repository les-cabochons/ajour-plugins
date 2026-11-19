// Requests to MineHunter's ChronOps Forwarder through `ajour.http`, which
// attaches the personal token, so the plugin never holds it. Each failure
// the user can act on becomes one plain message.
import type { AjourResponse, PluginConnection, PluginHttpMethod } from "@ajour/plugin-sdk";
import { isAjourRequestError } from "./contract.ts";

/** Every request names its integration, as the Forwarder's ADR-0030 asks. */
const SOURCE_HEADER = { "X-ChronOps-Source": "ajour" } as const;

/** A failure the connection page shows as is. Nothing is retried. */
export class ChronopsError extends Error {
  override name = "ChronopsError";
}

/**
 * A request the broker did not send, or that got no answer, which may work
 * later. `unreachable` is true when ChronOps did not answer at all, so the
 * next request would most likely wait for nothing too.
 */
export class ChronopsUnavailable extends ChronopsError {
  override name = "ChronopsUnavailable";
  readonly unreachable: boolean;

  constructor(message: string, unreachable: boolean) {
    super(message);
    this.unreachable = unreachable;
  }
}

/** The `error` field of a Forwarder or ChronOps refusal, when there is one. */
export async function refusalReason(response: AjourResponse) {
  try {
    const body = await response.json<{ error?: unknown }>();
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

export interface ForwarderRequest {
  method: PluginHttpMethod;
  path: string;
  query?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  json?: unknown;
}

/**
 * Sends one request to the Forwarder and returns its answer, whatever the
 * status, except for the two that concern the whole connection: a refused
 * token (401) and a forbidden request (403) throw a ChronopsError. A request
 * the broker did not send throws ChronopsUnavailable when it may work later,
 * and a ChronopsError when the manifest does not allow it.
 */
export async function forwarderRequest(connection: PluginConnection, request: ForwarderRequest): Promise<AjourResponse> {
  let response: AjourResponse;
  try {
    response = await ajour.http({
      connectionId: connection.id,
      method: request.method,
      path: request.path,
      ...(request.query === undefined ? {} : { query: request.query }),
      headers: {
        ...SOURCE_HEADER,
        ...(request.json === undefined ? {} : { "Content-Type": "application/json" }),
        ...request.headers,
      },
      ...(request.json === undefined ? {} : { body: JSON.stringify(request.json) }),
    });
  } catch (error) {
    if (!isAjourRequestError(error)) throw error;
    switch (error.code) {
      case "network":
      case "timeout":
        throw new ChronopsUnavailable("ChronOps could not be reached. Check the Forwarder URL and your network, then try again.", true);
      case "limit":
        throw new ChronopsUnavailable("Ajour sent ChronOps too many requests at once. Try again in a moment.", false);
      default:
        throw new ChronopsError(`Ajour refused the request to ChronOps. ${error.message}`);
    }
  }
  switch (response.status) {
    case 401:
      throw new ChronopsError(
        "ChronOps refused the personal token, which was revoked or expired. Create a new one on your ChronOps profile and paste it here.",
      );
    case 403: {
      const reason = await refusalReason(response);
      throw new ChronopsError(`ChronOps forbids this request${reason ? `. It said "${reason}"` : ""}.`);
    }
    default:
      return response;
  }
}

/**
 * A GET on the Forwarder, with each failure turned into a plain message:
 * a refused token, a forbidden request, the rate limit, a refusal with
 * ChronOps' reason, or no answer. A 304 comes back as is, for the snapshot's
 * cursor.
 */
export async function forwarderGet(
  connection: PluginConnection,
  path: string,
  headers: Readonly<Record<string, string>> = {},
  query?: Readonly<Record<string, string>>,
): Promise<AjourResponse> {
  const response = await forwarderRequest(connection, { method: "GET", path, headers, ...(query === undefined ? {} : { query }) });
  if (response.ok || response.status === 304) return response;
  if (response.status === 429) {
    throw new ChronopsError("ChronOps rate limited Ajour. The Forwarder allows 10 requests a second. Try again in a moment.");
  }
  const reason = await refusalReason(response);
  throw new ChronopsError(`ChronOps answered HTTP ${response.status}${reason ? `: "${reason}"` : ""}.`);
}

export async function jsonBody(response: AjourResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ChronopsError("ChronOps answered something that is not JSON. Check the Forwarder URL.");
  }
}
