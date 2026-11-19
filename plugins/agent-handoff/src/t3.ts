// Hands backlog items off to T3 Code through the `t3` CLI, and reads back the
// state of each thread.
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
  UNREADABLE_OUTPUT,
  before,
  capture,
  captureJson,
  each,
  firstLine,
  https,
  isLate,
  isUncertainStart,
  listTitle,
  listed,
  oneLineTitle,
  previousState,
  reasonOf,
  record,
  refusalsFor,
  settingText,
  text,
  timeOf,
  withNotes,
  type Handoff,
  type Json,
  type Listed,
  type Native,
  type State,
  type Tool,
  type Update,
} from "./shared.ts";

type PullRequest = NonNullable<Update["pullRequests"]>[number];

export const T3_TOOL = "t3";
// T3's published thread statuses. A live thread can wait for the user while
// it stays `running`, so only `thread show`'s pendingRequestCount tells.
const LIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const STOPPED = new Set([
  "idle",
  "completed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);
const LABELS: Record<State, string> = {
  working: "Working",
  "needs-you": "Waiting for you",
  ready: "Ready for review",
  done: "Settled",
  failed: "Failed",
  gone: "Deleted in T3 Code",
  unknown: "Unknown",
};
// T3 can print warnings first, so these match on any line.
const NOT_RUNNING = /No running T3 Code server\b/i;
const NOT_FOUND =
  /Thread \S+ (?:is no longer available|was not found|does not exist)/i;
// A start's two refusals Ajour can help with (Ajour #819). T3 creates no
// thread for either, so trying again is safe.
const BRANCH_EXISTS = /Branch "[^"]*" already exists\b/i;
const BASE_MISSING = /Base ref "[^"]*" does not resolve\b/i;
/** The bases a start tries, in order, when the user gave none. */
const DEFAULT_BASES = ["main", "master"];
const SHOW_CONCURRENCY = 3;
const MAYBE_STARTED =
  "T3 Code may have started the thread. Check T3 Code before handing off again.";

