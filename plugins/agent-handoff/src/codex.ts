// Hands backlog items off to Codex through `codex app-server`, its JSON-RPC
// server on stdio. The app-server owns a turn: it must keep running until the
// turn ends, so each handoff gets its own Ajour process session, started in
// the handoff's repository folder, which runs its thread's one turn. The
// session's id is kept in the handoff's native state, and a refresh reads the
// thread there. Once the turn ends, or Codex waits for the user, the refresh
// closes the session, which lets go of the thread so the Codex app can open
// it. A thread no session of the plugin holds is read from the files Codex
// keeps, through another app-server. A close interrupts the turn its
// session runs, then archives the thread, which Codex keeps.
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
  LateError,
  READ_DEADLINE_MS,
  START_DEADLINE_MS,
  MaybeStartedError,
  ToolError,
  capture,
  closeFailure,
  each,
  firstLine,
  isLate,
  listTitle,
  listed,
  oneLineTitle,
  pause,
  previousState,
  reasonOf,
  record,
  refusal,
  refusalsFor,
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

export const CODEX_TOOL = "codex";
const SERVER = "codex-app-server";
const RESUME = "codex-resume";
// Codex refuses initialize without a client version, and Ajour gives a plugin
// no way to read its own manifest: a test keeps this equal to plugin.json's.
const CLIENT = { name: "ajour", title: "Ajour", version: "0.18.0" };
// Ajour sends a session one line of at most 1 MB, in UTF-8.
export const LINE_LIMIT = 1024 * 1024;
// One read takes at most 1000 lines, and waits at most 30 seconds.
const READ_LINES = 1000;
const READ_WAIT_MS = 30_000;
// A Codex thread id is a UUID.
const THREAD_ID = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
// How Codex answers a read of a thread it has no record of, such as one
// deleted with `codex delete`. A thread it keeps reads as notLoaded instead.
const NOT_FOUND = /^thread not loaded\b/i;
// Codex keeps an archived thread's rollout in this folder.
const ARCHIVED = /[\\/]archived_sessions[\\/]/i;
// JSON-RPC's code for a method the server doesn't have.
const NO_METHOD = -32601;
// A start that finds both sessions taken waits this long once: a refresh's
// reader holds a session only for a moment.
const BUSY_RETRY_MS = 3000;
// A refresh with less time left than this opens no reader: starting an
// app-server takes about a second, and its reads take more.
const READER_MIN_MS = 2000;

/**
 * What Codex asks the user, as the flag Codex sets for it, or undefined for a
 * request that isn't for the user. Ajour can't answer, and while a session
 * holds the thread, neither can the Codex app. A method this version doesn't
 * name, such as `item/<tool>/requestApproval` or another `*\/request*`, is
 * taken as a question too: answering it with an error would stop the turn.
 */
function askOf(
  method: string,
): "waitingOnApproval" | "waitingOnUserInput" | undefined {
  if (/Approval$/.test(method)) return "waitingOnApproval";
  if (/\/request/.test(method)) return "waitingOnUserInput";
  return undefined;
}
const LABELS: Record<State, string> = {
  working: "Working",
  "needs-you": "Waiting for you",
  ready: "Completed",
  done: "Archived",
  failed: "Failed",
  gone: "Deleted in Codex",
  unknown: "Unknown",
};
export const RELEASED =
  "Codex asked for your approval or an answer, which Ajour can't give. Ajour let go of the thread, which stopped the turn: open it in Codex and tell it to go on.";
export const STOPPED =
  "The turn stopped before it finished, when Ajour's Codex session ended: Ajour quit, the plugin was turned off or updated, or nothing refreshed it for 30 minutes. Open the thread in Codex to go on.";
export const NOT_RECORDED =
  "Ajour's Codex session ended before Codex recorded the turn, so the prompt never ran. Open the thread in Codex, or hand off again.";
export const ELSEWHERE =
  "Codex reports the last turn as interrupted, which is also how it shows a turn running in another Codex window. Open the thread to see it.";
export const GONE =
  "Codex has no thread with this id, such as after codex delete.";
export const BUSY_STARTING =
  "Ajour runs at most two Codex handoffs at once, and two are running. Hand off again when one finishes or waits for you.";
export const BUSY_READING =
  "Both of Ajour's Codex sessions are running handoffs; refreshing again once one is free.";
export const BUSY_LISTING =
  "Both of Ajour's Codex sessions are running handoffs, so Ajour can't list Codex's threads until one is free.";
const NO_READS =
  "This Codex version doesn't answer the reads Ajour follows a handoff with. Check for an update of this plugin.";
const NO_LIST =
  "This Codex version can't list its threads the way Ajour asks. Check for an update of this plugin.";
export const BUSY_CLOSING =
  "Both of Ajour's Codex sessions are running handoffs, so Ajour can't close this thread until one is free.";
const NO_CLOSE =
  "This Codex version can't archive threads the way Ajour asks. Check for an update of this plugin.";
