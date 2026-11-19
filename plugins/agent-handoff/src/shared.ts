// What every tool's adapter shares: running declared commands through Ajour's
// process broker, reading its refusals, the operation deadlines, and building
// the bounded native state the host stores.
import type {
  ListThreadsRequest,
  ListThreadsResult,
  ReadHandoffStatesRequest,
  ReadHandoffStatesResult,
} from "@ajour/plugin-sdk";
import type {} from "@ajour/plugin-sdk/globals";

export type Update = ReadHandoffStatesResult[number];
export type State = Update["state"];
export type Json = Record<string, unknown>;
export type Native = Record<string, string | number | boolean | null>;
export type Handoff = ReadHandoffStatesRequest["handoffs"][number];
export type Listed = ListThreadsResult["threads"][number];

export const STATES: readonly State[] = [
  "working",
  "needs-you",
  "ready",
  "done",
  "failed",
  "gone",
  "unknown",
];
const NATIVE_LIMIT = 4096;
// The host ends an operation after 30 seconds. A refresh stops waiting for
// the tool before that. A start gives its first command 20 seconds
// (plugin.json), then stops waiting for what follows at 27, which leaves time
// to spawn.
export const READ_DEADLINE_MS = 20_000;
export const START_DEADLINE_MS = 27_000;
// Ajour stopped the tool before its output was whole. A refresh treats these
// like its own deadline, and a start can't tell whether the work exists.
const CUT_SHORT = new Set(["timeout", "capture_incomplete"]);
/** The tool exited 0 but printed no JSON the plugin can read. */
export const UNREADABLE_OUTPUT = "unreadable_output";
// A start whose output is too long or unreadable may have created the work.
export const START_UNCERTAIN = new Set([
  ...CUT_SHORT,
  "output_limit",
  UNREADABLE_OUTPUT,
]);
// Ajour runs at most 4 of a plugin's commands at once and refuses the next
// one before it starts. Detection alone runs 4, so a listing or a refresh that
// starts with it waits for a slot instead of failing: about 3 seconds, which
// is longer than the slowest --version takes.
const BUSY_RETRIES = 12;
const BUSY_PAUSE_MS = 250;

/** How one tool names itself in messages, and reads its own failures. */
export interface Tool {
  /** The product, such as "T3 Code". */
  name: string;
  /** The executable, such as "t3". */
  exe: string;
  /** What the user can do about each refusal from Ajour's process broker. */
  refusals: Record<string, string>;
  /** The reason kept on a handoff the tool didn't answer for in time. */
  late: string;
  /** The line of the tool's output that says why it failed. */
  failureLine(output: string | undefined): string;
  /** A reason for the user, from a failure's message. */
  explain(message: string): string;
}

/** The refusals every tool words the same way, with its own names. */
export function refusalsFor(
  name: string,
  exe: string,
  own: { invalid_request: string; output_limit: string } & Record<
    string,
    string
  >,
): Record<string, string> {
  return {
    executable_missing: `${name} isn't installed, or its ${exe} command isn't on PATH.`,
    timeout: `${name} didn't answer in time. Try again.`,
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
    spawn_refused: `Ajour couldn't start ${exe} safely (an unusual launcher, an argument it can't pass, or a command line that's too long). Check the ${name} install and this handoff's title.`,
    spawn_failed: `${exe} failed to start. Try again.`,
    concurrency: `Ajour is busy with other ${name} commands; try again.`,
    rate_limit:
      "Ajour is limiting this plugin's commands. Try again in a minute.",
    capture_incomplete: `Ajour couldn't read all of ${name}'s output. Try again.`,
    operation_ended: `Ajour stopped waiting for ${name}. Try again.`,
    ...own,
  };
}

/** A failed or refused command, with the line the tool printed about it. */
export class ToolError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

/** The operation's deadline passed before the tool answered. */
export class LateError extends ToolError {
  constructor(message: string) {
    super(message, "late");
  }
}

export function firstLine(value: string | undefined): string {
  return (value ?? "").trim().split(/\r?\n/, 1)[0]?.slice(0, 500) ?? "";
}

/** The refusal code of an error from Ajour's process broker, if it has one. */
function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

