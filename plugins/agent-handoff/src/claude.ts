// Hands backlog items off to Claude Code as background sessions (`claude
// --bg`), and reads their state back from `claude agents --json --all`. A
// start's HTTP hooks tell Ajour when to read it again. Two tools share this
// code: Claude Code opens a session in a terminal, and Claude Code desktop
// opens it in the Claude desktop app.
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
  READ_DEADLINE_MS,
  START_DEADLINE_MS,
  ToolError,
  before,
  capture,
  captureJson,
  firstLine,
  isLate,
  isUncertainStart,
  launch,
  listTitle,
  listed,
  oneLineTitle,
  pause,
  previousState,
  reasonOf,
  record,
  refusalsFor,
  settingText,
  text,
  withNotes,
  type Handoff,
  type Json,
  type Listed,
  type Native,
  type State,
  type Tool,
  type Update,
} from "./shared.ts";

export const CLAUDE_TOOL = "claude";
/** The same sessions, opened in the Claude desktop app instead of a terminal. */
export const CLAUDE_DESKTOP_TOOL = "claude-desktop";
const LABELS: Record<State, string> = {
  working: "Working",
  "needs-you": "Waiting for you",
  ready: "Done",
  done: "Done",
  failed: "Failed",
  gone: "Gone",
  unknown: "Unknown",
};
const UNTRUSTED = /Workspace not trusted\b/i;
// The folder Claude Code names when it refuses one, such as C:\ or /.
const UNTRUSTED_ROOT = /Run `?claude`? in (?:[A-Za-z]:\\?|\/) once\b/i;
// A session id the plugin keeps as the thread id: a bounded, flag-free token.
const SESSION_ID = /^[A-Za-z0-9._:][A-Za-z0-9:._-]{0,199}$/;
// A background job's short id, which `claude attach` takes.
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// The Claude desktop app's resume link takes only a UUID session id.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAYBE_STARTED =
  "Claude Code may have started the session. Check claude agents before handing off again.";
const TRUST_FIRST =
  "Trust this folder in Claude Code first: run claude in the repository folder once and accept the trust prompt, then hand off again.";
const TRUST_OPENED =
  "Claude Code doesn't trust this folder yet. Ajour opened Claude Code in a terminal there: accept its trust prompt, then hand off again.";
// Open attaches to a listed job. Once `claude rm` removes the job, only its
// transcript is left, which `claude --resume` reopens, and which the Claude
// app still imports.
const missing = (sessionId: string, app: boolean) =>
  app
    ? "Claude Code no longer lists this session, such as after claude rm. Open still opens it in the Claude app."
    : `Claude Code no longer lists this session, such as after claude rm, so Open can't attach to it. Run claude --resume ${sessionId} in the repository folder.`;
const RELEASED =
  "Claude Code waits for you. Ajour stopped its background session so the Claude app can take it over: open it there and answer, or tell it to go on.";
const NOT_RELEASED =
  "Ajour couldn't stop Claude Code's background session, so the Claude app can't go on with it yet. Ajour tries again at the next refresh.";

const claude: Tool = {
  name: "Claude Code",
  exe: "claude",
  refusals: refusalsFor("Claude Code", "claude", {
    invalid_request:
      "Ajour refused a value for claude. Check the model; a terminal also needs a repository folder path without unusual characters.",
    output_limit:
      "Claude Code listed more sessions than Ajour accepts. Remove old background sessions with claude rm, then try again.",
    hook_refused:
      "Ajour refused this start's hook address, so it didn't start Claude Code. Hand off again, or update Ajour.",
  }),
  late: "Claude Code took too long; refreshing again later.",
  failureLine(value) {
    // `claude --bg` prints progress and warnings on stderr even when it works.
    const lines = (value ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line &&
          !/^Starting background service/i.test(line) &&
          !/^warning:/i.test(line),
      );
    return (lines.find((line) => UNTRUSTED.test(line)) ?? lines[0] ?? "").slice(
      0,
      500,
    );
  },
  explain(message) {
    if (UNTRUSTED_ROOT.test(message))
      return "Ajour started Claude Code at the system root instead of the repository folder, so Claude Code refused it. This needs an Ajour update.";
    if (UNTRUSTED.test(message)) return TRUST_FIRST;
    return message;
  },
};