export const UNKNOWN_TURN =
  "Codex runs a turn on this thread, but Ajour doesn't know which turn to stop. Stop it in Codex, then close the thread again.";
// How Codex answers an archive of a thread it has no file for.
const NO_ROLLOUT = /^no rollout found for thread id\b/i;
// How Codex answers an interrupt of a turn that ended already.
const TURN_ENDED = /\b(?:no active turn|turn not found)\b/i;
// After an interrupt, a close reads the thread this often until the turn
// stopped, for at most this long, then archives it either way.
const STOP_POLL_MS = 250;
const STOP_WAIT_MS = 5000;
// The threads a person started, in the CLI, an app or another app-server
// client. A subagent's thread works for its parent.
const LISTED_SOURCES = ["cli", "vscode", "exec", "appServer"];
// A filesystem root, such as C:\, / or a network share's \\server\share\:
// never a repository folder.
const ROOT = /^(?:[A-Za-z]:|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)?[\\/]*$/;
const NOT_IN_TIME = "Codex didn't start the thread in time. Try again.";
const MAYBE_STARTED =
  "Codex may have started the thread. Check Codex before handing off again.";

const codex: Tool = {
  name: "Codex",
  exe: "codex",
  refusals: refusalsFor("Codex", "codex", {
    invalid_request:
      "Ajour refused a value for codex. A terminal also needs a repository folder path without unusual characters.",
    output_limit: "Codex printed more than Ajour accepts.",
    session_limit: BUSY_STARTING,
    session_ended: "Ajour's session with Codex ended. Try again.",
    input_limit: "Codex isn't taking Ajour's input. Try again.",
  }),
  late: "Codex took too long; refreshing again later.",
  failureLine(value) {
    return firstLine(value).replace(/^error:\s*/i, "");
  },
  explain(message) {
    return message;
  },
};

export async function detectCodex(): Promise<
  DetectToolsResult["tools"][number]
> {
  try {
    const output = firstLine(await capture(codex, "codex-version", {}));
    const version = /^codex-cli\s+v?(\S+)$/i.exec(output)?.[1] ?? output;
    if (!version || version.length > 200)
      throw new ToolError("codex returned no version.");
    return { id: CODEX_TOOL, available: true, version };
  } catch (error) {
    return {
      id: CODEX_TOOL,
      available: false,
      reason: reasonOf(codex, error),
    };
  }
}

/** The session ended, or its program exited: no call reaches it. */
class SessionGone extends ToolError {
  constructor() {
    super(codex.refusals.session_ended as string, "session_ended");
  }
}

function sessionError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  const refused = refusal(codex, error);
  return refused.code === "session_ended" ? new SessionGone() : refused;
}

/** A JSON-RPC answer: the result, or the error Codex returned. */
interface Answer {
  result?: Json;
  error?: { code?: number; message: string };
}

/** What Codex asked the user about one thread, between reads. */
interface Heard {
  asked: "waitingOnApproval" | "waitingOnUserInput";
}

/**
 * JSON-RPC over one of Ajour's process sessions. Ids are strings this
 * operation alone uses, so an answer to an earlier operation's request is
 * never taken for one of this operation's.
 */
class Rpc {
  private next = 0;
  private readonly prefix = `ajour-${crypto.randomUUID().slice(0, 8)}`;
  private readonly answers = new Map<string, Answer>();
  readonly heard = new Map<string, Heard>();
  /** The program exited: what it wrote before is read, nothing more comes. */
  exited = false;

  readonly session: string;

  constructor(session: string) {
    this.session = session;
  }

  private async write(message: Json): Promise<void> {
    const line = JSON.stringify(message);
    if (new TextEncoder().encode(line).length > LINE_LIMIT)
      throw new ToolError(
        "A message for Codex is longer than the 1 MB Ajour sends at once.",
        "invalid_request",
      );
    try {
      await ajour.process.session.send(this.session, line);
    } catch (error) {
      throw sessionError(error);
    }
  }

  /** Sends a request and returns its id. */
  async request(method: string, params: Json): Promise<string> {
    const id = `${this.prefix}-${++this.next}`;
    await this.write({ id, method, params });
    return id;
  }

  async notify(method: string): Promise<void> {
    await this.write({ method });
  }

  /** Reads until every id is answered, or throws once `deadline` passes. */
  async answered(ids: string[], deadline: number): Promise<Answer[]> {
    while (ids.some((id) => !this.answers.has(id))) {
      const left = deadline - Date.now();
      if (left <= 0) throw new LateError(codex.late);
      let read: Awaited<ReturnType<typeof ajour.process.session.read>>;
      try {
        read = await ajour.process.session.read(this.session, {
          max: READ_LINES,
          waitMs: Math.max(0, Math.min(READ_WAIT_MS, Math.floor(left))),
        });
      } catch (error) {
        throw sessionError(error);
      }
      for (const line of read.lines) await this.take(line);
      if (read.exited) {
        this.exited = true;
        // Ajour reports the exit with the program's last lines, which may
        // hold every answer.
        if (ids.every((id) => this.answers.has(id))) break;
        throw new SessionGone();
      }
      // Ajour's read waits for a line; this keeps a quick empty read from
      // spinning.
      if (read.lines.length === 0) await pause(25, deadline);
    }
    return ids.map((id) => this.answers.get(id) as Answer);
  }