/** A refusal from Ajour's process broker, worded for the user. */
export function refusal(tool: Tool, error: unknown): ToolError {
  const code = codeOf(error);
  if (code && Object.hasOwn(tool.refusals, code))
    return new ToolError(tool.refusals[code] as string, code);
  if (code)
    return new ToolError(`Ajour couldn't run ${tool.exe} (${code}).`, code);
  return new ToolError(
    firstLine(error instanceof Error ? error.message : undefined) ||
      `Ajour couldn't run ${tool.exe}.`,
  );
}

/** True when the tool didn't answer in time, by the plugin's deadline or Ajour's. */
export function isLate(error: unknown): boolean {
  return (
    error instanceof LateError ||
    (error instanceof ToolError &&
      error.code !== undefined &&
      CUT_SHORT.has(error.code))
  );
}

/** True when Ajour stopped or cut short a start, so its work may exist. */
export function isUncertainStart(error: unknown): boolean {
  return (
    error instanceof ToolError &&
    error.code !== undefined &&
    START_UNCERTAIN.has(error.code)
  );
}

/** Runs `work`, or throws a late error once `deadline` passes. */
export async function before<T>(
  tool: Tool,
  deadline: number,
  work: () => Promise<T>,
): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) throw new LateError(tool.late);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LateError(tool.late)), left);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits `ms`, or less when the deadline comes first. */
export function pause(ms: number, deadline: number): Promise<void> {
  const wait = Math.max(0, Math.min(ms, deadline - Date.now()));
  return new Promise((resolve) => setTimeout(resolve, wait));
}

type ProcessRequest = Parameters<typeof ajour.process.run>[0];
type ProcessResult = Awaited<ReturnType<typeof ajour.process.run>>;

/**
 * Runs a declared command through Ajour's process broker. A `concurrency`
 * refusal comes before the command starts, so it is safe to ask again once
 * one of the plugin's other commands ends. Any other refusal throws at once.
 * The result keeps a failed command's exit code and output, for a tool whose
 * failure means something, such as `opencode api` answering 404.
 */
export async function run(
  tool: Tool,
  request: ProcessRequest,
): Promise<ProcessResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ajour.process.run(request);
    } catch (error) {
      if (codeOf(error) !== "concurrency" || attempt >= BUSY_RETRIES)
        throw refusal(tool, error);
    }
    await new Promise((resolve) => setTimeout(resolve, BUSY_PAUSE_MS));
  }
}

