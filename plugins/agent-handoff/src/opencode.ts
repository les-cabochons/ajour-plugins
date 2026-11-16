// Hands backlog items off to OpenCode through the HTTP server the user runs
// with `opencode serve`, on this computer. The server's address is the
// connection's, and every request goes through Ajour's credential broker
// (`ajour.http`): the plugin names a path, never a URL. A start creates a
// session with a title and sends the prompt in the request body; a refresh
// reads the server's status map and its pending permission and question
// lists, once each, and asks about a stopped session only. Open runs
// `opencode attach <address> -s <session>` in a terminal, where Ajour fills
// the address from the connection.
import type {
  AjourResponse,
  DetectToolsResult,
  PluginConnection,
  ReadHandoffStatesRequest,
  ReadHandoffStatesResult,
  StartHandoffRequest,
  StartHandoffResult,
  ValidationResult,
} from "@ajour/plugin-sdk";
import {
  READ_DEADLINE_MS,
  START_DEADLINE_MS,
  ToolError,
  before,
  capture,
  each,
  firstLine,
  isLate,
  oneLineTitle,
  previousState,
  reasonOf,
  record,
  refusalsFor,
  settingText,
  text,
  withNotes,
  type Handoff,
  type Json,
  type Native,
  type State,
  type Tool,
  type Update,
} from "./shared.ts";

export const OPENCODE_TOOL = "opencode";
/** The first version whose v1 API the plugin was tested on. */
export const MIN_VERSION = [1, 19, 5] as const;
const MIN_TEXT = MIN_VERSION.join(".");
// A session id goes in a request path and in a declared command's id slot.
const SESSION_ID = /^ses_[A-Za-z0-9]{1,100}$/;
// Reads of stopped sessions run at most this many at a time.
const READ_CONCURRENCY = 4;
// Right after `prompt_async`, the status map is still empty for a moment,
// so a session whose last message is the prompt counts as starting this long.
export const STARTING_MS = 60_000;

const LABELS: Record<State, string> = {
  working: "Working",
  "needs-you": "Waiting for you",
  ready: "Ready for review",
  done: "Done",
  failed: "Failed",
  gone: "Deleted in OpenCode",
  unknown: "Unknown",
};

export const NEEDS_CONNECTION =
  "OpenCode needs a connection to its server. Add one on this plugin's page, and pick it in OpenCode's settings.";
export const SERVER_DOWN =
  "OpenCode's server isn't answering at this connection's address. Start it in the repository folder with opencode serve --hostname 127.0.0.1 --port 4096, or check the address.";
export const NOT_OPENCODE =
  "The server at this connection's address doesn't answer like OpenCode. Check the address, and that opencode serve runs there.";
export const NO_V1_API = `This OpenCode server doesn't have the API Ajour uses. Ajour hands off to OpenCode ${MIN_TEXT} or a later 1.x version.`;
export const PASSWORD =
  "OpenCode's server asks for a password. Ajour reaches a server without one: start opencode serve on 127.0.0.1 without OPENCODE_SERVER_PASSWORD.";
export const NO_ANSWER =
  "OpenCode stopped without answering. Open the session to see why, such as a model it can't reach.";

const opencode: Tool = {
  name: "OpenCode",
  exe: "opencode",
  // The plugin runs only `opencode --version`; Ajour runs Open's attach.
  refusals: refusalsFor("OpenCode", "opencode", {
    invalid_request: "Ajour refused a value for opencode.",
    output_limit: "OpenCode printed more than Ajour accepts.",
  }),
  late: "OpenCode took too long; refreshing again later.",
  failureLine(value) {
    return firstLine(value).replace(/^error:\s*/i, "");
  },
  explain(message) {
    return message;
  },
};

interface RequestError {
  name: "AjourRequestError";
  code: string;
  message: string;
}

function isRequestError(error: unknown): error is RequestError {
  return (
    error instanceof Error &&
    error.name === "AjourRequestError" &&
    "code" in error &&
    typeof error.code === "string"
  );
}

