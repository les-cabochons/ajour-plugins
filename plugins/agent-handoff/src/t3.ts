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
// A thread id that never exists, to ask whether a T3 server answers.
const PROBE_THREAD = "ajour-detect";
// T3 can print warnings first, so these match on any line.
const NOT_RUNNING = /No running T3 Code server\b/i;
const NOT_FOUND =
  /Thread \S+ (?:is no longer available|was not found|does not exist)/i;
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
    const known = lines.find(
      (line) => NOT_RUNNING.test(line) || NOT_FOUND.test(line),
    );
    return (known ?? lines[0] ?? "").slice(0, 500);
  },
  explain: (message) =>
    NOT_RUNNING.test(message)
      ? "T3 Code isn't running. Start T3 Code, then refresh."
      : message,
};

function isNotFound(error: unknown): boolean {
  return error instanceof ToolError && NOT_FOUND.test(error.message);
}

async function showThread(threadId: string): Promise<Json> {
  const shown = record(
    await captureJson(t3, "thread-show", { thread: threadId }),
  )?.thread;
  const thread = record(shown);
  if (!thread || thread.threadId !== threadId)
    throw new ToolError("T3 Code returned another thread.");
  return thread;
}

export async function detectT3(): Promise<DetectToolsResult["tools"][number]> {
  let version: string;
  try {
    const output = firstLine(await capture(t3, "version", {}));
    version = /^t3 v?(\S+)$/i.exec(output)?.[1] ?? output;
    if (!version || version.length > 200)
      throw new ToolError("t3 returned no version.");
  } catch (error) {
    return { id: T3_TOOL, available: false, reason: reasonOf(t3, error) };
  }
  // `t3 --version` answers without a server. A missing thread tells whether
  // one runs: the server says the thread is no longer available.
  try {
    await capture(t3, "thread-show", { thread: PROBE_THREAD });
  } catch (error) {
    if (error instanceof ToolError && NOT_RUNNING.test(error.message)) {
      return {
        id: T3_TOOL,
        available: false,
        version,
        reason: reasonOf(t3, error),
      };
    }
  }
  return { id: T3_TOOL, available: true, version };
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
  const link = https(thread.link);
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
    args.base = settingText(request.settings.base) ?? "main";
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
    output = await captureJson(t3, "thread-start", args, request.prompt);
  } catch (error) {
    // Ajour stopped t3 or dropped its output, so the thread may exist.
    if (isUncertainStart(error))
      throw new ToolError(MAYBE_STARTED, (error as ToolError).code);
    throw error;
  }
  const started = record(output);
  const threadId = text(started?.threadId);
  if (!started || !threadId)
    throw new Error(
      "T3 Code returned no thread ID. Check T3 Code before handing off again.",
    );
  // The thread exists now. Keep it even if reading its link fails.
  let thread: Json = started;
  let notes: Native = {};
  try {
    thread = {
      ...started,
      ...(await before(t3, began + START_DEADLINE_MS, () =>
        showThread(threadId),
      )),
    };
  } catch (error) {
    notes = { reason: reasonOf(t3, error) };
  }
  const link = https(thread.link);
  return {
    threadId,
    ...(link ? { link } : {}),
    native: withNotes(nativeOf(thread, "working"), notes),
  };
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
    const link = https(thread.link);
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
  const show = () => before(t3, deadline, () => showThread(handoff.threadId));
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