/**
 * Both Claude tools run the same claude, so one `claude --version` answers
 * for both. Whether the Claude desktop app is installed isn't checked: Open
 * fails without it.
 */
export async function detectClaude(): Promise<DetectToolsResult["tools"]> {
  let found:
    { available: true; version: string } | { available: false; reason: string };
  try {
    const output = firstLine(await capture(claude, "claude-version", {}));
    const version = /^v?(\S+)\s+\(Claude Code\)$/i.exec(output)?.[1] ?? output;
    if (!version || version.length > 200)
      throw new ToolError("claude returned no version.");
    found = { available: true, version };
  } catch (error) {
    found = { available: false, reason: reasonOf(claude, error) };
  }
  return [
    { id: CLAUDE_TOOL, ...found },
    { id: CLAUDE_DESKTOP_TOOL, ...found },
  ];
}

/**
 * Every session `claude agents --json --all` lists, or only those started
 * under a folder, with `--cwd`.
 */
async function listSessions(folder?: string): Promise<Json[]> {
  const list = await (folder
    ? captureJson(claude, "claude-agents-folder", { folder })
    : captureJson(claude, "claude-agents", {}));
  if (!Array.isArray(list))
    throw new ToolError(
      "Claude Code returned a session list Ajour can't read.",
    );
  return list.flatMap((value) => {
    const session = record(value);
    return session ? [session] : [];
  });
}

/** True while a process runs the session, so its status is live. */
function live(session: Json): boolean {
  return typeof session.status === "string";
}

/** A background job's short id, which `claude attach` takes. */
function jobOf(session: Json): string | undefined {
  const job = text(session.id, 64);
  return job && JOB_ID.test(job) ? job : undefined;
}

/**
 * The sessions by session id. A session can be listed twice, such as a
 * stopped background job the user resumed in a terminal; the live one wins,
 * with the job's id from whichever entry has it, so Open still attaches.
 */
function bySessionId(sessions: Json[]): Map<string, Json> {
  const result = new Map<string, Json>();
  for (const session of sessions) {
    const id = text(session.sessionId);
    if (!id) continue;
    const known = result.get(id);
    if (!known) {
      result.set(id, session);
      continue;
    }
    const [winner, other] =
      !live(known) && live(session) ? [session, known] : [known, session];
    const job = jobOf(winner) ?? jobOf(other);
    result.set(id, job ? { ...winner, id: job } : winner);
  }
  return result;
}

/**
 * The common state of a session. `state` is a background job's lifecycle:
 * working, blocked, done, failed or stopped. `status` and `waitingFor` are a
 * running process's live detail, and the only fields of an interactive one.
 */
function stateOf(session: Json): State {
  const state = text(session.state, 64);
  const status = text(session.status, 64);
  if (state === "failed") return "failed";
  // Claude Code has no settled state. A finished or stopped session can take
  // another turn, so it is ready for review, never done.
  if (state === "stopped") return "ready";
  if (state === "blocked" || text(session.waitingFor) || status === "waiting")
    return "needs-you";
  if (state === "working" || status === "busy") return "working";
  if (state === "done" || status === "idle") return "ready";
  return "unknown";
}