/** Why the broker didn't send a request, as what the user can do. */
function requestRefusal(error: RequestError): ToolError {
  switch (error.code) {
    case "network":
      return new ToolError(SERVER_DOWN, "network");
    case "timeout":
      return new ToolError(
        "OpenCode's server didn't answer in time. Try again.",
        "timeout",
      );
    case "limit":
      return new ToolError(
        "Ajour is limiting this plugin's requests to OpenCode. Try again in a minute.",
        "limit",
      );
    default: {
      const reason = firstLine(error.message);
      return new ToolError(
        `Ajour refused the request to OpenCode's server.${reason ? ` ${reason}` : ""}`,
        error.code,
      );
    }
  }
}

interface Call {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, number>;
  body?: unknown;
}

/** Sends one request to the connection's server, or throws what to do. */
async function send(
  connection: PluginConnection,
  call: Call,
): Promise<AjourResponse> {
  try {
    return await ajour.http({
      connectionId: connection.id,
      method: call.method,
      path: call.path,
      ...(call.query ? { query: call.query } : {}),
      ...(call.body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(call.body),
          }),
    });
  } catch (error) {
    if (isRequestError(error)) throw requestRefusal(error);
    throw error;
  }
}

/** OpenCode's own reason for an error answer, such as `Session not found`. */
async function serverReason(response: AjourResponse): Promise<string> {
  try {
    const body = record(await response.json());
    const data = record(body?.data);
    return firstLine(text(data?.message, 2000) ?? text(body?.message, 2000));
  } catch {
    return "";
  }
}

/** Throws what the user can do about an answer that isn't a success. */
async function failed(
  response: AjourResponse,
  v1Route: boolean,
): Promise<never> {
  if (response.status === 401) throw new ToolError(PASSWORD);
  if (response.status === 404 && v1Route) throw new ToolError(NO_V1_API);
  const reason = await serverReason(response);
  throw new ToolError(
    `OpenCode's server answered HTTP ${response.status}${reason ? `: ${reason}` : "."}`,
  );
}

async function json(response: AjourResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ToolError("OpenCode returned an answer Ajour can't read.");
  }
}

/** A GET of one of the v1 API's fixed routes, read as JSON. */
async function getJson(
  connection: PluginConnection,
  path: string,
): Promise<unknown> {
  const response = await send(connection, { method: "GET", path });
  if (!response.ok) await failed(response, true);
  return json(response);
}

/** The version in `1.19.5` form, or undefined for another form. */
function versionParts(version: string): number[] | undefined {
  const match =
    /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+.][0-9A-Za-z.+-]*)?$/.exec(
      version,
    );
  return match ? match.slice(1, 4).map(Number) : undefined;
}

/** Why Ajour can't hand off to this version, or undefined when it can. */
export function versionProblem(version: string): string | undefined {
  const parts = versionParts(version);
  if (!parts)
    return `OpenCode reported a version Ajour can't read: ${version}.`;
  const [major, minor, patch] = parts as [number, number, number];
  if (major > 1)
    return `OpenCode ${version} isn't supported yet. Ajour hands off to OpenCode ${MIN_TEXT} or a later 1.x version.`;
  const [minMajor, minMinor, minPatch] = MIN_VERSION;
  const older =
    major < minMajor ||
    (major === minMajor &&
      (minor < minMinor || (minor === minMinor && patch < minPatch)));
  if (older)
    return `OpenCode ${version} is older than ${MIN_TEXT}, the first version Ajour supports. Run opencode upgrade, then restart opencode serve.`;
  return undefined;
}

/** Asks the server what it is, and returns its version if Ajour supports it. */
async function serverVersion(connection: PluginConnection): Promise<string> {
  const response = await send(connection, {
    method: "GET",
    path: "/global/health",
  });
  if (response.status === 401) throw new ToolError(PASSWORD);
  if (!response.ok) throw new ToolError(NOT_OPENCODE);
  let health: Json | undefined;
  try {
    health = record(await response.json());
  } catch {
    throw new ToolError(NOT_OPENCODE);
  }
  const version = text(health?.version, 100);
  if (health?.healthy !== true || !version) throw new ToolError(NOT_OPENCODE);
  const problem = versionProblem(version);
  if (problem) throw new ToolError(problem);
  return version;
}

function requireConnection(
  connection: PluginConnection | undefined,
): PluginConnection {
  if (!connection) throw new ToolError(NEEDS_CONNECTION);
  return connection;
}

/**
 * Whether OpenCode can take a handoff through this connection: its server
 * answers with a version Ajour supports, and `opencode`, which Open runs, is
 * on PATH.
 */