const t3: Tool = {
  name: "T3 Code",
  exe: "t3",
  refusals: refusalsFor("T3 Code", "t3", {
    invalid_request:
      "Ajour refused a value for t3. Check the branch, base ref, provider and model.",
    output_limit:
      "T3 Code returned more output than Ajour accepts. Archive old threads in this project, then try again.",
  }),
  late: "T3 Code took too long; refreshing again later.",
  failureLine(value) {
    const lines = (value ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const known = lines.find((line) =>
      [NOT_RUNNING, NOT_FOUND, BRANCH_EXISTS, BASE_MISSING].some((pattern) =>
        pattern.test(line),
      ),
    );
    return (known ?? lines[0] ?? "").slice(0, 500);
  },
  explain(message) {
    if (NOT_RUNNING.test(message))
      return "T3 Code isn't running. Start T3 Code, then refresh.";
    return message;
  },
};

// T3's web app, whose thread pages the T3 Code app opens on its own scheme.
const WEB_APP = "https://app.t3.codes";
const WEB_THREAD = /^\/threads\/[^/]+\/[^/]+\/?$/;

/**
 * The thread's link, for Open. The T3 Code app routes
 * `t3code://threads/<environment>/<thread>` to the page T3's web link
 * shows, so Open goes straight to the app instead of the browser. A link to
 * another address stays the https link T3 gave.
 */
function appLink(value: unknown): string | undefined {
  const link = https(value);
  if (!link) return undefined;
  const url = new URL(link);
  return url.origin === WEB_APP && WEB_THREAD.test(url.pathname)
    ? `t3code:/${url.pathname}${url.search}`
    : link;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ToolError && NOT_FOUND.test(error.message);
}

/**
 * Reads one thread. `t3 thread show` takes no folder, but T3 creates the
 * folder it starts in and fails at the system root (#53), so the command
 * declares the repository folder as its `cwd` and Ajour starts it there.
 */
async function showThread(threadId: string, folder: string): Promise<Json> {
  const shown = record(
    await captureJson(t3, "thread-show", { thread: threadId, folder }),
  )?.thread;
  const thread = record(shown);
  if (!thread || thread.threadId !== threadId)
    throw new ToolError("T3 Code returned another thread.");
  return thread;
}

/**
 * T3 Code is available once `t3 --version` answers. Detection names no
 * folder, so Ajour starts it at the system root, where every t3 command that
 * reaches the server fails. So it never asks whether a server runs: a start
 * or refresh says so.
 */
export async function detectT3(): Promise<DetectToolsResult["tools"][number]> {
  try {
    const output = firstLine(await capture(t3, "version", {}));
    const version = /^t3 v?(\S+)$/i.exec(output)?.[1] ?? output;
    if (!version || version.length > 200)
      throw new ToolError("t3 returned no version.");
    return { id: T3_TOOL, available: true, version };
  } catch (error) {
    return { id: T3_TOOL, available: false, reason: reasonOf(t3, error) };
  }
}

/** The common state of a thread T3 returned. */
function stateOf(thread: Json): State {
  // An archived thread is put away like a settled one, so the host stops
  // refreshing it after a day.
  if (thread.settled === true || thread.archived === true) return "done";
  if (
    typeof thread.pendingRequestCount === "number" &&
    thread.pendingRequestCount > 0
  )
    return "needs-you";
  const status = typeof thread.status === "string" ? thread.status : "";
  if (LIVE.has(status)) return "working";
  if (STOPPED.has(status)) return "ready";
  if (status === "failed") return "failed";
  return "unknown";
}

// Keep a small allowlist of T3's fields. Never store messages or paths.
function nativeOf(thread: Json, state: State): Native {
  const archived =
    state === "done" && thread.settled !== true && thread.archived === true;
  const native: Native = {
    state,
    label: archived ? "Archived" : LABELS[state],
  };
  const status = text(thread.status, 64);
  if (status) native.status = status;
  const projectId = text(thread.projectId);
  if (projectId) native.projectId = projectId;
  for (const key of ["settled", "snoozed", "archived"] as const)
    if (typeof thread[key] === "boolean") native[key] = thread[key];
  if (thread.snoozedUntil === null || text(thread.snoozedUntil, 64))
    native.snoozedUntil = thread.snoozedUntil as string | null;
  if (typeof thread.pendingRequestCount === "number")
    native.pendingRequestCount = thread.pendingRequestCount;
  return native;
}

/** T3's title for a pull request, or `repository#number` when it gives none. */
function pullRequestTitle(pr: Json): string | undefined {
  const title = text(pr.title, 500);
  if (title) return title;
  const repository = text(pr.repository, 400);
  return repository &&
    typeof pr.number === "number" &&
    Number.isSafeInteger(pr.number) &&
    pr.number > 0
    ? `${repository}#${pr.number}`
    : undefined;
}

/**
 * The thread's pull requests. Only `thread list` prints the list, so a
 * thread read with `thread show` alone returns none, and the host keeps the
 * ones it had.
 */
function pullRequestsOf(thread: Json): PullRequest[] | undefined {
  if (!Array.isArray(thread.pullRequests)) return undefined;
  const candidates = [...thread.pullRequests, thread.linkedPullRequest];
  const result: PullRequest[] = [];
  for (const candidate of candidates) {
    const pr = record(candidate);
    const url = https(pr?.url);
    if (!pr || !url || result.some((known) => known.url === url)) continue;
    const title = pullRequestTitle(pr);
    result.push(title ? { url, title } : { url });
    if (result.length === 100) break;
  }
  return result;
}

function updateOf(id: string, thread: Json, notes: Native = {}): Update {
  const state = stateOf(thread);
  const title = text(thread.title, 500);
  const branch = text(thread.branch, 500);
  const link = appLink(thread.link);
  const pullRequests = pullRequestsOf(thread);
  return {
    id,
    state,
    native: withNotes(nativeOf(thread, state), notes),
    ...(pullRequests ? { pullRequests } : {}),
    ...(title ? { title } : {}),
    ...(branch ? { branch } : {}),
    ...(link ? { link } : {}),
  };
}

/** Keeps the last state read, with what is new about it. */
function keptUpdate(
  id: string,
  previous: Json,
  state: State,
  notes: Native,
): Update {
  const kept = nativeOf(previous, previousState(previous));
  return { id, state, native: withNotes(kept, notes) };
}

export async function startT3(
  request: StartHandoffRequest,
): Promise<StartHandoffResult> {
  const began = Date.now();
  const args: Record<string, string> = {
    folder: request.folder.id,
    title: oneLineTitle(request.title),
  };
  if (request.settings.worktree !== false) {
    const branch = settingText(request.branch);
    if (!branch)
      throw new Error(
        "Name a branch for the T3 worktree, or turn off Create a worktree.",
      );
    args.branch = branch;
  }
  const provider = settingText(request.settings.provider);
  const model = settingText(request.settings.model);
  // t3 takes --model alone, but --provider only with --model.
  if (provider && !model)
    throw new Error(
      "Set a model for the provider, or leave the provider empty.",
    );
  if (provider) args.provider = provider;
  if (model) args.model = model;
  let output: unknown;
  try {
    output = args.branch
      ? await startOnBase(request, args, began + START_DEADLINE_MS)
      : await captureJson(t3, "thread-start", args, request.prompt);
  } catch (error) {
    // Ajour stopped t3 or dropped its output, t3 exited 0 with output Ajour
    // can't read, or the start's deadline came while t3 ran, so the thread
    // may exist. An unreadable answer keeps what t3 printed first, so the
    // user and the log see why.
    if (isUncertainStart(error) || isLate(error)) {
      const { code, message } = error as ToolError;
      throw new ToolError(
        code === UNREADABLE_OUTPUT
          ? `${MAYBE_STARTED} ${message}`
          : MAYBE_STARTED,
        code,
      );
    }
    throw error;
  }
  const started = record(output);
  const threadId = text(started?.threadId);
  if (!started || !threadId)
    throw new Error(
      "T3 Code returned no thread ID. Check T3 Code before handing off again.",
    );
  // The thread exists now. Keep it even if reading its link fails.
  // `thread show` reads the one new thread by id: unlike the folder's list,
  // its output doesn't grow with the project's threads.
  let thread: Json = started;
  let notes: Native = {};
  try {
    thread = {
      ...started,
      ...(await before(t3, began + START_DEADLINE_MS, () =>
        showThread(threadId, request.folder.id),
      )),
    };
  } catch (error) {
    notes = { reason: reasonOf(t3, error) };
  }
  const link = appLink(thread.link);
  return {
    threadId,
    ...(link ? { link } : {}),
    native: withNotes(nativeOf(thread, "working"), notes),
  };
}

/**
 * A refusal Ajour can act on (Ajour #819): it asks for the tool's `setting`,
 * or offers the item's thread when `branchExists`. Older Ajour shows the
 * message alone.
 */
function refusedFor(
  message: string,
  hint: { setting: string } | { branchExists: true },
): ToolError {
  return Object.assign(new ToolError(message), hint);
}

/**
 * Starts the thread in a worktree. The base the user gave is tried alone.
 * Without one, `main`, then `master`: T3 refuses a base the repository and
 * its remotes don't have before it creates anything. A missing base is
 * refused as the `base` setting, so Ajour asks for it, and a branch that
 * exists as `branchExists`, so Ajour offers the item's thread.
 *
 * The attempts share the start's `deadline`: each command may take 20
 * seconds, so a slow refusal of `main` leaves `master` only the rest, and
 * Ajour gets the answer before it ends the operation at 30.
 */
async function startOnBase(
  request: StartHandoffRequest,
  args: Record<string, string>,
  deadline: number,
): Promise<unknown> {
  const given = settingText(request.settings.base);
  const bases = given ? [given] : DEFAULT_BASES;
  const folder = request.folder.name;
  for (const base of bases) {
    try {
      return await before(t3, deadline, () =>
        captureJson(t3, "thread-start", { ...args, base }, request.prompt),
      );
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== undefined)
        throw error;
      if (BRANCH_EXISTS.test(error.message))
        throw refusedFor(
          `The branch "${args.branch}" already exists in ${folder}, so T3 Code started no thread. Hand off with another branch from Review prompt.`,
          { branchExists: true },
        );
      if (!BASE_MISSING.test(error.message)) throw error;
    }
  }
  throw refusedFor(
    given
      ? `"${given}" doesn't exist in ${folder}, so T3 Code can't start the worktree. Name the branch it starts from.`
      : `Neither "main" nor "master" exists in ${folder}, so T3 Code can't start the worktree. Name the branch it starts from.`,
    { setting: "base" },
  );
}

