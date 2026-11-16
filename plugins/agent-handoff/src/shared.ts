// What every tool's adapter shares: running declared commands through Ajour's
// process broker, reading its refusals, the operation deadlines, and building
// the bounded native state the host stores.
import type {
  ReadHandoffStatesRequest,
  ReadHandoffStatesResult,
} from "@ajour/plugin-sdk";
import type {} from "@ajour/plugin-sdk/globals";

export type Update = ReadHandoffStatesResult[number];
export type State = Update["state"];
export type Json = Record<string, unknown>;
export type Native = Record<string, string | number | boolean | null>;
export type Handoff = ReadHandoffStatesRequest["handoffs"][number];

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
export const START_UNCERTAIN = new Set([...CUT_SHORT, "output_limit"]);

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
  own: { invalid_request: string; output_limit: string },
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
class LateError extends ToolError {
  constructor(message: string) {
    super(message, "late");
  }
}

export function firstLine(value: string | undefined): string {
  return (value ?? "").trim().split(/\r?\n/, 1)[0]?.slice(0, 500) ?? "";
}

function refusal(tool: Tool, error: unknown): ToolError {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
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

/** Runs a declared capture command and returns its stdout, or throws. */
export async function capture(
  tool: Tool,
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
    throw refusal(tool, error);
  }
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
    throw new ToolError(`${tool.name} returned output Ajour can't read.`);
  }
}

/** Starts a declared launch command, such as one that opens a terminal. */
export async function launch(
  tool: Tool,
  command: string,
  args: Record<string, string>,
): Promise<void> {
  let result: Awaited<ReturnType<typeof ajour.process.run>>;
  try {
    result = await ajour.process.run({ command, args });
  } catch (error) {
    throw refusal(tool, error);
  }
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

/** A handoff title on one line: the broker refuses line breaks, and a value
 * that starts with "-", which the tool would read as a flag. */
export function oneLineTitle(title: string): string {
  return (
    title
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[\s-]+/, "") || "Ajour handoff"
  );
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