export async function detectOpenCode(
  connection: PluginConnection | undefined,
): Promise<DetectToolsResult["tools"][number]> {
  try {
    const server = requireConnection(connection);
    // The server's reason comes first: it is what the user fixes first.
    const [version, cli] = await Promise.allSettled([
      serverVersion(server),
      capture(opencode, "opencode-version", {}),
    ]);
    if (version.status === "rejected") throw version.reason;
    if (cli.status === "rejected") throw cli.reason;
    return { id: OPENCODE_TOOL, available: true, version: version.value };
  } catch (error) {
    return {
      id: OPENCODE_TOOL,
      available: false,
      reason: reasonOf(opencode, error),
    };
  }
}

/** Checks a connection before Ajour saves it: its server is OpenCode. */
export async function validateOpenCode(
  connection: PluginConnection,
): Promise<ValidationResult> {
  try {
    const version = await serverVersion(connection);
    return {
      normalizedConfig: connection.config,
      connectionSummary: { Server: `OpenCode ${version}` },
    };
  } catch (error) {
    throw new Error(reasonOf(opencode, error));
  }
}

/** `provider/model`, as OpenCode's prompt takes a model. */
export function modelOf(
  value: unknown,
): { providerID: string; modelID: string } | undefined {
  const model = settingText(value);
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1)
    throw new ToolError(
      "Write OpenCode's model as provider/model, such as anthropic/claude-sonnet-4-5.",
    );
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

export async function startOpenCode(
  connection: PluginConnection | undefined,
  request: StartHandoffRequest,
): Promise<StartHandoffResult> {
  const deadline = Date.now() + START_DEADLINE_MS;
  const server = requireConnection(connection);
  if (!request.prompt.trim())
    throw new ToolError("The prompt is empty. Check the handoff template.");
  const model = modelOf(request.settings.model);
  const agent = settingText(request.settings.agent);
  const title = oneLineTitle(request.title);
  const step = <T>(work: () => Promise<T>) => before(opencode, deadline, work);
  const reason = (error: unknown) =>
    isLate(error)
      ? "OpenCode's server didn't answer in time. Try again."
      : reasonOf(opencode, error);
  try {
    await step(() => serverVersion(server));
  } catch (error) {
    throw new ToolError(reason(error));
  }
  let session: string;
  try {
    const response = await step(() =>
      send(server, { method: "POST", path: "/session", body: { title } }),
    );
    if (!response.ok) await failed(response, true);
    session = text(record(await json(response))?.id) ?? "";
    if (!SESSION_ID.test(session))
      throw new ToolError(
        "OpenCode created a session without an id Ajour can read.",
      );
  } catch (error) {
    throw new ToolError(reason(error));
  }
  try {
    // The prompt goes in the body, never on a command line. 204 means
    // OpenCode took it, not that the work went well.
    const response = await step(() =>
      send(server, {
        method: "POST",
        path: `/session/${session}/prompt_async`,
        body: {
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
          parts: [{ type: "text", text: request.prompt }],
        },
      }),
    );
    if (!response.ok) await failed(response, true);
  } catch (error) {
    if (isLate(error))
      throw new ToolError(
        `OpenCode may have taken the prompt: check the session "${title}" in OpenCode before handing off again.`,
      );
    // The session has no prompt, so it is of no use: remove it.
    await step(() =>
      send(server, { method: "DELETE", path: `/session/${session}` }),
    ).catch(() => undefined);
    throw new ToolError(
      `OpenCode didn't take the prompt. ${reasonOf(opencode, error)}`,
    );
  }
  return {
    threadId: session,
    // Open attaches a terminal to the same server, which Ajour fills in.
    resume: {
      command: "opencode-attach",
      args: { session, folder: request.folder.id },
    },
    native: { state: "working", label: "Started" },
  };
}

/** What the plugin keeps between refreshes, without messages or paths. */
function nativeOf(previous: Json, state: State): Native {
  const kept: Native = { state };
  for (const key of ["status", "error"] as const) {
    const value = text(previous[key], 100);
    if (value) kept[key] = value;
  }
  return kept;
}

