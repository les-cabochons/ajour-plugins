// The chronops plugin's entrypoint, one function per operation: the project
// source's validateConnection and syncProjects, and the time sync's
// syncTimeEntries. Each reaches MineHunter's ChronOps Forwarder through
// `ajour.http`, which attaches the personal token, so the plugin never holds it.
import type {
  PluginConnection,
  ProjectSourceSyncRequest,
  ProjectSourceSyncResult,
  ValidationContext,
  ValidationResult,
} from "@ajour/plugin-sdk";
import { parseChronopsMe, parseChronopsSnapshot } from "./chronops.ts";
import { PROJECT_SOURCE_BOUNDS } from "./contract.ts";
import { ChronopsError, forwarderGet, jsonBody } from "./forwarder.ts";
import { mapChronopsSnapshot } from "./snapshot.ts";

export { ChronopsError } from "./forwarder.ts";
export { syncTimeEntries } from "./time-sync.ts";

/** The date of an ISO instant, for the connection summary. */
function dateOf(instant: string) {
  const time = Date.parse(instant);
  return Number.isNaN(time) ? instant : new Date(time).toISOString().slice(0, 10);
}

/**
 * Asks the Forwarder who the token belongs to. The token's scope and expiry
 * come back on the connection page. Time entries writes, so while it is on,
 * or being turned on, a token that can only read is refused with a sentence
 * Ajour shows. Projects alone only read, so any token does for them.
 */
export async function validateConnection(
  connection: PluginConnection,
  context?: ValidationContext,
): Promise<ValidationResult> {
  const me = parseChronopsMe(await jsonBody(await forwarderGet(connection, "/integration/me")));
  if (me.scope === "read" && context?.capabilities.includes("timeSync")) {
    throw new ChronopsError(
      "Time entries need a read-write token, and this one can only read. Create a read-write token on your ChronOps profile and paste it here.",
    );
  }
  const connectionSummary: Record<string, string | number | boolean> = {
    Email: me.email,
    Scope: me.scope === "read" ? "Read" : "Read and write",
  };
  if (me.expiresAt !== null) connectionSummary["Token expires"] = dateOf(me.expiresAt);
  return { normalizedConfig: connection.config, connectionSummary };
}

/**
 * Reads the user's projects, tasks and budgets. The cursor is the last
 * answer's ETag, sent back as If-None-Match, so an unchanged snapshot costs
 * one 304. ChronOps builds the snapshot from its copies of Chronops' answers,
 * so a sync the user asked for adds sync=true, and ChronOps asks Chronops
 * again. The 15-minute sync leaves Chronops asleep.
 */
export async function syncProjects(
  connection: PluginConnection,
  request: ProjectSourceSyncRequest = {},
): Promise<ProjectSourceSyncResult> {
  const response = await forwarderGet(
    connection,
    "/integration/snapshot",
    request.cursor === undefined ? {} : { "If-None-Match": request.cursor },
    request.trigger === "manual" ? { sync: "true" } : undefined,
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
  // Ajour refuses the whole result for a cursor it cannot keep, so an ETag
  // that is empty or too long means no cursor: the next sync reads it all.
  const etag = response.headers["etag"];
  const cursor = etag && etag.length <= PROJECT_SOURCE_BOUNDS.cursor ? etag : undefined;
  return { snapshot, ...(cursor === undefined ? {} : { cursor }) };
}
