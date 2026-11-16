// Hands backlog items off to T3 Code through the `t3` CLI, and reads back the
// state of each thread. Every command runs through Ajour's process broker, as
// declared in plugin.json's `processes` block.
import type {
  DetectToolsResult,
  PluginModule,
  ReadHandoffStatesRequest,
  ReadHandoffStatesResult,
  StartHandoffRequest,
  StartHandoffResult,
} from "@ajour/plugin-sdk";
import type {} from "@ajour/plugin-sdk/globals";

type Update = ReadHandoffStatesResult[number];
type State = Update["state"];
type PullRequest = NonNullable<Update["pullRequests"]>[number];
type Json = Record<string, unknown>;
type Native = Record<string, string | number | boolean | null>;

const TOOL = "t3";
const STATES: readonly State[] = [
  "working",
  "needs-you",
  "ready",
  "done",
  "failed",
  "gone",
  "unknown",
];
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
const NATIVE_LIMIT = 4096;
const SHOW_CONCURRENCY = 3;
// The host ends an operation after 30 seconds. A refresh stops waiting for
// T3 before that. A start gives thread start 20 seconds (plugin.json), then
// stops waiting for the new thread's link at 27, which leaves time to spawn.
const READ_DEADLINE_MS = 20_000;
const START_DEADLINE_MS = 27_000;
const LATE = "T3 Code took too long; refreshing again later.";
// Ajour stopped t3 before its output was whole. A refresh treats these like
// its own deadline, and a start can't tell whether the thread exists.
const CUT_SHORT = new Set(["timeout", "capture_incomplete"]);
const START_UNCERTAIN = new Set([...CUT_SHORT, "output_limit"]);
const MAYBE_STARTED =
  "T3 Code may have started the thread. Check T3 Code before handing off again.";

/** A failed or refused `t3` command, with the line T3 printed about it. */
class T3Error extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "T3Error";
    this.code = code;
  }
}

/** The operation's deadline passed before T3 answered. */
class LateError extends T3Error {
  constructor() {
    super(LATE, "late");
  }
}

function firstLine(value: string | undefined): string {
  return (value ?? "").trim().split(/\r?\n/, 1)[0]?.slice(0, 500) ?? "";
}