  /** The answers to `ids`, once all came. */
  peek(ids: string[]): Answer[] | undefined {
    const answers = ids.map((id) => this.answers.get(id));
    return answers.every((answer) => answer !== undefined)
      ? (answers as Answer[])
      : undefined;
  }

  private async take(line: string): Promise<void> {
    let message: Json | undefined;
    try {
      message = record(JSON.parse(line));
    } catch {
      return;
    }
    if (!message) return;
    const method = text(message.method, 200);
    const id = message.id;
    if (!method) {
      if (typeof id !== "string" || !id.startsWith(this.prefix)) return;
      const error = record(message.error);
      this.answers.set(
        id,
        error
          ? {
              error: {
                message: text(error.message, 2000) ?? "Codex failed.",
                ...(typeof error.code === "number" ? { code: error.code } : {}),
              },
            }
          : { result: record(message.result) ?? {} },
      );
      return;
    }
    const params = record(message.params) ?? {};
    const thread = text(params.threadId, 100);
    if (id !== undefined && id !== null) {
      // Codex asks the client. A question for the user stays unanswered:
      // the thread's flags say Codex waits. Anything else gets an error, so
      // Codex doesn't wait for a client that can't answer.
      const asked = askOf(method);
      if (asked) {
        if (thread) this.heard.set(thread, { asked });
      } else
        await this.write({
          id: id as string | number,
          error: { code: -32601, message: "Ajour can't answer this request." },
        }).catch(() => undefined);
    }
  }
}

function errorOf(answer: Answer): string | undefined {
  return answer.error?.message;
}

/** Codex answered that it has no such method, such as after an update. */
function missingMethod(answer: Answer): boolean {
  return answer.error?.code === NO_METHOD;
}

/** Codex's answer to a request, or a failure with its message. */
function resultOf(answer: Answer): Json {
  if (answer.error)
    throw new ToolError(firstLine(answer.error.message) || "Codex failed.");
  return answer.result ?? {};
}

async function openServer(folder: string): Promise<string> {
  try {
    return await ajour.process.session.open({
      command: SERVER,
      args: { folder },
    });
  } catch (error) {
    throw refusal(codex, error);
  }
}

async function closeServer(session: string): Promise<void> {
  try {
    await ajour.process.session.close(session);
  } catch {
    // It already ended.
  }
}