function keptUpdate(handoff: Handoff, state: State, notes: Native): Update {
  return {
    id: handoff.id,
    state,
    native: withNotes(
      nativeOf(handoff.native, previousState(handoff.native)),
      notes,
    ),
  };
}

function update(handoff: Handoff, state: State, native: Native): Update {
  return {
    id: handoff.id,
    state,
    native: withNotes({ state, label: LABELS[state] }, native),
  };
}

function lateUpdate(handoff: Handoff): Update {
  return keptUpdate(handoff, previousState(handoff.native), {
    reason: opencode.late,
  });
}

function unknownUpdate(handoff: Handoff, reason: string): Update {
  return keptUpdate(handoff, "unknown", { label: LABELS.unknown, reason });
}

interface Pending {
  permissions: number;
  questions: number;
}

/** The sessions each pending request belongs to, from one list. */
function pendingSessions(list: unknown, what: string): string[] {
  if (!Array.isArray(list))
    throw new ToolError(`OpenCode returned ${what} Ajour can't read.`);
  return list.flatMap((value) => {
    const session = text(record(value)?.sessionID);
    return session && SESSION_ID.test(session) ? [session] : [];
  });
}

/**
 * The handoff session a pending request waits in: its own, or the parent a
 * subagent's session works for, up to three levels up. Unknown sessions
 * are read once each.
 */
async function rootsOf(
  server: PluginConnection,
  sessions: readonly string[],
  ours: ReadonlySet<string>,
  deadline: number,
): Promise<Map<string, string>> {
  const roots = new Map<string, string>();
  const parents = new Map<string, string | undefined>();
  const parentOf = async (session: string) => {
    if (!parents.has(session)) {
      parents.set(session, undefined);
      try {
        const response = await before(opencode, deadline, () =>
          send(server, { method: "GET", path: `/session/${session}` }),
        );
        if (response.ok) {
          const parent = text(record(await response.json())?.parentID);
          if (parent && SESSION_ID.test(parent)) parents.set(session, parent);
        }
      } catch {
        // A session that can't be read keeps its request to itself.
      }
    }
    return parents.get(session);
  };
  const unknown = [...new Set(sessions)].filter((s) => !ours.has(s));
  await each(unknown.slice(0, 20), READ_CONCURRENCY, async (session) => {
    let current: string | undefined = session;
    for (let depth = 0; current && depth < 3; depth++) {
      current = await parentOf(current);
      if (current && ours.has(current)) {
        roots.set(session, current);
        return;
      }
    }
  });
  return roots;
}

/**
 * Reads a session that isn't busy: OpenCode deleted it (404), it stopped on
 * an error or without answering, or it is ready for review.
 */
async function readStopped(
  server: PluginConnection,
  handoff: Handoff,
  status: string,
  deadline: number,
): Promise<Update> {
  const session = handoff.threadId;
  const response = await before(opencode, deadline, () =>
    send(server, { method: "GET", path: `/session/${session}` }),
  );
  // Only OpenCode saying the session doesn't exist makes it gone.
  if (response.status === 404) return update(handoff, "gone", { status });
  if (!response.ok) await failed(response, false);
  const previous = previousState(handoff.native);
  // A session read as stopped before keeps what it was.
  if (previous === "ready" || previous === "failed") {
    const kept = nativeOf(handoff.native, previous);
    const reason = text(handoff.native.reason, 500);
    return {
      id: handoff.id,
      state: previous,
      native: withNotes(
        { ...kept, status },
        {
          label: text(handoff.native.label, 100) ?? LABELS[previous],
          ...(reason ? { reason } : {}),
        },
      ),
    };
  }
  // It just stopped, or never started: its last message tells how.
  const messages = await before(opencode, deadline, async () => {
    const answer = await send(server, {
      method: "GET",
      path: `/session/${session}/message`,
      query: { limit: 1 },
    });
    if (!answer.ok) await failed(answer, false);
    return json(answer);
  });
  const last = Array.isArray(messages)
    ? record(record(messages.at(-1))?.info)
    : undefined;
  if (!last) {
    // OpenCode has the session but not the prompt yet.
    return update(handoff, "working", { status, label: "Starting" });
  }
  if (last.role === "user") {
    const created = record(last.time)?.created;
    const age =
      typeof created === "number" ? Date.now() - created : Number.MAX_VALUE;
    // The server runs on this computer, so its clock is ours.
    if (age < STARTING_MS)
      return update(handoff, "working", { status, label: "Starting" });
    return update(handoff, "failed", { status, reason: NO_ANSWER });
  }
  const error = record(last.error);
  const name = text(error?.name, 100);
  if (!name) return update(handoff, "ready", { status });
  if (name === "MessageAbortedError")
    return update(handoff, "ready", { status, label: "Stopped" });
  const message = firstLine(text(record(error?.data)?.message, 2000));
  return update(handoff, "failed", {
    status,
    error: name,
    reason: message ? `${name}: ${message}`.slice(0, 500) : name,
  });
}