/** The line of T3's output that says why it failed. */
function t3Line(value: string | undefined): string {
  const lines = (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const known = lines.find(
    (line) => NOT_RUNNING.test(line) || NOT_FOUND.test(line),
  );
  return (known ?? lines[0] ?? "").slice(0, 500);
}

// What the user can do about each refusal from Ajour's process broker.
const REFUSALS: Record<string, string> = {
  executable_missing:
    "T3 Code isn't installed, or its t3 command isn't on PATH.",
  timeout: "T3 Code didn't answer in time. Try again.",
  invalid_request:
    "Ajour refused a value for t3. Check the branch, base ref, provider and model.",
  needs_consent:
    "Open this plugin's Access section in Settings › Plugins and choose Allow and activate.",
  unsigned_processes_off:
    "Turn on Unsigned plugins can start processes in Settings › Plugins.",
  process_acceptance_required:
    "Allow this plugin to start processes on its page.",
  package_unverified:
    "Ajour can't verify this plugin's package, so it blocks its commands. Reinstall the plugin.",
  plugin_off: "Turn this plugin on in Settings › Plugins.",
  undeclared:
    "This plugin asked for a command it doesn't declare. Update the plugin.",
  folder_refused:
    "Ajour couldn't use this project's repository folder. Check the folder in the project's settings.",
  spawn_refused:
    "Ajour couldn't start t3 safely (an unusual launcher, an argument it can't pass, or a command line that's too long). Check the T3 Code install and this handoff's title.",
  spawn_failed: "t3 failed to start. Try again.",
  concurrency: "Ajour is busy with other T3 Code commands; try again.",
  rate_limit:
    "Ajour is limiting this plugin's commands. Try again in a minute.",
  output_limit:
    "T3 Code returned more output than Ajour accepts. Archive old threads in this project, then try again.",
  capture_incomplete: "Ajour couldn't read all of T3 Code's output. Try again.",
  operation_ended: "Ajour stopped waiting for T3 Code. Try again.",
};

function refusal(error: unknown): T3Error {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  if (code && Object.hasOwn(REFUSALS, code))
    return new T3Error(REFUSALS[code] as string, code);
  if (code) return new T3Error(`Ajour couldn't run t3 (${code}).`, code);
  return new T3Error(
    firstLine(error instanceof Error ? error.message : undefined) ||
      "Ajour couldn't run t3.",
  );
}

/** True when T3 didn't answer in time, by the plugin's deadline or Ajour's. */
function isLate(error: unknown): boolean {
  return (
    error instanceof LateError ||
    (error instanceof T3Error &&
      error.code !== undefined &&
      CUT_SHORT.has(error.code))
  );
}

/** Runs `work`, or throws a LateError once `deadline` passes. */
async function before<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) throw new LateError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LateError()), left);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a declared capture command and returns its stdout, or throws. */
async function capture(
  command: string,
  args: Record<string, string>,
  stdin?: string,
): Promise<string> {
  let result: Awaited<ReturnType<typeof ajour.process.run>>;
  try {
    result = await ajour.process.run({
      command,
      args,
      ...(stdin === undefined ? {} : { stdin }),
    });
  } catch (error) {
    throw refusal(error);
  }
  if (result.started === true)
    throw new T3Error("t3 started without returning its output.");
  if (result.exitCode !== 0) {
    throw new T3Error(
      t3Line(result.stderr) ||
        t3Line(result.stdout) ||
        `t3 exited with ${result.exitCode ?? "a signal"}.`,
    );
  }
  return result.stdout;
}

async function captureJson(
  command: string,
  args: Record<string, string>,
  stdin?: string,
): Promise<unknown> {
  const output = await capture(command, args, stdin);
  try {
    return JSON.parse(output);
  } catch {
    throw new T3Error("T3 Code returned output Ajour can't read.");
  }
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function text(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

function https(value: unknown): string | undefined {
  const candidate = text(value, 2000);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function reasonOf(error: unknown): string {
  const message =
    error instanceof Error ? firstLine(error.message) : "T3 Code failed.";
  return NOT_RUNNING.test(message)
    ? "T3 Code isn't running. Start T3 Code, then refresh."
    : message || "T3 Code failed.";
}

function isNotFound(error: unknown): boolean {
  return error instanceof T3Error && NOT_FOUND.test(error.message);
}

function tool(id: string): void {
  if (id !== TOOL) throw new Error(`This plugin has no handoff tool "${id}".`);
}

async function showThread(threadId: string): Promise<Json> {
  const shown = record(
    await captureJson("thread-show", { thread: threadId }),
  )?.thread;
  const thread = record(shown);
  if (!thread || thread.threadId !== threadId)
    throw new T3Error("T3 Code returned another thread.");
  return thread;
}

export async function detectTools(): Promise<DetectToolsResult> {
  let version: string;
  try {
    const output = firstLine(await capture("version", {}));
    version = /^t3 v?(\S+)$/i.exec(output)?.[1] ?? output;
    if (!version || version.length > 200)
      throw new T3Error("t3 returned no version.");
  } catch (error) {
    return {
      tools: [{ id: TOOL, available: false, reason: reasonOf(error) }],
    };
  }
  // `t3 --version` answers without a server. A missing thread tells whether
  // one runs: the server says the thread is no longer available.
  try {
    await capture("thread-show", { thread: PROBE_THREAD });
  } catch (error) {
    if (error instanceof T3Error && NOT_RUNNING.test(error.message)) {
      return {
        tools: [
          {
            id: TOOL,
            available: false,
            version,
            reason: reasonOf(error),
          },
        ],
      };
    }
  }
  return { tools: [{ id: TOOL, available: true, version }] };
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

/** The last state the plugin read, kept in native between reads. */
function previousState(native: Json): State {
  return STATES.find((state) => state === native.state) ?? "working";
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

/** Adds a reason and flags, dropping the reason if native would pass 4 KB. */
function withNotes(native: Native, notes: Native): Native {
  const result = { ...native, ...notes };
  return new TextEncoder().encode(JSON.stringify(result)).length <= NATIVE_LIMIT
    ? result
    : { ...native, ...notes, reason: null };
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

function settingText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : undefined;
}

export async function startHandoff(
  request: StartHandoffRequest,
): Promise<StartHandoffResult> {
  tool(request.tool);
  const began = Date.now();
  // One line: the broker refuses line breaks, and a value that starts with
  // "-", which t3 would read as a flag.
  const title =
    request.title
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[\s-]+/, "") || "Ajour handoff";
  const args: Record<string, string> = {
    folder: request.folder.id,
    title,
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
    output = await captureJson("thread-start", args, request.prompt);
  } catch (error) {
    // Ajour stopped t3 or dropped its output, so the thread may exist.
    if (
      error instanceof T3Error &&
      error.code !== undefined &&
      START_UNCERTAIN.has(error.code)
    )
      throw new T3Error(MAYBE_STARTED, error.code);
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
      ...(await before(began + START_DEADLINE_MS, () => showThread(threadId))),
    };
  } catch (error) {
    notes = { reason: reasonOf(error) };
  }
  const link = https(thread.link);
  return {
    threadId,
    ...(link ? { link } : {}),
    native: withNotes(nativeOf(thread, "working"), notes),
  };
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function each<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) await work(items[next++] as T);
    },
  );
  await Promise.all(workers);
}