/** Opens a session and initializes the app-server in it. */
async function connect(folder: string, deadline: number): Promise<Rpc> {
  const session = await openServer(folder);
  const rpc = new Rpc(session);
  try {
    const [init] = await rpc.answered(
      [await rpc.request("initialize", { clientInfo: CLIENT })],
      deadline,
    );
    resultOf(init as Answer);
    await rpc.notify("initialized");
    return rpc;
  } catch (error) {
    await closeServer(session);
    throw error;
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof ToolError && error.code === "session_limit";
}

/**
 * Connects for a start. Both sessions taken may mean a refresh's reader holds
 * one for a moment, so the start waits once and tries again, when the
 * deadline leaves time to start the thread after.
 */
async function connectToStart(folder: string, deadline: number): Promise<Rpc> {
  try {
    return await connect(folder, deadline);
  } catch (error) {
    if (!isBusy(error) || deadline - Date.now() < BUSY_RETRY_MS * 3)
      throw error;
    await pause(BUSY_RETRY_MS, deadline);
    return connect(folder, deadline);
  }
}

/** The turn's input: the prompt, as one JSON line Ajour can send. */
function turnInput(prompt: string): Json[] {
  return [{ type: "text", text: prompt }];
}

export async function startCodex(
  request: StartHandoffRequest,
): Promise<StartHandoffResult> {
  const deadline = Date.now() + START_DEADLINE_MS;
  const open = request.settings.open === "terminal" ? "terminal" : "app";
  const model = settingText(request.settings.model);
  // The longest line is turn/start's: refuse it before starting anything.
  const turnLine = JSON.stringify({
    id: "ajour-00000000-0",
    method: "turn/start",
    params: {
      threadId: "00000000-0000-0000-0000-000000000000",
      input: turnInput(request.prompt),
    },
  });
  if (new TextEncoder().encode(turnLine).length > LINE_LIMIT)
    throw new ToolError(
      "The prompt is longer than the 1 MB Ajour sends Codex at once. Shorten the handoff template, such as by leaving out the item's description.",
    );
  let rpc: Rpc;
  try {
    // connect keeps to the deadline, and ends a session it opened on a
    // failure, so none outlives the operation unseen.
    rpc = await connectToStart(request.folder.id, deadline);
  } catch (error) {
    if (isLate(error)) throw new ToolError(NOT_IN_TIME, "late");
    throw new ToolError(
      reasonOf(codex, error),
      error instanceof ToolError ? error.code : undefined,
    );
  }
  let threadId: string | undefined;
  let turn: string | undefined;
  let notes: Native = {};
  try {
    // The app-server works in the folder Ajour started it in, the handoff's
    // repository folder, with the user's own Codex settings.
    const [started] = await rpc.answered(
      [await rpc.request("thread/start", model ? { model } : {})],
      deadline,
    );
    const id = text(record(resultOf(started as Answer).thread)?.id, 100);
    if (!id || !THREAD_ID.test(id))
      throw new ToolError(
        "Codex started a thread without an id Ajour can read.",
      );
    threadId = id;
    const naming = await rpc.request("thread/name/set", {
      threadId,
      name: oneLineTitle(request.title),
    });
    const starting = await rpc.request("turn/start", {
      threadId,
      input: turnInput(request.prompt),
    });
    const [named, turned] = await rpc.answered([naming, starting], deadline);
    const turnResult = resultOf(turned as Answer);
    turn = text(record(turnResult.turn)?.id, 100);
    const nameError = errorOf(named as Answer);
    if (nameError)
      notes = {
        reason: `Codex didn't take the title: ${firstLine(nameError)}`,
      };
  } catch (error) {
    if (threadId && isLate(error)) {
      // The thread exists and its turn may run: keep the session and let a
      // refresh read it.
      notes = { reason: MAYBE_STARTED };
    } else {
      await closeServer(rpc.session);
      if (isLate(error) || error instanceof SessionGone) {
        const code = error instanceof ToolError ? error.code : undefined;
        // The thread exists, and its turn may have started.
        if (threadId) throw new MaybeStartedError(MAYBE_STARTED, code);
        throw new ToolError(
          isLate(error) ? NOT_IN_TIME : reasonOf(codex, error),
          code,
        );
      }
      throw new ToolError(
        `Codex didn't start the turn: ${reasonOf(codex, error)}`,
        error instanceof ToolError ? error.code : undefined,
      );
    }
  }
  const native: Native = {
    state: "working",
    label: LABELS.working,
    open,
    session: rpc.session,
    // When the turn started: until Codex records it, it reads the thread
    // as idle.
    started: String(Date.now()),
  };
  if (turn) native.turn = turn;
  return {
    threadId: threadId as string,
    // The Codex app opens the thread from its link; the terminal resumes it.
    ...(open === "app" ? { link: linkOf(threadId as string) } : {}),
    resume: resumeOf(threadId as string, request.folder.id),
    native: withNotes(native, notes),
  };
}

const linkOf = (threadId: string) => `codex://threads/${threadId}`;
const resumeOf = (threadId: string, folder: string) => ({
  command: RESUME,
  args: { thread: threadId, folder },
});

/** A listed thread's title: its name, else its first prompt line, as Codex shows it. */
function titleOf(thread: Json): string | undefined {
  const name = listTitle(thread.name);
  if (name) return name;
  const preview = typeof thread.preview === "string" ? thread.preview : "";
  return listTitle(preview.split(/\r?\n/).find((line) => line.trim()));
}

/**
 * The folder's threads, newest first, as a start with the default Open
 * would have answered for each. A listing has no settings, so each thread
 * opens in the Codex app, as a start does by default.
 *
 * Codex filters threads by the exact folder a session started in, which
 * Ajour never tells the plugin. So the listing opens an app-server in the
 * folder, as a start does, asks it which folder it runs in (`hooks/list`
 * reports it), lists that folder's threads, and closes the session.
 */
export async function listCodex(
  request: ListThreadsRequest,
): Promise<ListThreadsResult> {
  const deadline = Date.now() + READ_DEADLINE_MS;
  let rpc: Rpc;
  try {
    rpc = await connect(request.folder.id, deadline);
  } catch (error) {
    if (isBusy(error)) throw new ToolError(BUSY_LISTING, "session_limit");
    throw new ToolError(
      reasonOf(codex, error),
      error instanceof ToolError ? error.code : undefined,
    );
  }
  let data: unknown[];
  let cwd: string;
  try {
    const [hooks] = await rpc.answered(
      [await rpc.request("hooks/list", { cwds: [] })],
      deadline,
    );
    if (missingMethod(hooks as Answer)) throw new ToolError(NO_LIST);
    // `hooks/list` reports the folder the broker started the process in, the
    // repository folder, since the app-server ignores `-C`. A filesystem root
    // means it started elsewhere, and the root's threads aren't the folder's.
    const entries = resultOf(hooks as Answer).data;
    const reported = Array.isArray(entries)
      ? text(record(entries[0])?.cwd, 4096)
      : undefined;
    if (!reported || ROOT.test(reported)) throw new ToolError(NO_LIST);
    cwd = reported;
    const [list] = await rpc.answered(
      [
        await rpc.request("thread/list", {
          cwd,
          limit: request.limit,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: LISTED_SOURCES,
        }),
      ],
      deadline,
    );
    if (missingMethod(list as Answer)) throw new ToolError(NO_LIST);
    const threads = resultOf(list as Answer).data;
    if (!Array.isArray(threads))
      throw new ToolError("Codex returned a thread list Ajour can't read.");
    data = threads;
  } catch (error) {
    throw new ToolError(
      reasonOf(codex, error),
      error instanceof ToolError ? error.code : undefined,
    );
  } finally {
    await closeServer(rpc.session);
  }
  const threads: Listed[] = [];
  for (const value of data) {
    const thread = record(value);
    const threadId = text(thread?.id, 100);
    if (!thread || !threadId || !THREAD_ID.test(threadId)) continue;
    // Codex filtered by folder already; a thread of another folder, a
    // subagent's, or one Codex doesn't keep is left out all the same.
    if (thread.cwd !== cwd || thread.parentThreadId || thread.ephemeral)
      continue;
    const title = titleOf(thread);
    if (!title) continue;
    const status = text(record(thread.status)?.type, 64);
    // Only a turn this app-server runs is known: a thread it hasn't loaded
    // may run in another one, so it is unknown, not idle.
    const state: State = status === "active" ? "working" : "unknown";
    const native: Native = { state, label: LABELS[state], open: "app" };
    if (status) native.status = status;
    const updatedAt = timeOf(thread.updatedAt, 1000);
    threads.push({
      threadId,
      title,
      link: linkOf(threadId),
      resume: resumeOf(threadId, request.folder.id),
      native,
      state,
      ...(updatedAt === undefined ? {} : { updatedAt }),
    });
  }
  return listed(threads, request);
}

const KEPT = [
  "label",
  "open",
  "turn",
  "session",
  "status",
  "turnStatus",
  "started",
] as const;

/** The handoff's native state without the reason, flags or a closed session. */
function keptNative(
  handoff: Handoff,
  drop: { session?: boolean } = {},
): Native {
  const previous = handoff.native;
  const native: Native = { state: previousState(previous) };
  for (const key of KEPT) {
    if (drop.session && key === "session") continue;
    const value = text(previous[key], 200);
    if (value) native[key] = value;
  }
  if (previous.released === true) native.released = true;
  return native;
}

/** Keeps the last state read, with what is new about it. */
function keptUpdate(
  handoff: Handoff,
  state: State,
  notes: Native,
  drop: { session?: boolean } = {},
): Update {
  return {
    id: handoff.id,
    state,
    native: withNotes(keptNative(handoff, drop), notes),
  };
}

function lateUpdate(handoff: Handoff): Update {
  return keptUpdate(handoff, previousState(handoff.native), {
    reason: codex.late,
  });
}

/** The thread's runtime status and the last turn, as Codex reports them. */
interface Reading {
  thread: Json;
  status: Json;
  last: Json | undefined;
  /** The turn is still running in this session. */
  live: boolean;
}

function flagsOf(status: Json): string[] {
  return Array.isArray(status.activeFlags)
    ? status.activeFlags.filter(
        (flag): flag is string => typeof flag === "string",
      )
    : [];
}

function turnError(turn: Json | undefined): string | undefined {
  const message = text(record(turn?.error)?.message, 2000);
  return message ? firstLine(message) : undefined;
}

/** The common state, label and reason for what Codex reports. */
function stateOf(
  handoff: Handoff,
  reading: Reading,
): { state: State; label: string; reason?: string; released?: boolean } {
  const { thread, status, last, live } = reading;
  const path = text(thread.path, 4096);
  if (path && ARCHIVED.test(path)) return { state: "done", label: "Archived" };
  const type = text(status.type, 64);
  if (type === "active") {
    const flags = flagsOf(status);
    if (flags.includes("waitingOnApproval"))
      return {
        state: "needs-you",
        label: "Waiting for approval",
        reason: RELEASED,
        released: true,
      };
    if (flags.includes("waitingOnUserInput"))
      return {
        state: "needs-you",
        label: "Waiting for your answer",
        reason: RELEASED,
        released: true,
      };
    return { state: "working", label: LABELS.working };
  }
  const ours = text(handoff.native.turn, 100);
  const turnStatus = text(last?.status, 64);
  if (live && (!last || text(last.id, 100) !== ours)) {
    // Codex records the turn a moment after turn/start answers, and until
    // then reads the thread as idle: the session's own turn still runs.
    if (ours && justStarted(handoff))
      return { state: "working", label: LABELS.working };
    if (!last || ours)
      return {
        state: "failed",
        label: "Failed",
        reason: "Codex didn't start the turn. Hand off again.",
      };
  }
  if (!last)
    return ours
      ? { state: "failed", label: "Stopped", reason: NOT_RECORDED }
      : { state: "unknown", label: "No turn" };
  if (turnStatus === "completed") return { state: "ready", label: "Completed" };
  if (turnStatus === "failed")
    return {
      state: "failed",
      label: "Failed",
      reason: turnError(last) ?? "Codex reported the turn failed.",
    };
  if (turnStatus === "inProgress")
    return { state: "working", label: LABELS.working };
  if (turnStatus === "interrupted") {
    // A turn the user stopped has an end time. One without was cut short,
    // or runs in another app-server, which can't be told apart from here.
    if (last.completedAt !== null && last.completedAt !== undefined)
      return { state: "ready", label: "Interrupted" };
    if (text(last.id, 100) === ours) {
      if (handoff.native.released === true)
        return {
          state: "needs-you",
          label: text(handoff.native.label) ?? LABELS["needs-you"],
          reason: RELEASED,
          released: true,
        };
      return { state: "failed", label: "Stopped", reason: STOPPED };
    }
    return { state: "unknown", label: "Interrupted", reason: ELSEWHERE };
  }
  if (type === "systemError")
    return {
      state: "failed",
      label: "Failed",
      reason: "Codex reported a system error.",
    };
  return { state: "unknown", label: LABELS.unknown };
}

function updateOf(
  handoff: Handoff,
  reading: Reading,
  session?: string,
): Update {
  const { state, label, reason, released } = stateOf(handoff, reading);
  const native: Native = { state, label };
  const open = text(handoff.native.open, 16);
  if (open) native.open = open;
  // The turn the plugin started, which a stop is matched against. A start
  // that ran out of time learns it from its session.
  const turn =
    text(handoff.native.turn, 100) ??
    (reading.live ? text(reading.last?.id, 100) : undefined);
  if (turn) native.turn = turn;
  const started = text(handoff.native.started, 20);
  if (started) native.started = started;
  if (session) native.session = session;
  const type = text(reading.status.type, 64);
  if (type) native.status = type;
  const flags = flagsOf(reading.status);
  if (flags.length) native.flags = flags.join(",");
  const turnStatus = text(reading.last?.status, 64);
  if (turnStatus) native.turnStatus = turnStatus;
  if (released) native.released = true;
  const title = text(reading.thread.name, 500);
  return {
    id: handoff.id,
    state,
    native: withNotes(native, reason ? { reason } : {}),
    ...(title ? { title } : {}),
  };
}

/** Asks for a thread and its last turn, without its messages. */
async function ask(rpc: Rpc, threadId: string): Promise<[string, string]> {
  return [
    await rpc.request("thread/read", { threadId }),
    await rpc.request("thread/turns/list", {
      threadId,
      limit: 1,
      itemsView: "notLoaded",
    }),
  ];
}

/** The update for a thread from its answers, or a kept state on a failure. */
function answeredUpdate(
  handoff: Handoff,
  read: Answer,
  turns: Answer,
  session?: string,
): Update {
  const drop = { session: !session };
  const readError = errorOf(read);
  if (missingMethod(read) || missingMethod(turns))
    return keptUpdate(
      handoff,
      previousState(handoff.native),
      { reason: NO_READS },
      drop,
    );
  if (readError) {
    // Only a record Codex doesn't have is gone. Another failure, such as a
    // thread whose first line isn't written yet, says nothing about it.
    if (NOT_FOUND.test(readError))
      return keptUpdate(
        handoff,
        "gone",
        { label: LABELS.gone, reason: GONE },
        drop,
      );
    return keptUpdate(
      handoff,
      previousState(handoff.native),
      { reason: "Codex couldn't read this thread. Refreshing again later." },
      drop,
    );
  }
  const thread = record(read.result?.thread) ?? {};
  const status = record(thread.status) ?? {};
  // An active thread's status says it all: working, or what it waits for.
  if (errorOf(turns) && text(status.type) !== "active")
    return keptUpdate(
      handoff,
      previousState(handoff.native),
      {
        reason:
          "Codex couldn't read this thread's turns. Refreshing again later.",
      },
      drop,
    );
  const list = turns.result?.data;
  const last = Array.isArray(list) ? record(list[0]) : undefined;
  return updateOf(handoff, { thread, status, last, live: !!session }, session);
}

/**
 * Reads a thread in the session running its turn. Returns the update and the
 * session, still open, when the turn goes on; undefined once the session is
 * gone, for a read from Codex's files instead.
 */
async function readLive(
  handoff: Handoff,
  session: string,
  deadline: number,
): Promise<{ update: Update; rpc?: Rpc } | undefined> {
  const rpc = new Rpc(session);
  let answers: Answer[];
  try {
    answers = await rpc.answered(await ask(rpc, handoff.threadId), deadline);
  } catch (error) {
    if (error instanceof SessionGone) return undefined;
    throw error;
  }
  const [read, turns] = answers as [Answer, Answer];
  // What Codex said while nobody read: a question it asked without a flag.
  const heard = rpc.heard.get(handoff.threadId);
  const thread = record(read.result?.thread);
  const type = text(record(thread?.status)?.type);
  const active = type === "active";
  if (heard && thread && active) {
    const status = record(thread.status) ?? {};
    if (!flagsOf(status).length)
      thread.status = { ...status, activeFlags: [heard.asked] };
  }
  const update = answeredUpdate(handoff, read, turns, session);
  if (
    !rpc.exited &&
    holds(handoff, update, read, turns, active, type === "idle")
  )
    return { update, rpc };
  // The turn ended, waits for the user, or can't be followed here: let go of
  // the thread, so the Codex app can open it, and free the session. A
  // session kept for a turn that ended would never idle out, since each
  // refresh reads it.
  await closeServer(session);
  delete (update.native as Native).session;
  return { update };
}

/**
 * How long after its start a turn the plugin started counts as running
 * though Codex still reads its thread as idle: it records the turn a moment
 * after turn/start answers.
 */
const START_GRACE_MS = 30_000;

/** True while the plugin's own turn started a moment ago. */
function justStarted(handoff: Handoff): boolean {
  if (!text(handoff.native.turn, 100)) return false;
  const started = Number(text(handoff.native.started, 20));
  if (!Number.isFinite(started)) return false;
  const age = Date.now() - started;
  return age >= 0 && age < START_GRACE_MS;
}

/** True while the session may still run the thread's turn. */
function holds(
  handoff: Handoff,
  update: Update,
  read: Answer,
  turns: Answer,
  active: boolean,
  idle: boolean,
): boolean {
  // A thread Codex has no record of, or a read this Codex doesn't have.
  if (update.state === "gone" || missingMethod(read) || missingMethod(turns))
    return false;
  // Another read failure says nothing about the thread.
  if (errorOf(read)) return true;
  // Without the turns, the thread's status alone says whether it runs.
  if (errorOf(turns))
    return (
      (active || (idle && justStarted(handoff))) && update.state === "working"
    );
  return update.state === "working";
}

export async function readCodex(
  request: ReadHandoffStatesRequest,
): Promise<ReadHandoffStatesResult> {
  if (request.handoffs.length === 0) return [];
  const deadline = Date.now() + READ_DEADLINE_MS;
  const updates = new Map<string, Update>();
  const rest: Handoff[] = [];
  let reader: Rpc | undefined;
  // First the threads whose turn runs in a session of the plugin.
  await each(request.handoffs, 2, async (handoff) => {
    const session = text(handoff.native.session, 100);
    if (!session) {
      rest.push(handoff);
      return;
    }
    try {
      const live = await readLive(handoff, session, deadline);
      if (!live) {
        rest.push({ ...handoff, native: { ...handoff.native, session: null } });
        return;
      }
      updates.set(handoff.id, live.update);
      reader ??= live.rpc;
    } catch (error) {
      // Neither says anything about the thread, so the state and the
      // session stay as last read.
      updates.set(
        handoff.id,
        isLate(error)
          ? lateUpdate(handoff)
          : keptUpdate(handoff, previousState(handoff.native), {
              reason: reasonOf(codex, error),
            }),
      );
    }
  });
  if (rest.length > 0) {
    // The others from Codex's files, through a session still running a turn
    // in this batch, else through a new app-server that the refresh ends.
    let opened: Rpc | undefined;
    try {
      if (!reader) {
        if (deadline - Date.now() < READER_MIN_MS)
          throw new LateError(codex.late);
        opened = await connect((rest[0] as Handoff).folderId, deadline);
        reader = opened;
      }
      const rpc = reader;
      const asked = new Map<string, [string, string]>();
      for (const handoff of rest)
        asked.set(handoff.id, await ask(rpc, handoff.threadId));
      // Answers come in any order; take each thread's as it comes.
      await rpc
        .answered([...asked.values()].flat(), deadline)
        .catch((error) => {
          if (!isLate(error)) throw error;
        });
      for (const handoff of rest) {
        const [readId, turnsId] = asked.get(handoff.id) as [string, string];
        const answers = rpc.peek([readId, turnsId]);
        updates.set(
          handoff.id,
          answers
            ? answeredUpdate(
                handoff,
                answers[0] as Answer,
                answers[1] as Answer,
              )
            : keptUpdate(
                handoff,
                previousState(handoff.native),
                { reason: codex.late },
                { session: true },
              ),
        );
      }
    } catch (error) {
      // A reader can't open when both sessions run handoffs: a refresh
      // isn't a start, so it says why it waits instead.
      const reason = isLate(error)
        ? codex.late
        : isBusy(error)
          ? BUSY_READING
          : reasonOf(codex, error);
      for (const handoff of rest)
        if (!updates.has(handoff.id))
          updates.set(
            handoff.id,
            keptUpdate(
              handoff,
              previousState(handoff.native),
              { reason },
              { session: true },
            ),
          );
    } finally {
      if (opened) await closeServer(opened.session);
    }
  }
  return request.handoffs.map(
    (handoff) => updates.get(handoff.id) ?? lateUpdate(handoff),
  );
}

/** The thread's runtime status, from a thread/read answer. */
function statusOf(read: Answer): string | undefined {
  return text(record(record(read.result?.thread)?.status)?.type, 64);
}

/**
 * The turn a close interrupts: the plugin's own, else the last turn, when
 * Codex reports it in progress, such as after a start that ran out of time
 * before turn/start answered.
 */
function runningTurn(handoff: Handoff, turns: Answer): string | undefined {
  const own = text(handoff.native.turn, 100);
  if (own) return own;
  const list = turns.result?.data;
  const last = Array.isArray(list) ? record(list[0]) : undefined;
  return text(last?.status, 64) === "inProgress"
    ? text(last?.id, 100)
    : undefined;
}

/**
 * Interrupts a turn, then waits a moment for Codex to end it: Codex answers
 * the interrupt first, and ends the turn after. A turn that ended already
 * needs no interrupt.
 */
async function interrupt(
  rpc: Rpc,
  threadId: string,
  turnId: string,
  deadline: number,
): Promise<void> {
  const [answer] = (await rpc.answered(
    [await rpc.request("turn/interrupt", { threadId, turnId })],
    deadline,
  )) as [Answer];
  if (missingMethod(answer)) throw new ToolError(NO_CLOSE);
  const error = errorOf(answer);
  if (error && !TURN_ENDED.test(error))
    throw new ToolError(`Codex didn't stop the turn: ${firstLine(error)}`);
  const until = Math.min(deadline, Date.now() + STOP_WAIT_MS);
  for (;;) {
    const [read] = (await rpc.answered(
      [await rpc.request("thread/read", { threadId })],
      deadline,
    )) as [Answer];
    if (statusOf(read) !== "active" || Date.now() >= until) return;
    await pause(STOP_POLL_MS, until);
  }
}

/**
 * Stops the thread's turn when one runs where the plugin can reach it, then
 * archives the thread. A thread Codex has no record of, or archived
 * already, needs nothing.
 */
async function stopAndArchive(
  rpc: Rpc,
  handoff: Handoff,
  read: Answer,
  turns: Answer,
  deadline: number,
): Promise<void> {
  if (missingMethod(read)) throw new ToolError(NO_CLOSE);
  const readError = errorOf(read);
  if (readError) {
    if (NOT_FOUND.test(readError)) return;
    throw new ToolError(
      `Codex couldn't read the thread, so Ajour didn't archive it: ${firstLine(readError)}`,
    );
  }
  const path = text(record(read.result?.thread)?.path, 4096);
  if (path && ARCHIVED.test(path)) return;
  if (statusOf(read) === "active") {
    const turn = runningTurn(handoff, turns);
    if (!turn) throw new ToolError(UNKNOWN_TURN);
    await interrupt(rpc, handoff.threadId, turn, deadline);
  }
  const [answer] = (await rpc.answered(
    [await rpc.request("thread/archive", { threadId: handoff.threadId })],
    deadline,
  )) as [Answer];
  if (missingMethod(answer)) throw new ToolError(NO_CLOSE);
  const error = errorOf(answer);
  if (error && !NOT_FOUND.test(error) && !NO_ROLLOUT.test(error))
    throw new ToolError(`Codex didn't archive the thread: ${firstLine(error)}`);
}

/**
 * Archives the thread, as `codex archive` does: Codex keeps it, and `codex
 * unarchive` brings it back. A turn the handoff's own session runs is
 * interrupted first, through that session, which then ends. Another thread
 * is archived through a new app-server in the folder, which the close ends.
 * A turn another Codex window runs, such as the Codex app's, can't be seen
 * from here, so the close doesn't stop it.
 */
export async function closeCodex(
  request: CloseThreadRequest,
): Promise<CloseThreadResult> {
  const { handoff } = request;
  const deadline = Date.now() + CLOSE_DEADLINE_MS;
  const session = text(handoff.native.session, 100);
  let rpc: Rpc | undefined;
  let answers: Answer[] | undefined;
  let opened = false;
  let closed = false;
  try {
    if (session) {
      const own = new Rpc(session);
      try {
        answers = await own.answered(
          await ask(own, handoff.threadId),
          deadline,
        );
        rpc = own;
      } catch (error) {
        // The session ended: the thread is read from Codex's files instead.
        if (!(error instanceof SessionGone)) throw error;
      }
    }
    if (!rpc || !answers) {
      rpc = await connect(handoff.folderId, deadline);
      opened = true;
      answers = await rpc.answered(await ask(rpc, handoff.threadId), deadline);
    }
    const [read, turns] = answers as [Answer, Answer];
    await stopAndArchive(rpc, handoff, read, turns, deadline);
    closed = true;
    return {};
  } catch (error) {
    if (isBusy(error)) throw new ToolError(BUSY_CLOSING, "session_limit");
    throw closeFailure(codex, error);
  } finally {
    // The handoff's own session has nothing left to run once its thread is
    // closed. After a failure it stays, and a refresh decides, since its
    // turn may still run.
    if (rpc && (opened || closed)) await closeServer(rpc.session);
  }
}