/** Runs a declared capture command and returns its stdout, or throws. */
export async function capture(
  tool: Tool,
  command: string,
  args: Record<string, string>,
  stdin?: string,
): Promise<string> {
  const result = await run(tool, {
    command,
    args,
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (result.started === true)
    throw new ToolError(`${tool.exe} started without returning its output.`);
  if (result.exitCode !== 0) {
    throw new ToolError(
      tool.failureLine(result.stderr) ||
        tool.failureLine(result.stdout) ||
        `${tool.exe} exited with ${result.exitCode ?? "a signal"}.`,
    );
  }
  return result.stdout;
}

/**
 * The JSON document a tool printed after log lines. The t3 CLI logs warnings
 * to stdout, such as one that the T3 Code database is newer than the CLI, so
 * its JSON can start on a later line. The document is the first line that
 * starts with `{` or `[` and parses through to the end of the output.
 */
function jsonAfterLogLines(output: string): { value: unknown } | undefined {
  const opens = /[ \t]*[[{]/y;
  let start = output.indexOf("\n");
  while (start !== -1) {
    start += 1;
    opens.lastIndex = start;
    if (opens.test(output)) {
      try {
        return { value: JSON.parse(output.slice(start)) };
      } catch {
        // A log line can start with a bracket too, such as "[15:16:50] WARN".
      }
    }
    start = output.indexOf("\n", start);
  }
  return undefined;
}

/**
 * Runs a declared capture command and returns the JSON it printed, after any
 * log lines. Output without JSON throws `unreadable_output`, with the first
 * line the tool printed, so the user and the log can see what it said.
 */
export async function captureJson(
  tool: Tool,
  command: string,
  args: Record<string, string>,
  stdin?: string,
): Promise<unknown> {
  const output = await capture(tool, command, args, stdin);
  try {
    return JSON.parse(output);
  } catch {
    const found = jsonAfterLogLines(output);
    if (found) return found.value;
    const line = firstLine(output).slice(0, 200);
    throw new ToolError(
      line
        ? `${tool.name} returned output Ajour can't read. It starts with: ${line}`
        : `${tool.name} returned no output Ajour can read.`,
      UNREADABLE_OUTPUT,
    );
  }
}

/**
 * Starts a declared launch command, such as one that opens a terminal. A
 * detached command that declares stdin gets `stdin`, and starts once it has
 * read all of it.
 */
export async function launch(
  tool: Tool,
  command: string,
  args: Record<string, string>,
  stdin?: string,
): Promise<void> {
  const result = await run(tool, {
    command,
    args,
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (result.started !== true)
    throw new ToolError(`${tool.exe} returned output instead of starting.`);
}

export function reasonOf(tool: Tool, error: unknown): string {
  const message =
    error instanceof Error ? firstLine(error.message) : `${tool.name} failed.`;
  return tool.explain(message) || `${tool.name} failed.`;
}

export function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

export function text(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

export function https(value: unknown): string | undefined {
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

/** The last state the plugin read, kept in native between reads. */
export function previousState(native: Json): State {
  return STATES.find((state) => state === native.state) ?? "working";
}

/** Adds a reason and flags, dropping the reason if native would pass 4 KB. */
export function withNotes(native: Native, notes: Native): Native {
  const result = { ...native, ...notes };
  return new TextEncoder().encode(JSON.stringify(result)).length <= NATIVE_LIMIT
    ? result
    : { ...native, ...notes, reason: null };
}

/** The most characters a handoff title keeps, for every tool. */
export const TITLE_LIMIT = 80;

/**
 * The title a start names the thread with, on one line and at most
 * {@link TITLE_LIMIT} characters. The broker refuses line breaks, and a
 * value that starts with "-", which the tool would read as a flag. Copilot
 * CLI exits on a session name over 100 characters, so a longer title ends in
 * "…" at 80, after its last whole word when one ends in the second half. The
 * cut keeps the start, where Ajour puts the item's key that links a thread to
 * its item.
 */
export function oneLineTitle(title: string): string {
  const line =
    title
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[\s-]+/, "") || "Ajour handoff";
  if (line.length <= TITLE_LIMIT) return line;
  let cut = line.slice(0, TITLE_LIMIT - 1);
  const space = cut.lastIndexOf(" ");
  if (line[cut.length] !== " " && space > TITLE_LIMIT / 2)
    cut = cut.slice(0, space);
  // Never keep half of a character such as an emoji, cut at its middle.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * A tool's thread title for a listing: trimmed, at most the 500 characters
 * Ajour keeps, or undefined when there is none.
 */
export function listTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let title = value.trim().slice(0, 500);
  // Never keep half of a character such as an emoji, cut at its middle.
  if (/[\uD800-\uDBFF]$/.test(title)) title = title.slice(0, -1);
  return title.trim() || undefined;
}

/** A time in milliseconds, from a number of `unit` milliseconds or an ISO date. */
export function timeOf(value: unknown, unit = 1): number | undefined {
  const time =
    typeof value === "number"
      ? value * unit
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isSafeInteger(time) && time > 0 ? time : undefined;
}

/**
 * A listing's answer from threads in the tool's newest-first order: each
 * thread once, without the dated ones not changed after `since`, at most
 * `limit`.
 */
export function listed(
  threads: readonly Listed[],
  request: Pick<ListThreadsRequest, "since" | "limit">,
): ListThreadsResult {
  const seen = new Set<string>();
  const result: Listed[] = [];
  for (const thread of threads) {
    if (seen.has(thread.threadId)) continue;
    seen.add(thread.threadId);
    if (
      request.since !== undefined &&
      thread.updatedAt !== undefined &&
      thread.updatedAt <= request.since
    )
      continue;
    result.push(thread);
    if (result.length >= request.limit) break;
  }
  return { threads: result };
}

export function settingText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : undefined;
}

/** Runs `work` over `items`, at most `limit` at a time. */
export async function each<T>(
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
