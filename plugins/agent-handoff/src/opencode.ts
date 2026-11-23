// Hands backlog items off to OpenCode 2 through its CLI. OpenCode 2 runs one
// background service on this computer, and its CLI finds that service and
// signs in to it by itself, so the plugin needs no connection, address or
// password. A start runs `opencode run -s <id>` detached in the repository
// folder, with a session id the plugin chooses and the prompt on stdin. A
// refresh reads each session with `opencode api session.get`: OpenCode
// records the end of each run on the session, as `time.idle` and an
// `outcome`. Open runs `opencode <folder> -s <id>` in a terminal, and a
// listing runs `opencode session list` in the folder. A close interrupts the
// session's run, then deletes the session with `opencode session delete`.
// OpenCode 1, whose `opencode serve` had another API, isn't supported.
import type {
  DetectToolsResult,
  ListThreadsRequest,
  ListThreadsResult,
  ReadHandoffStatesRequest,
  ReadHandoffStatesResult,
  StartHandoffRequest,
  StartHandoffResult,
} from "@ajour/plugin-sdk";
import {
  CLOSE_DEADLINE_MS,
  READ_DEADLINE_MS,
  START_DEADLINE_MS,
  ToolError,
  allLines,
  before,
  capture,
  captureJson,
  closeFailure,
  each,
  firstLine,
  isLate,
  launch,
  launchFailure,
  listTitle,
  listed,
  oneLineTitle,
  previousState,
  reasonOf,
  record,
  refusalsFor,
  run,
  settingText,
  text,
  timeOf,
  withNotes,
  type CloseThreadRequest,
  type CloseThreadResult,
  type Handoff,
  type Json,
  type Listed,
  type Native,
  type State,
  type Tool,
  type Update,
} from "./shared.ts";

export const OPENCODE_TOOL = "opencode";
/** The first version the plugin was tested on. */
export const MIN_VERSION = [2, 3, 2] as const;
const MIN_TEXT = MIN_VERSION.join(".");
// The most stdin Ajour writes to a command, in characters.
export const PROMPT_LIMIT = 1024 * 1024;
// A session id goes in a command's id slot, and in `sessionID=<id>`.
const SESSION_ID = /^ses_[A-Za-z0-9]{1,100}$/;
// The message of OpenCode's SessionNotFoundError, which `opencode session
// delete` prints for a session it doesn't have.
const NOT_FOUND = /\bSession not found\b/i;
// Ajour runs at most 4 of a plugin's commands at once.
const READ_CONCURRENCY = 4;
// `opencode run` creates the session, then starts on the prompt, a moment
// after Ajour starts it. Until then a session OpenCode doesn't have yet, or
// has without a run, counts as starting.
export const STARTING_MS = 60_000;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const LABELS: Record<State, string> = {
  working: "Working",
  "needs-you": "Waiting for you",
  ready: "Ready for review",
  done: "Done",
  failed: "Failed",
  gone: "Not on OpenCode",
  unknown: "Unknown",
};

export const NO_ANSWER =
  "OpenCode didn't start on the prompt. Open the session to see why.";
export const RUN_FAILED = "OpenCode's run failed. Open the session to see why.";
export const BAD_SESSION_ID =
  "This handoff's OpenCode session id isn't one Ajour can read.";

const opencode: Tool = {
  name: "OpenCode",
  exe: "opencode",
  refusals: refusalsFor("OpenCode", "opencode", {
    invalid_request:
      "Ajour refused a value for opencode. Check the model and the agent; a terminal also needs a repository folder path without unusual characters.",
    output_limit: "OpenCode printed more than Ajour accepts.",
    stdin_failed:
      "OpenCode didn't read the prompt: it stopped first, or took more than 10 seconds to start. Run opencode in the repository folder to check that it starts, then hand off again.",
  }),
  late: "OpenCode took too long; refreshing again later.",
  failureLine(value) {
    return firstLine(value).replace(/^error:\s*/i, "");
  },
  explain(message) {
    return message;
  },
};

/** The version in `2.3.2` form, or undefined for another form. */
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
  const [minMajor, minMinor, minPatch] = MIN_VERSION;
  if (major > minMajor)
    return `OpenCode ${version} isn't supported yet. Ajour hands off to OpenCode ${MIN_TEXT} or a later ${minMajor}.x version.`;
  const older =
    major < minMajor ||
    (major === minMajor &&
      (minor < minMinor || (minor === minMinor && patch < minPatch)));
  if (older)
    return `OpenCode ${version} is older than ${MIN_TEXT}, the first version Ajour supports. Run opencode upgrade.`;
  return undefined;
}