/** A folder's threads, newest first, as T3 lists them. */
async function folderThreads(folder: string, deadline: number) {
  const list = await before(t3, deadline, () =>
    captureJson(t3, "thread-list", { folder }),
  );
  if (!Array.isArray(list))
    throw new ToolError("T3 Code returned a thread list Ajour can't read.");
  return list.flatMap((value) => {
    const thread = record(value);
    return thread ? [thread] : [];
  });
}

/**
 * The folder's threads, as a start would have answered for each: its id,
 * link and native state, with T3's title and last change. A subagent's
 * thread works for its parent, so only top-level threads are listed.
 */
export async function listT3(
  request: ListThreadsRequest,
): Promise<ListThreadsResult> {
  let threads: Json[];
  try {
    threads = await folderThreads(
      request.folder.id,
      Date.now() + READ_DEADLINE_MS,
    );
  } catch (error) {
    throw new ToolError(
      reasonOf(t3, error),
      error instanceof ToolError ? error.code : undefined,
    );
  }
  const result: Listed[] = [];
  for (const thread of threads) {
    const threadId = text(thread.threadId);
    const title = listTitle(thread.title);
    if (!threadId || !title || thread.parentThreadId) continue;
    const link = appLink(thread.link);
    const updatedAt = timeOf(thread.updatedAt);
    result.push({
      threadId,
      title,
      ...(link ? { link } : {}),
      native: nativeOf(thread, stateOf(thread)),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    });
  }
  return listed(result, request);
}