export async function readOpenCode(
  connection: PluginConnection | undefined,
  request: ReadHandoffStatesRequest,
): Promise<ReadHandoffStatesResult> {
  if (!connection)
    return request.handoffs.map((h) => unknownUpdate(h, NEEDS_CONNECTION));
  const server = connection;
  // Past the deadline, the remaining sessions keep their last state.
  const deadline = Date.now() + READ_DEADLINE_MS;
  let statuses: Json;
  const pending = new Map<string, Pending>();
  try {
    const [status, permissions, questions] = await before(
      opencode,
      deadline,
      () =>
        Promise.all([
          getJson(server, "/session/status"),
          getJson(server, "/permission"),
          getJson(server, "/question"),
        ]),
    );
    const map = record(status);
    if (!map)
      throw new ToolError("OpenCode returned a status Ajour can't read.");
    statuses = map;
    const ours = new Set(request.handoffs.map((h) => h.threadId));
    const asking = [
      ...pendingSessions(permissions, "permissions").map(
        (session) => [session, "permissions"] as const,
      ),
      ...pendingSessions(questions, "questions").map(
        (session) => [session, "questions"] as const,
      ),
    ];
    const roots = await rootsOf(
      server,
      asking.map(([session]) => session),
      ours,
      deadline,
    );
    for (const [session, kind] of asking) {
      const root = ours.has(session) ? session : roots.get(session);
      if (!root) continue;
      const counts = pending.get(root) ?? { permissions: 0, questions: 0 };
      counts[kind] += 1;
      pending.set(root, counts);
    }
  } catch (error) {
    // An unreachable server says nothing about the sessions. Never gone.
    return request.handoffs.map((handoff) =>
      isLate(error)
        ? lateUpdate(handoff)
        : unknownUpdate(handoff, reasonOf(opencode, error)),
    );
  }
  const updates = new Map<string, Update>();
  const stopped: [Handoff, string][] = [];
  for (const handoff of request.handoffs) {
    const status = record(statuses[handoff.threadId]);
    const type = text(status?.type, 20) ?? "absent";
    const asks = pending.get(handoff.threadId);
    if (asks) {
      updates.set(
        handoff.id,
        update(handoff, "needs-you", {
          status: type,
          label:
            asks.permissions > 0 ? "Asks for permission" : "Asks a question",
          permissions: asks.permissions,
          questions: asks.questions,
        }),
      );
    } else if (type === "busy") {
      updates.set(handoff.id, update(handoff, "working", { status: type }));
    } else if (type === "retry") {
      const attempt = status?.attempt;
      const message = firstLine(text(status?.message, 2000));
      updates.set(
        handoff.id,
        update(handoff, "working", {
          status: type,
          label: "Retrying",
          ...(typeof attempt === "number" ? { attempt } : {}),
          ...(message ? { reason: message } : {}),
        }),
      );
    } else if (type === "idle" || type === "absent") {
      stopped.push([handoff, type]);
    } else {
      updates.set(
        handoff.id,
        keptUpdate(handoff, "unknown", {
          label: LABELS.unknown,
          reason: `OpenCode reported a status Ajour doesn't know: ${type}.`,
        }),
      );
    }
  }
  await each(stopped, READ_CONCURRENCY, async ([handoff, status]) => {
    try {
      updates.set(
        handoff.id,
        await readStopped(server, handoff, status, deadline),
      );
    } catch (error) {
      updates.set(
        handoff.id,
        isLate(error)
          ? lateUpdate(handoff)
          : unknownUpdate(handoff, reasonOf(opencode, error)),
      );
    }
  });
  return request.handoffs.map((handoff) => updates.get(handoff.id) as Update);
}
