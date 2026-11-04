// The chronops plugin's entrypoint, one function per project source
// operation. Each reaches MineHunter's ChronOps Forwarder through `ajour.http`,
// which attaches the personal token, so the plugin never holds it.
import { parseChronopsMe, parseChronopsSnapshot } from "./chronops.ts";
import {
  isAjourRequestError,
  type AjourResponse,
  type PluginConnection,
  type PluginFieldValue,
  type ProjectSourceSyncRequest,
  type ProjectSourceSyncResult,
  type ValidationContext,
  type ValidationResult,
} from "./contract.ts";
import { mapChronopsSnapshot } from "./snapshot.ts";

/** Every request names its integration, as the Forwarder's ADR-0030 asks. */
const SOURCE_HEADER = { "X-ChronOps-Source": "ajour" } as const;

/** A failure the connection page shows as is. Nothing is retried. */
export class ChronopsError extends Error {
  override name = "ChronopsError";
}

/** The `error` field of a Forwarder or ChronOps refusal, when there is one. */
async function refusalReason(response: AjourResponse) {
  try {
    const body = await response.json<{ error?: unknown }>();
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A GET on the Forwarder, with each failure turned into a plain message:
 * a refused token, a forbidden request, the rate limit, or no answer. A 304
 * comes back as is, for the snapshot's cursor.
 */
async function forwarderGet(
  connection: PluginConnection,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<AjourResponse> {
  let response: AjourResponse;
  try {
    response = await ajour.http({
      connectionId: connection.id,
      method: "GET",
      path,
      headers: { ...SOURCE_HEADER, ...headers },
    });
  } catch (error) {
    if (!isAjourRequestError(error)) throw error;
    switch (error.code) {
      case "network":
      case "timeout":
        throw new ChronopsError("ChronOps could not be reached. Check the Forwarder URL and your network, then try again.");
      case "limit":
        throw new ChronopsError("Ajour sent ChronOps too many requests at once. Try again in a moment.");
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
    case 429:
      throw new ChronopsError("ChronOps rate limited Ajour. The Forwarder allows 10 requests a second. Try again in a moment.");
    default:
      if (response.ok || response.status === 304) return response;
      throw new ChronopsError(`ChronOps answered HTTP ${response.status}.`);
  }
}

async function jsonBody(response: AjourResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ChronopsError("ChronOps answered something that is not JSON. Check the Forwarder URL.");
  }
}

/** The date of an ISO instant, for the connection summary. */
function dateOf(instant: string) {
  const time = Date.parse(instant);
  return Number.isNaN(time) ? instant : new Date(time).toISOString().slice(0, 10);
}

/**
 * Asks the Forwarder who the token belongs to. The token's scope and expiry
 * come back on the connection page. A read-write token gets a warning,
 * since Ajour only reads.
 */
export async function validateConnection(
  connection: PluginConnection,
  _context?: ValidationContext,
): Promise<ValidationResult> {
  const me = parseChronopsMe(await jsonBody(await forwarderGet(connection, "/integration/me")));
  const connectionSummary: Record<string, PluginFieldValue> = {
    Email: me.email,
    Scope: me.scope === "read" ? "Read" : "Read and write",
  };
  if (me.expiresAt !== null) connectionSummary["Token expires"] = dateOf(me.expiresAt);
  const warnings =
    me.scope === "read-write"
      ? ["This token can also write time in ChronOps. Ajour only reads your projects, so create a read token on your ChronOps profile and use it here."]
      : [];
  // Ajour has no warnings channel on validation yet (les-cabochons/ajour#502,
  // story 2), so the summary carries the warning too, as a row people see today.
  if (warnings[0] !== undefined) connectionSummary["Warning"] = warnings[0];
  return {
    normalizedConfig: connection.config,
    connectionSummary,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Reads the user's projects, tasks and budgets. The cursor is the last
 * answer's ETag, sent back as If-None-Match, so an unchanged snapshot costs
 * one 304.
 */
export async function syncProjects(
  connection: PluginConnection,
  request: ProjectSourceSyncRequest = {},
): Promise<ProjectSourceSyncResult> {
  const response = await forwarderGet(
    connection,
    "/integration/ajour/snapshot",
    request.cursor === undefined ? {} : { "If-None-Match": request.cursor },
  );
  if (response.status === 304) {
    ajour.log("info", "ChronOps snapshot synced", { connectionId: connection.id, unchanged: true });
    return { unchanged: true };
  }
  const snapshot = mapChronopsSnapshot(parseChronopsSnapshot(await jsonBody(response)));
  ajour.log("info", "ChronOps snapshot synced", {
    connectionId: connection.id,
    unchanged: false,
    projects: snapshot.projects.length,
    tasks: snapshot.projects.reduce((count, project) => count + project.tasks.length, 0),
    hoursAvailable: snapshot.me?.hoursAvailable ?? false,
  });
  const cursor = response.headers["etag"];
  return { snapshot, ...(cursor === undefined ? {} : { cursor }) };
}
