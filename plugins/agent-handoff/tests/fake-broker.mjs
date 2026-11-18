// A fake of Ajour's process broker for the plugin's tests. It expands each
// request into argv from plugin.json and refuses what apps/api/src/
// process-broker.ts and process-launch.ts refuse, so a test sees the exact
// command line a user would approve.
import { readFileSync } from "node:fs";
import { createFakeAjour } from "@ajour/plugin-sdk/testing";

export const manifest = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
);

export const refused = (code) =>
  Object.assign(new Error(`Process request refused: ${code}.`), {
    name: "AjourProcessError",
    code,
  });

/** Makes the fake broker refuse the command, as Ajour does. */
export const refuse = (code) => () => {
  throw refused(code);
};

/**
 * Paths for folder ids, as the host's folder resolver gives them. An id
 * missing here resolves to itself.
 */
export const folders = {};
const folderPath = (id) => folders[id] ?? id;

/** A slot value, checked with the rules of Ajour's process-broker.ts. */
function slotValue(kind, raw) {
  if (typeof raw !== "string" && typeof raw !== "number")
    throw refused("invalid_request");
  if (kind !== "number" && typeof raw !== "string")
    throw refused("invalid_request");
  const value = String(raw);
  if (
    (!value && kind !== "text") ||
    value.startsWith("-") ||
    /[\0\r\n]/.test(value)
  )
    throw refused("invalid_request");
  if (kind === "id" && !/^[A-Za-z0-9:._-]+$/.test(value))
    throw refused("invalid_request");
  if (
    kind === "ref" &&
    (value === "@" ||
      value.endsWith(".") ||
      /[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|\/\/|^\/|\/$/.test(value) ||
      value.split("/").some((p) => p.startsWith(".") || p.endsWith(".lock")))
  )
    throw refused("invalid_request");
  return kind === "folder" ? folderPath(value) : value;
}

/**
 * The command the broker would run for a request: its argv, mode and
 * working folder, or a thrown refusal.
 */
export function commandOf(request) {
  const command = manifest.processes.commands.find(
    (c) => c.id === request.command,
  );
  if (!command) throw refused("undeclared");
  const executable = manifest.processes.executables[command.executable];
  const has = (name) => Object.hasOwn(request.args, name);
  const slotOf = (arg) =>
    typeof arg === "string" ? /^\{(\w+):([\w-]+)\}$/.exec(arg) : null;
  const slots = command.args
    .flatMap((a) => (typeof a === "string" || !a.args ? [a] : a.args))
    .flatMap((a) =>
      typeof a === "string" ? (slotOf(a)?.[1] ?? []) : (a.name ?? []),
    );
  // A command-level working folder (Ajour #761) is a whole folder slot.
  const working = command.cwd === undefined ? null : slotOf(command.cwd);
  if (command.cwd !== undefined && working?.[2] !== "folder")
    throw new Error(`${command.id}: cwd must be a whole folder slot.`);
  if (working) slots.push(working[1]);
  if (Object.keys(request.args).some((name) => !slots.includes(name)))
    throw refused("invalid_request");
  let cwd;
  const fill = (arg) => {
    if (typeof arg !== "string") {
      if (arg.kind === "literal") return arg.value;
      // The SDK fake fills a hook-url argument from its hookUrl option; the
      // broker refuses it outside a start that has a hook.
      if (arg.kind === "hook-url") {
        const value = request.args[arg.name];
        if (typeof value !== "string") throw refused("hook_refused");
        return value;
      }
      throw refused("invalid_request");
    }
    const slot = slotOf(arg);
    if (!slot) return arg;
    const value = slotValue(slot[2], request.args[slot[1]]);
    // Every mode runs in its first folder (capture since Ajour #746).
    if (slot[2] === "folder") cwd ??= value;
    return value;
  };
  const argv = [executable.names[0]];
  for (const arg of command.args) {
    if (typeof arg === "string" || !arg.args) argv.push(fill(arg));
    else if (has(arg.if)) for (const a of arg.args) argv.push(fill(a));
    else if (arg.args.some((a) => has(slotOf(a)?.[1] ?? "")))
      throw refused("invalid_request");
  }
  // A declared working folder resolves like a folder argument, never joins
  // argv, and wins over the first folder argument.
  if (working) cwd = slotValue("folder", request.args[working[1]]);
  // Capture and detached commands take stdin when they declare it; a
  // terminal runs in another app, and a session takes lines through send.
  if (
    (command.mode === "terminal" || command.mode === "session") &&
    request.stdin !== undefined
  )
    throw refused("invalid_request");
  if (request.stdin !== undefined && command.stdin !== "text")
    throw refused("invalid_request");
  if (typeof request.stdin === "string" && request.stdin.length > 1024 * 1024)
    throw refused("invalid_request");
  // Capture and session start at the root without a folder; launch modes
  // refuse.
  if (command.mode !== "capture" && command.mode !== "session" && !cwd)
    throw refused("folder_refused");
  if (command.mode === "terminal") {
    // Windows Terminal takes only these characters in cwd and arguments.
    const safe = (value) =>
      /^[A-Za-z0-9 ._:\\/@+=,~()\-]+$/.test(value) && !value.endsWith("\\");
    if (!safe(cwd) || argv.slice(1).some((value) => !safe(value)))
      throw refused("invalid_request");
  }
  return { argv, mode: command.mode, cwd: cwd ?? "C:\\" };
}

/** The argv the broker would run for a request, or a thrown refusal. */
export const argvOf = (request) => commandOf(request).argv;

/**
 * Installs a fake broker. `answer` gets the command and returns a capture
 * result; a launch mode command starts without one. `routes` answer
 * `ajour.http` (the SDK fake refuses a path or header the manifest doesn't
 * declare), `connectionUrl` is the operation's connection address, which
 * fills a `connection-url` slot, and `hookUrl` is a start's hook URL, which
 * the SDK fake writes into each `hook-url` argument. `session`, when given, gets each
 * session the plugin opens, with its command, and returns the program's
 * handler, as the SDK fake's `processSession` does. `ajour.sessions` then
 * records what the plugin sent each one.
 */
export function fakeBroker(
  answer,
  { routes, connectionUrl, hookUrl, session } = {},
) {
  const calls = [];
  globalThis.ajour = createFakeAjour({
    manifest,
    ...(routes ? { routes } : {}),
    ...(connectionUrl === undefined ? {} : { connectionUrl }),
    ...(hookUrl === undefined ? {} : { hookUrl }),
    ...(session
      ? {
          processSession: async (request, program) => {
            const command = commandOf(request);
            const call = { ...command, session: true };
            calls.push(call);
            return session(command.argv, program, call);
          },
        }
      : {}),
    processRun: async (request) => {
      const command = commandOf(request);
      const call = { ...command, stdin: request.stdin };
      calls.push(call);
      const result = await answer(command.argv, call);
      return command.mode === "capture"
        ? result
        : (result ?? { started: true });
    },
  });
  return calls;
}

export const ok = (stdout) => ({ exitCode: 0, stdout, stderr: "" });
export const fail = (stderr) => ({ exitCode: 1, stdout: "", stderr });
export const out = (value) => ok(`${JSON.stringify(value)}\n`);

export const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/**
 * Ticks mocked timers until `promise` settles, for a plugin that waits
 * between its tries, such as after the broker's `concurrency` refusal. The
 * test enables `t.mock.timers` for setTimeout first.
 */
export async function settleWithTimers(t, promise, stepMs = 250) {
  let settled = false;
  const watched = promise.finally(() => {
    settled = true;
  });
  for (let step = 0; step < 1000 && !settled; step++) {
    await flush();
    t.mock.timers.tick(stepMs);
  }
  return watched;
}