function capitalized(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Keep a small allowlist of Claude's fields. Never store the folder or pid.
function nativeOf(session: Json, state: State): Native {
  const claudeState = text(session.state, 64);
  const status = text(session.status, 64);
  const waitingFor = text(session.waitingFor);
  const native: Native = {
    state,
    // Claude Code's own words: what it waits for, else its state or status.
    label: capitalized(waitingFor ?? claudeState ?? status ?? LABELS[state]),
  };
  const kind = text(session.kind, 64);
  if (kind) native.kind = kind;
  if (claudeState) native.claudeState = claudeState;
  if (status) native.status = status;
  if (waitingFor) native.waitingFor = waitingFor;
  const job = text(session.id, 64);
  if (job) native.job = job;
  return native;
}

function updateOf(id: string, session: Json): Update {
  const state = stateOf(session);
  const title = text(session.name, 500);
  return {
    id,
    state,
    native: nativeOf(session, state),
    ...(title ? { title } : {}),
  };
}

const KEPT = [
  "label",
  "kind",
  "claudeState",
  "status",
  "waitingFor",
  "job",
] as const;

/** Keeps the last state read, with what is new about it. */
function keptUpdate(handoff: Handoff, state: State, notes: Native): Update {
  const previous = handoff.native;
  const kept: Native = { state: previousState(previous) };
  for (const key of KEPT) {
    const value = text(previous[key]);
    if (value) kept[key] = value;
  }
  // A session the plugin stopped for the Claude app still waits for you.
  if (previous.released === true) kept.released = true;
  return { id: handoff.id, state, native: withNotes(kept, notes) };
}

/** True when claude refused the repository folder because it doesn't trust it. */
function untrusted(error: unknown): boolean {
  return (
    error instanceof ToolError &&
    error.code === undefined &&
    UNTRUSTED.test(error.message) &&
    !UNTRUSTED_ROOT.test(error.message)
  );
}

/**
 * Claude Code asks whether to trust a folder only in an interactive session,
 * and `--bg` refuses a folder it doesn't trust yet. So the plugin opens
 * claude in a terminal in the folder, where the user accepts the prompt and
 * hands off again. Returns what to tell the user.
 */
async function openTrustPrompt(
  folder: string,
  deadline: number,
): Promise<string> {
  try {
    await before(claude, deadline, () =>
      launch(claude, "claude-trust", { folder }),
    );
    return TRUST_OPENED;
  } catch (error) {
    return `${TRUST_FIRST} Ajour couldn't open a terminal: ${reasonOf(claude, error)}`;
  }
}

/**
 * Open attaches a terminal to the job, which also wakes a stopped one.
 * `claude --resume` can't open a job that is still running once it is given
 * a folder, and a terminal needs one: Ajour opens it in its first folder
 * argument. `claude attach` ignores that extra argument, with a warning.
 */
function attach(job: string, folder: string) {
  return { command: "claude-attach", args: { job, folder } };
}

/**
 * The Claude desktop app's link for a session: the app imports the CLI
 * session, from its transcript, and opens it. It can't take a turn while a
 * background job still runs the session; see `release`.
 */
function desktopLink(sessionId: string): string | undefined {
  return UUID.test(sessionId)
    ? `claude://resume?session=${sessionId}`
    : undefined;
}

/** True for the tool that opens sessions in the Claude desktop app. */
function opensInApp(request: { tool: string }): boolean {
  return request.tool === CLAUDE_DESKTOP_TOOL;
}

export async function startClaude(
  request: StartHandoffRequest,
): Promise<StartHandoffResult> {
  const app = opensInApp(request);
  const deadline = Date.now() + START_DEADLINE_MS;
  const args: Record<string, string> = {
    folder: request.folder.id,
    title: oneLineTitle(request.title),
  };
  const model = settingText(request.settings.model);
  if (model) args.model = model;
  // With a hook, Ajour writes its URL into the manifest's `--settings`
  // template, whose HTTP hooks post when the session stops, needs the user
  // or ends; the plugin never passes the URL. Without one, such as a start
  // Ajour gives no hook, the broker would refuse that command.
  const command = request.hook ? "claude-start-hook" : "claude-start";
  let output: string;
  try {
    // The prompt goes on stdin, never on the command line.
    output = await capture(claude, command, args, request.prompt);
  } catch (error) {
    // Ajour stopped claude or dropped its output, so the session may exist.
    if (isUncertainStart(error))
      throw new ToolError(MAYBE_STARTED, (error as ToolError).code);
    if (untrusted(error))
      throw new ToolError(await openTrustPrompt(request.folder.id, deadline));
    throw new ToolError(
      reasonOf(claude, error),
      error instanceof ToolError ? error.code : undefined,
    );
  }
  // `backgrounded · e2cf2a01 · <name>`: the job's short id, not the session's.
  const job =
    /\bbackgrounded\b[^A-Za-z0-9]+([A-Za-z0-9][A-Za-z0-9_-]{0,63})/i.exec(
      output,
    )?.[1];
  if (!job)
    throw new ToolError(
      "Claude Code printed no session id. Check claude agents before handing off again.",
    );
  // `--bg` chooses the session id, so read it from the list. The job is
  // listed as soon as `claude --bg` returns; a second read covers a slow one.
  let session: Json | undefined;
  let failure: unknown;
  for (let attempt = 0; attempt < 3 && !session; attempt++) {
    if (attempt > 0) await pause(1000, deadline);
    try {
      const sessions = await before(claude, deadline, () => listSessions());
      session = sessions.find((candidate) => candidate.id === job);
      failure = undefined;
    } catch (error) {
      failure = error;
      if (isLate(error)) break;
    }
  }
  const sessionId = text(session?.sessionId);
  if (!session || !sessionId || !SESSION_ID.test(sessionId))
    throw new ToolError(
      `Claude Code started background session ${job}, but Ajour couldn't read its session ID${
        failure ? ` (${reasonOf(claude, failure)})` : ""
      }. Open it with claude attach ${job} instead of handing off again.`,
    );
  const resume = attach(job, request.folder.id);
  const link = app ? desktopLink(sessionId) : undefined;
  let notes: Native = {};
  // The desktop tool has no start mode: the app can't open the session
  // until its turn ends.
  if (!app && request.settings.startMode === "terminal") {
    // The prompt can't go through a terminal, so the session starts in the
    // background with it, and the terminal attaches to that session.
    try {
      await before(claude, deadline, () =>
        launch(claude, resume.command, resume.args),
      );
    } catch (error) {
      notes = {
        reason: `The session runs in the background, but Ajour couldn't open a terminal: ${reasonOf(claude, error)}`,
      };
    }
  }
  return {
    threadId: sessionId,
    // Ajour opens the link when there is one, else the resume command.
    ...(link ? { link } : {}),
    resume,
    native: withNotes(nativeOf(session, "working"), notes),
  };
}

/**
 * The sessions Claude Code lists as started under the folder, newest first,
 * as a start would have answered for each. A background job opens by
 * attaching to it, or in the Claude app for the desktop tool; an interactive
 * session has no job, and is open in its terminal already. Claude Code
 * doesn't say when a session last changed, so `since` lists them all.
 */
export async function listClaude(
  request: ListThreadsRequest,
): Promise<ListThreadsResult> {
  const app = opensInApp(request);
  let sessions: Json[];
  try {
    sessions = [
      ...bySessionId(
        await before(claude, Date.now() + READ_DEADLINE_MS, () =>
          listSessions(request.folder.id),
        ),
      ).values(),
    ];
  } catch (error) {
    throw new ToolError(
      reasonOf(claude, error),
      error instanceof ToolError ? error.code : undefined,
    );
  }
  const started = (session: Json) =>
    typeof session.startedAt === "number" ? session.startedAt : 0;
  const threads: Listed[] = [];
  for (const session of sessions.sort((a, b) => started(b) - started(a))) {
    const threadId = text(session.sessionId);
    const title = listTitle(session.name);
    if (!threadId || !SESSION_ID.test(threadId) || !title) continue;
    const job = jobOf(session);
    const link = app && job ? desktopLink(threadId) : undefined;
    threads.push({
      threadId,
      title,
      ...(link ? { link } : {}),
      ...(job ? { resume: attach(job, request.folder.id) } : {}),
      native: nativeOf(session, stateOf(session)),
    });
  }
  return listed(threads, { limit: request.limit });
}

/**
 * The desktop tool's update once the plugin read the session. The Claude app
 * can't take a turn in a session a background job runs, even a job whose
 * turn ended, so once the job is done or waits for the user, the plugin
 * stops it with `claude stop`, and the app can open the session. A job
 * that works is left alone. A session stopped while it waited for the user
 * stays Waiting for you until a process runs it again, such as the app's.
 */
async function release(
  handoff: Handoff,
  session: Json,
  update: Update,
  deadline: number,
): Promise<Update> {
  const job = jobOf(session);
  const waits = update.state === "needs-you";
  if (
    session.kind === "background" &&
    live(session) &&
    job &&
    (waits || update.state === "ready")
  ) {
    try {
      await before(claude, deadline, () =>
        capture(claude, "claude-stop", { job }),
      );
    } catch (error) {
      // A stop that outlived the deadline still runs and may stop the job,
      // so a job that waited stays released: `released` only counts once no
      // process runs the session, and a job still live is stopped again.
      return {
        ...update,
        native: withNotes(
          {
            ...(update.native as Native),
            ...(waits ? { released: true } : {}),
          },
          { reason: `${NOT_RELEASED} ${reasonOf(claude, error)}` },
        ),
      };
    }
    return waits ? released(update, update.native as Native) : update;
  }
  // A stopped job's listing no longer says it waited for the user, or for
  // what: the kept `waitingFor` does, since a failed read can replace the
  // label with Unknown.
  if (handoff.native.released === true && !live(session)) {
    const waitingFor = text(handoff.native.waitingFor);
    return released(update, {
      ...(update.native as Native),
      ...(waitingFor ? { waitingFor } : {}),
      label: waitingFor ? capitalized(waitingFor) : LABELS["needs-you"],
    });
  }
  return update;
}

/** Waiting for you, in a session the plugin stopped for the Claude app. */
function released(update: Update, native: Native): Update {
  return {
    ...update,
    state: "needs-you",
    native: withNotes(
      { ...native, state: "needs-you", released: true },
      { reason: RELEASED },
    ),
  };
}

export async function readClaude(
  request: ReadHandoffStatesRequest,
): Promise<ReadHandoffStatesResult> {
  if (request.handoffs.length === 0) return [];
  const app = opensInApp(request);
  const deadline = Date.now() + READ_DEADLINE_MS;
  // One list per refresh covers every folder.
  let sessions: Map<string, Json>;
  try {
    sessions = bySessionId(
      await before(claude, deadline, () => listSessions()),
    );
  } catch (error) {
    if (isLate(error))
      return request.handoffs.map((handoff) =>
        keptUpdate(handoff, previousState(handoff.native), {
          reason: claude.late,
        }),
      );
    // A failed list says nothing about the sessions. Never gone.
    return request.handoffs.map((handoff) =>
      keptUpdate(handoff, "unknown", {
        label: LABELS.unknown,
        reason: reasonOf(claude, error),
      }),
    );
  }
  const updates: Update[] = [];
  for (const handoff of request.handoffs) {
    const session = sessions.get(handoff.threadId);
    if (!session) {
      // A missing session is no evidence it is gone: `claude rm` keeps the
      // transcript, and an interactive session leaves the list when it
      // closes.
      updates.push(
        keptUpdate(handoff, previousState(handoff.native), {
          missing: true,
          reason: missing(handoff.threadId, app),
        }),
      );
      continue;
    }
    const update = updateOf(handoff.id, session);
    updates.push(
      app ? await release(handoff, session, update, deadline) : update,
    );
  }
  return updates;
}