/** The last state read, kept because T3 didn't answer in time. */
function lateUpdate(handoff: Handoff): Update {
  return keptUpdate(handoff.id, handoff.native, previousState(handoff.native), {
    reason: t3.late,
  });
}

function goneUpdate(handoff: Handoff): Update {
  return keptUpdate(handoff.id, handoff.native, "gone", {
    state: "gone",
    label: LABELS.gone,
  });
}

async function readThread(
  handoff: Handoff,
  listed: Json | undefined,
  deadline: number,
) {
  const show = () =>
    before(t3, deadline, () => showThread(handoff.threadId, handoff.folderId));
  if (!listed) {
    // Archived threads leave the list, but `thread show` still finds them.
    // Only T3 saying the thread doesn't exist makes it gone.
    try {
      return updateOf(handoff.id, await show(), { missing: true });
    } catch (error) {
      if (isLate(error)) return lateUpdate(handoff);
      if (isNotFound(error)) return goneUpdate(handoff);
      return keptUpdate(
        handoff.id,
        handoff.native,
        previousState(handoff.native),
        { missing: true, reason: reasonOf(t3, error) },
      );
    }
  }
  if (stateOf(listed) === "done" || !LIVE.has(String(listed.status)))
    return updateOf(handoff.id, listed);
  // The list leaves out pendingRequestCount, so read each live thread.
  try {
    return updateOf(handoff.id, { ...listed, ...(await show()) });
  } catch (error) {
    if (isLate(error)) return lateUpdate(handoff);
    if (isNotFound(error)) return goneUpdate(handoff);
    return updateOf(handoff.id, listed, { reason: reasonOf(t3, error) });
  }
}

export async function readT3(
  request: ReadHandoffStatesRequest,
): Promise<ReadHandoffStatesResult> {
  // Past the deadline, the remaining threads keep their last state.
  const deadline = Date.now() + READ_DEADLINE_MS;
  const updates = new Map<string, Update>();
  const folders = new Map<string, Handoff[]>();
  for (const handoff of request.handoffs)
    folders.set(handoff.folderId, [
      ...(folders.get(handoff.folderId) ?? []),
      handoff,
    ]);
  for (const [folder, handoffs] of folders) {
    let threads: Map<string, Json>;
    try {
      threads = new Map(
        (await folderThreads(folder, deadline)).flatMap((thread) => {
          const id = text(thread.threadId);
          return id ? [[id, thread] as const] : [];
        }),
      );
    } catch (error) {
      if (isLate(error)) {
        for (const handoff of handoffs)
          updates.set(handoff.id, lateUpdate(handoff));
        continue;
      }
      // An unreachable server says nothing about the threads. Never gone.
      for (const handoff of handoffs)
        updates.set(
          handoff.id,
          keptUpdate(handoff.id, handoff.native, "unknown", {
            label: LABELS.unknown,
            reason: reasonOf(t3, error),
          }),
        );
      continue;
    }
    await each(handoffs, SHOW_CONCURRENCY, async (handoff) => {
      updates.set(
        handoff.id,
        await readThread(handoff, threads.get(handoff.threadId), deadline),
      );
    });
  }
  return request.handoffs.map((handoff) => updates.get(handoff.id) as Update);
}