/** Whether OpenCode can take a handoff: its CLI runs, at a version Ajour supports. */
export async function detectOpenCode(): Promise<
  DetectToolsResult["tools"][number]
> {
  try {
    // `opencode v2.3.2`. OpenCode 1 printed `1.19.5`.
    const output = firstLine(await capture(opencode, "opencode-version", {}));
    const version = /^(?:opencode\s+)?v?(\S+)$/i.exec(output)?.[1] ?? output;
    if (!version || version.length > 200)
      throw new ToolError("opencode returned no version.");
    const problem = versionProblem(version);
    if (problem) throw new ToolError(problem);
    return { id: OPENCODE_TOOL, available: true, version };
  } catch (error) {
    return {
      id: OPENCODE_TOOL,
      available: false,
      reason: reasonOf(opencode, error),
    };
  }
}

/**
 * A new session id in OpenCode's own form: `ses_`, the time and a counter,
 * inverted so newer ids sort first, as 12 hex digits, then 14 random
 * characters. `opencode run -s` creates the session under this id.
 */
export function newSessionId(now = Date.now()): string {
  const value = ~(BigInt(now) * 0x1000n + 1n);
  let time = "";
  for (let byte = 0; byte < 6; byte++)
    time += Number((value >> BigInt(40 - 8 * byte)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  const random = crypto.getRandomValues(new Uint8Array(14));
  return `ses_${time}${Array.from(random, (b) => BASE62[b % 62]).join("")}`;
}

/** `provider/model`, with an optional `#variant`, as `opencode run --model` takes it. */
export function modelOf(value: unknown): string | undefined {
  const model = settingText(value);
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1)
    throw new ToolError(
      "Write OpenCode's model as provider/model, such as anthropic/claude-sonnet-4-5.",
    );
  return model;
}

/** Open attaches OpenCode's terminal interface to the session, in its folder. */
function open(session: string, folder: string) {
  return { command: "opencode-open", args: { session, folder } };
}

export async function startOpenCode(
  request: StartHandoffRequest,
): Promise<StartHandoffResult> {
  const deadline = Date.now() + START_DEADLINE_MS;
  const { prompt } = request;
  if (!prompt.trim())
    throw new ToolError("The prompt is empty. Check the handoff template.");
  if (prompt.length > PROMPT_LIMIT)
    throw new ToolError(
      `The prompt has ${prompt.length.toLocaleString("en-US")} characters, and Ajour gives OpenCode at most ${PROMPT_LIMIT.toLocaleString("en-US")}. Shorten the prompt.`,
    );
  const session = newSessionId();
  const args: Record<string, string> = {
    folder: request.folder.id,
    session,
    title: oneLineTitle(request.title),
  };
  const model = modelOf(request.settings.model);
  if (model) args.model = model;
  const agent = settingText(request.settings.agent);
  if (agent) args.agent = agent;
  try {
    // `opencode run` reads the whole prompt from stdin, creates the session
    // in its working folder, runs one turn and exits, so it starts detached:
    // Ajour would stop a capture command, and the work with it, after its
    // timeout. Nobody can answer it, so it rejects what OpenCode would ask
    // permission for and cancels a question, and the model goes on.
    await before(opencode, deadline, () =>
      launch(opencode, "opencode-run", args, prompt),
    );
  } catch (error) {
    throw launchFailure(opencode, error);
  }
  return {
    threadId: session,
    resume: open(session, request.folder.id),
    native: { state: "working", label: "Starting", started: Date.now() },
  };
}

/**
 * The sessions OpenCode lists for the folder's project, newest first, as a
 * start would have answered for each. A session in a subfolder of the
 * repository is in the same project, so it is listed too.
 */
export async function listOpenCode(
  request: ListThreadsRequest,
): Promise<ListThreadsResult> {
  const deadline = Date.now() + READ_DEADLINE_MS;
  let list: unknown;
  try {
    list = await before(opencode, deadline, () =>
      captureJson(opencode, "opencode-sessions", {
        folder: request.folder.id,
        limit: String(request.limit),
      }),
    );
  } catch (error) {
    throw new ToolError(
      reasonOf(opencode, error),
      error instanceof ToolError ? error.code : undefined,
    );
  }
  if (!Array.isArray(list))
    throw new ToolError("OpenCode returned a session list Ajour can't read.");
  const threads: Listed[] = [];
  for (const value of list) {
    const session = record(value);
    const threadId = text(session?.id);
    if (!session || !threadId || !SESSION_ID.test(threadId)) continue;
    const title = listTitle(session.title);
    if (!title) continue;
    const updatedAt = timeOf(session.updated);
    threads.push({
      threadId,
      title,
      resume: open(threadId, request.folder.id),
      native: { state: "unknown", label: LABELS.unknown },
      ...(updatedAt === undefined ? {} : { updatedAt }),
    });
  }
  return listed(threads, request);
}

/**
 * Runs one `opencode api` operation on a session and returns the answer's
 * body, or undefined when OpenCode doesn't have the session. On an error
 * answer, `opencode api` prints the body and exits 1 with `HTTP <status>` on
 * stderr.
 */
async function api(
  command: "opencode-session" | "opencode-messages" | "opencode-interrupt",
  session: string,
  deadline: number,
): Promise<Json | undefined> {
  const result = await before(opencode, deadline, () =>
    run(opencode, { command, args: { session: `sessionID=${session}` } }),
  );
  if (result.started === true)
    throw new ToolError("opencode started without returning its output.");
  let body: Json | undefined;
  try {
    body = record(JSON.parse(result.stdout ?? ""));
  } catch {
    body = undefined;
  }
  if (result.exitCode !== 0) {
    if (body?._tag === "SessionNotFoundError") return undefined;
    throw new ToolError(
      firstLine(text(body?.message, 500)) ||
        opencode.failureLine(result.stderr) ||
        `opencode exited with ${result.exitCode ?? "a signal"}.`,
    );
  }
  if (!body)
    throw new ToolError("OpenCode returned an answer Ajour can't read.");
  return body;
}

/** One `opencode api` read's `data`, or undefined for a session OpenCode doesn't have. */
async function apiRead(
  command: "opencode-session" | "opencode-messages",
  session: string,
  deadline: number,
): Promise<unknown> {
  const body = await api(command, session, deadline);
  if (!body) return undefined;
  if (!("data" in body))
    throw new ToolError("OpenCode returned an answer Ajour can't read.");
  return body.data;
}

function update(handoff: Handoff, state: State, notes: Native): Update {
  return {
    id: handoff.id,
    state,
    native: withNotes({ state, label: LABELS[state] }, notes),
  };
}

/**
 * Keeps what the plugin read last, with another state, label or reason. It
 * drops `idle`, so the next read of a failed run takes OpenCode's reason
 * again instead of this one.
 */
function keptUpdate(handoff: Handoff, state: State, notes: Native): Update {
  const kept: Native = { state };
  for (const key of ["started", "outcome", "error"] as const) {
    const value = handoff.native[key];
    if (typeof value === "number" || typeof value === "string")
      kept[key] = value;
  }
  return { id: handoff.id, state, native: withNotes(kept, notes) };
}

function unknownUpdate(handoff: Handoff, reason: string): Update {
  return keptUpdate(handoff, "unknown", { label: LABELS.unknown, reason });
}

/**
 * A read that didn't finish says nothing about the session: past the
 * deadline, cut short, or held back by Ajour's rate limit, it keeps its last
 * state. Any other failure makes it unknown, never gone.
 */
function failedUpdate(handoff: Handoff, error: unknown): Update {
  const previous = previousState(handoff.native);
  const label = text(handoff.native.label, 100) ?? LABELS[previous];
  if (isLate(error))
    return keptUpdate(handoff, previous, { label, reason: opencode.late });
  if (error instanceof ToolError && error.code === "rate_limit")
    return keptUpdate(handoff, previous, { label, reason: error.message });
  return unknownUpdate(handoff, reasonOf(opencode, error));
}

/**
 * A failed run, with the reason OpenCode stored on the session's newest
 * message, such as "Model unavailable: …". A run already read as failed
 * keeps its reason until another run ends.
 */
async function failedRun(
  handoff: Handoff,
  idle: number,
  deadline: number,
): Promise<Update> {
  const kept = text(handoff.native.reason, 500);
  if (
    previousState(handoff.native) === "failed" &&
    handoff.native.idle === idle &&
    kept
  )
    return keptUpdate(handoff, "failed", {
      label: LABELS.failed,
      reason: kept,
    });
  let reason = RUN_FAILED;
  let kind: string | undefined;
  try {
    const messages = await apiRead(
      "opencode-messages",
      handoff.threadId,
      deadline,
    );
    const last = Array.isArray(messages) ? record(messages[0]) : undefined;
    const error = last?.type === "idle" ? record(last.error) : undefined;
    reason = firstLine(text(error?.message, 500)) || RUN_FAILED;
    kind = text(error?.type, 100);
  } catch {
    // The run failed all the same; Open shows why.
  }
  return update(handoff, "failed", {
    idle,
    outcome: "failed",
    reason,
    ...(kind ? { error: kind } : {}),
  });
}

/** Reads one handoff's session and tells its state. */
async function readOne(handoff: Handoff, deadline: number): Promise<Update> {
  const session = record(
    await apiRead("opencode-session", handoff.threadId, deadline),
  );
  const now = Date.now();
  if (!session) {
    // `opencode run` may not have created the session yet.
    const started = handoff.native.started;
    if (typeof started === "number" && now - started < STARTING_MS)
      return update(handoff, "working", { label: "Starting", started });
    return update(handoff, "gone", {});
  }
  const time = record(session.time);
  const busy = timeOf(time?.busy);
  const idle = timeOf(time?.idle);
  if (busy === undefined) {
    // The session exists, but no run started on it. The service runs on
    // this computer, so its clock is ours.
    const created = timeOf(time?.created);
    if (created !== undefined && now - created < STARTING_MS)
      return update(handoff, "working", { label: "Starting" });
    return update(handoff, "failed", { reason: NO_ANSWER });
  }
  if (idle === undefined || idle < busy) return update(handoff, "working", {});
  const outcome = text(session.outcome, 50);
  if (outcome === "succeeded")
    return update(handoff, "ready", { idle, outcome });
  if (outcome === "interrupted")
    return update(handoff, "ready", { label: "Stopped", idle, outcome });
  if (outcome === "failed") return failedRun(handoff, idle, deadline);
  return keptUpdate(handoff, "unknown", {
    label: LABELS.unknown,
    reason: `OpenCode reported an outcome Ajour doesn't know: ${outcome ?? "none"}.`,
  });
}

/**
 * Each handoff's state, from one read of its session, four at a time. Past
 * the deadline, the remaining handoffs keep their last state.
 */
export async function readOpenCode(
  request: ReadHandoffStatesRequest,
): Promise<ReadHandoffStatesResult> {
  const deadline = Date.now() + READ_DEADLINE_MS;
  const updates = new Map<string, Update>();
  await each(request.handoffs, READ_CONCURRENCY, async (handoff) => {
    // The id goes in a command's argument, so only an OpenCode session id does.
    if (!SESSION_ID.test(handoff.threadId)) {
      updates.set(handoff.id, unknownUpdate(handoff, BAD_SESSION_ID));
      return;
    }
    try {
      updates.set(handoff.id, await readOne(handoff, deadline));
    } catch (error) {
      updates.set(handoff.id, failedUpdate(handoff, error));
    }
  });
  return request.handoffs.map((handoff) => updates.get(handoff.id) as Update);
}

/**
 * Deletes the session for good, with its child sessions, through `opencode
 * session delete`. A run going on it is interrupted first, through
 * `opencode api session.interrupt`, which does nothing to an idle session.
 * A session OpenCode doesn't have was deleted already, so it counts as
 * closed. Ajour asks the user before it deletes.
 */
export async function closeOpenCode(
  request: CloseThreadRequest,
): Promise<CloseThreadResult> {
  const { handoff } = request;
  // The id goes in a command's argument, so only an OpenCode session id does.
  if (!SESSION_ID.test(handoff.threadId)) throw new ToolError(BAD_SESSION_ID);
  const deadline = Date.now() + CLOSE_DEADLINE_MS;
  try {
    try {
      if (!(await api("opencode-interrupt", handoff.threadId, deadline)))
        return {};
    } catch (error) {
      throw isLate(error)
        ? error
        : new ToolError(
            `OpenCode didn't stop the session's run, so Ajour didn't delete it: ${reasonOf(opencode, error)}`,
          );
    }
    const result = await before(opencode, deadline, () =>
      run(opencode, {
        command: "opencode-delete",
        args: { session: handoff.threadId },
      }),
    );
    if (result.started === true)
      throw new ToolError("opencode started without returning its output.");
    if (result.exitCode === 0) return {};
    const said = allLines(result.stderr) || allLines(result.stdout);
    // The session left OpenCode since the interrupt: deleted already.
    if (NOT_FOUND.test(said)) return {};
    throw new ToolError(
      said
        ? `OpenCode didn't delete the session: ${said}`
        : `opencode exited with ${result.exitCode ?? "a signal"}.`,
    );
  } catch (error) {
    throw closeFailure(opencode, error);
  }
}