type Handoff = ReadHandoffStatesRequest["handoffs"][number];

/** The last state read, kept because T3 didn't answer in time. */
function lateUpdate(handoff: Handoff): Update {
  return keptUpdate(handoff.id, handoff.native, previousState(handoff.native), {
    reason: LATE,
  });
}

async function readThread(
  handoff: Handoff,
  listed: Json | undefined,
  deadline: number,
) {
  const show = () => before(deadline, () => showThread(handoff.threadId));
  if (!listed) {
    // Archived threads leave the list, but `thread show` still finds them.
    // Only T3 saying the thread doesn't exist makes it gone.
    try {
      return updateOf(handoff.id, await show(), { missing: true });
    } catch (error) {
      if (isLate(error)) return lateUpdate(handoff);
      if (isNotFound(error))
        return keptUpdate(handoff.id, handoff.native, "gone", {
          state: "gone",
          label: LABELS.gone,
        });
      return keptUpdate(
        handoff.id,
        handoff.native,
        previousState(handoff.native),
        { missing: true, reason: reasonOf(error) },
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
    if (isNotFound(error))
      return keptUpdate(handoff.id, handoff.native, "gone", {
        state: "gone",
        label: LABELS.gone,
      });
    return updateOf(handoff.id, listed, { reason: reasonOf(error) });
  }
}

export async function readHandoffStates(
  request: ReadHandoffStatesRequest,
): Promise<ReadHandoffStatesResult> {
  tool(request.tool);
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
      const list = await before(deadline, () =>
        captureJson("thread-list", { folder }),
      );
      if (!Array.isArray(list))
        throw new T3Error("T3 Code returned a thread list Ajour can't read.");
      threads = new Map(
        list.flatMap((value) => {
          const thread = record(value);
          const id = text(thread?.threadId);
          return thread && id ? [[id, thread] as const] : [];
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
            reason: reasonOf(error),
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

// Keep the exported operations checked against the host's contract.
const _module = {
  detectTools,
  startHandoff,
  readHandoffStates,
} satisfies PluginModule;
