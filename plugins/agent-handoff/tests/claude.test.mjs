// The Claude Code tool against outputs recorded from the real claude CLI
// (2.1.325 on Windows, see fixtures/claude/version.txt) in a throwaway
// repository. A fake claude answers each declared command, after the fake
// broker expands it to argv from plugin.json the way Ajour does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import {
  detectTools,
  listThreads,
  readHandoffStates,
  startHandoff,
} from "../src/plugin.ts";
import {
  argvOf,
  fail,
  fakeBroker,
  flush,
  folders,
  manifest,
  ok,
  out,
  refuse,
  refused,
} from "./fake-broker.mjs";

const read = (name) =>
  readFileSync(new URL(`fixtures/claude/${name}`, import.meta.url), "utf8");
const json = (name) => JSON.parse(read(`${name}.json`));

const version = read("version.txt");
const startOutput = read("start.txt");
const startStderr = read("start-stderr.txt");
// The job just after `claude --bg` returned, still working.
const [dispatched] = json("agents-working");
const sessionId = dispatched.sessionId;
// Every state recorded at once: done, stopped, blocked on a permission, an
// open interactive session, and an interactive session of another folder.
const recorded = json("agents-all");
const byName = (name) => recorded.find((session) => session.name === name);
const done = byName("Ajour probe bg");
const stopped = byName("Ajour probe question");
const permission = byName("Ajour probe permission");
const interactive = byName("Ajour probe terminal");
const [question] = json("agents-question");
const FOLDER = "folder-1";
const late = /Claude Code took too long; refreshing again later/;

afterEach(() => {
  delete globalThis.ajour;
  for (const id of Object.keys(folders)) delete folders[id];
});

/**
 * Installs a fake claude. `answer` gets argv and returns a capture result;
 * `options` go to the fake broker, such as a start's `hookUrl`.
 */
function fakeClaude(answer, options) {
  return fakeBroker((argv, call) => {
    // Detection asks every tool; these tests have only claude.
    if (argv[0] !== "claude") throw refused("executable_missing");
    return answer(argv, call);
  }, options);
}

// The URL Ajour builds for a start's hooks (#726): loopback, its API port,
// the handoff's id and a 43-character base64url token.
const HOOK_URL =
  "http://127.0.0.1:8787/hooks/handoff/h-1?token=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const hooked = (settings = {}, extra = {}) =>
  startRequest(settings, { hook: { url: HOOK_URL }, ...extra });

/** Answers like the recorded claude: --bg starts, agents lists `sessions`. */
const recordedClaude =
  (sessions = [dispatched]) =>
  (argv) => {
    if (argv[1] === "--bg")
      return { exitCode: 0, stdout: startOutput, stderr: startStderr };
    if (argv[1] === "agents") return out(sessions);
    return undefined;
  };

const startRequest = (settings = {}, extra = {}) => ({
  tool: "claude",
  folder: { id: FOLDER, name: "ajour" },
  prompt: "Work on AJ-39: hand off to Claude Code\n\nLine two.",
  title: "AJ-39 Hand off to Claude Code",
  branch: "aj-39-claude",
  item: { key: "AJ-39", url: "https://example.com/AJ-39" },
  settings,
  ...extra,
});

const handoff = (id, threadId, native = { state: "working" }) => ({
  id,
  threadId,
  folderId: FOLDER,
  native,
});

function assertPrivate(update) {
  const serialized = JSON.stringify(update);
  assert.equal(serialized.includes("repos"), false, "no folder path");
  assert.equal(serialized.includes("pid"), false, "no process id");
  assert.ok(
    new TextEncoder().encode(JSON.stringify(update.native)).length <= 4096,
  );
}

test("detection returns the recorded version", async () => {
  const calls = fakeClaude(() => ok(version));
  const { tools } = await detectTools();
  assert.deepEqual(tools[1], {
    id: "claude",
    available: true,
    version: "2.1.325",
  });
  assert.deepEqual(
    calls.filter((c) => c.argv[0] === "claude").map((c) => c.argv),
    [["claude", "--version"]],
  );
});

test("detection says Claude Code isn't installed when claude is missing", async () => {
  fakeClaude(refuse("executable_missing"));
  const { tools } = await detectTools();
  assert.deepEqual(
    tools.map((tool) => [tool.id, tool.available]),
    [
      ["t3", false],
      ["claude", false],
      ["copilot", false],
      ["codex", false],
    ],
  );
  assert.equal(
    tools[1].reason,
    "Claude Code isn't installed, or its claude command isn't on PATH.",
  );
});

test("a start runs claude --bg with the prompt on stdin, then reads the session id", async () => {
  const calls = fakeClaude(recordedClaude());
  const request = startRequest();
  const result = await startHandoff(request);
  assert.deepEqual(
    calls.map(({ argv, mode, stdin }) => ({ argv, mode, stdin })),
    [
      {
        argv: [
          "claude",
          "--bg",
          "--name",
          "AJ-39 Hand off to Claude Code",
          "--add-dir",
          FOLDER,
        ],
        mode: "capture",
        stdin: request.prompt,
      },
      {
        argv: ["claude", "agents", "--json", "--all"],
        mode: "capture",
        stdin: undefined,
      },
    ],
  );
  // The prompt never reaches the command line.
  assert.ok(calls.every((c) => !c.argv.some((a) => a.includes("Line two"))));
  assert.deepEqual(result, {
    threadId: "e2cf2a01-1318-457a-91f3-0371a1d14aae",
    resume: {
      command: "claude-attach",
      args: { job: "e2cf2a01", folder: FOLDER },
    },
    native: {
      state: "working",
      label: "Working",
      kind: "background",
      claudeState: "working",
      job: "e2cf2a01",
    },
  });
  assertPrivate(result);
});

test("a start passes the model, and the title on one line", async () => {
  const calls = fakeClaude(recordedClaude());
  await startHandoff(
    startRequest(
      { model: " claude-opus-5-5 " },
      { title: "- AJ-39\tHand off\r\n\nto  Claude Code \n" },
    ),
  );
  assert.deepEqual(calls[0].argv, [
    "claude",
    "--bg",
    "--name",
    "AJ-39 Hand off to Claude Code",
    "--model",
    "claude-opus-5-5",
    "--add-dir",
    FOLDER,
  ]);
});

test("the terminal start mode opens the background session in a terminal", async () => {
  const calls = fakeClaude(recordedClaude());
  const result = await startHandoff(startRequest({ startMode: "terminal" }));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], {
    argv: ["claude", "attach", "e2cf2a01", FOLDER],
    mode: "terminal",
    cwd: FOLDER,
    stdin: undefined,
  });
  assert.equal(result.threadId, sessionId);
  assert.equal(result.native.reason, undefined);
});

test("a terminal Ajour can't open keeps the started session, with the reason", async () => {
  // Windows Terminal takes no & in the folder path.
  folders[FOLDER] = "C:\\Users\\me\\R&D\\probe";
  const calls = fakeClaude(recordedClaude());
  const result = await startHandoff(startRequest({ startMode: "terminal" }));
  assert.deepEqual(
    calls.map((c) => c.argv[1]),
    ["--bg", "agents"],
  );
  assert.equal(result.threadId, sessionId);
  assert.equal(
    result.native.reason,
    "The session runs in the background, but Ajour couldn't open a terminal: Ajour refused a value for claude. Check the model; a terminal also needs a repository folder path without unusual characters.",
  );
});

test("a start with a hook passes Claude Code settings whose HTTP hooks post to it", async () => {
  const calls = fakeClaude(recordedClaude(), { hookUrl: HOOK_URL });
  const request = hooked({ model: "opus" });
  const result = await startHandoff(request);
  const [start] = calls;
  assert.equal(start.mode, "capture");
  assert.equal(start.stdin, request.prompt);
  const at = start.argv.indexOf("--settings");
  assert.deepEqual(
    [...start.argv.slice(0, at), ...start.argv.slice(at + 2)],
    [
      "claude",
      "--bg",
      "--name",
      "AJ-39 Hand off to Claude Code",
      "--model",
      "opus",
      "--add-dir",
      FOLDER,
    ],
  );
  // Exactly the manifest's template, filled with the start's URL alone.
  const template = manifest.processes.commands
    .find((command) => command.id === "claude-start-hook")
    .args.find((arg) => arg.kind === "hook-url").template;
  assert.equal(start.argv[at + 1], template.replaceAll("{url}", HOOK_URL));
  const settings = JSON.parse(start.argv[at + 1]);
  assert.deepEqual(Object.keys(settings), ["hooks"]);
  // Only events whose reply can't steer the session: a Stop reply could keep
  // Claude working with its own instruction (ajour#765). Notification gives up
  // after 5 seconds rather than http's default 600, so a listener that never
  // answers can't stall Claude Code; SessionEnd hooks already share a
  // 1.5-second budget, which a longer timeout would raise.
  assert.deepEqual(settings.hooks, {
    Notification: [{ hooks: [{ type: "http", url: HOOK_URL, timeout: 5 }] }],
    SessionEnd: [{ hooks: [{ type: "http", url: HOOK_URL }] }],
  });
  // No hook runs a command, and the URL appears nowhere else.
  assert.equal(start.argv[at + 1].includes('"command"'), false);
  assert.equal(
    calls.filter((call) => call.argv.join(" ").includes(HOOK_URL)).length,
    1,
  );
  assert.equal(result.threadId, sessionId);
  // The token stays out of what Ajour stores.
  assert.equal(JSON.stringify(result).includes("token"), false);
});

test("a terminal start carries the hook too: the terminal only attaches", async () => {
  const calls = fakeClaude(recordedClaude(), { hookUrl: HOOK_URL });
  await startHandoff(hooked({ startMode: "terminal" }));
  assert.deepEqual(
    calls.map((call) => [call.argv[1], call.mode]),
    [
      ["--bg", "capture"],
      ["agents", "capture"],
      ["attach", "terminal"],
    ],
  );
  assert.ok(calls[0].argv.includes("--settings"));
  assert.deepEqual(calls[2].argv, ["claude", "attach", "e2cf2a01", FOLDER]);
});

test("a start without a hook runs claude --bg without settings", async () => {
  // The broker refuses a hook-url argument outside a start that has a hook,
  // so a start without one never names that command.
  const calls = fakeClaude(recordedClaude());
  const result = await startHandoff(startRequest({ startMode: "terminal" }));
  assert.deepEqual(calls[0].argv, [
    "claude",
    "--bg",
    "--name",
    "AJ-39 Hand off to Claude Code",
    "--add-dir",
    FOLDER,
  ]);
  assert.equal(result.threadId, sessionId);
  assert.equal(result.native.reason, undefined);
});

test("a hook Ajour refuses is a start failure that names Claude Code", async () => {
  // Ajour checks the URL's shape again and refuses one it didn't build.
  fakeClaude(recordedClaude());
  await assert.rejects(startHandoff(hooked()), {
    message:
      "Ajour refused this start's hook address, so it didn't start Claude Code. Hand off again, or update Ajour.",
  });
});

test("an untrusted folder asks the user to trust it in Claude Code first", async () => {
  const calls = fakeClaude(() => fail(read("untrusted.txt")));
  await assert.rejects(startHandoff(startRequest()), {
    message:
      "Trust this folder in Claude Code first: run claude in the repository folder once and accept the trust prompt, then hand off again.",
  });
  assert.equal(calls.length, 1);
});

test("a start Ajour runs at the system root says Ajour needs an update", async () => {
  // What claude --bg printed when started at C:\, where the broker runs
  // capture commands today.
  fakeClaude(() =>
    fail(`Starting background service…\n${read("root-untrusted.txt")}`),
  );
  await assert.rejects(startHandoff(startRequest()), {
    message:
      "Ajour started Claude Code at the system root instead of the repository folder, so Claude Code refused it. This needs an Ajour update.",
  });
});

test("a start Ajour ends before claude answers says the session may exist", async () => {
  for (const code of ["timeout", "capture_incomplete", "output_limit"]) {
    fakeClaude(refuse(code));
    await assert.rejects(startHandoff(startRequest()), {
      message:
        "Claude Code may have started the session. Check claude agents before handing off again.",
    });
  }
});

test("a start whose output has no job id says to check claude agents", async () => {
  fakeClaude(() => ok("done\n"));
  await assert.rejects(startHandoff(startRequest()), {
    message:
      "Claude Code printed no session id. Check claude agents before handing off again.",
  });
});

test("a start reads the list again when the job isn't listed yet", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let reads = 0;
  fakeClaude((argv) => {
    if (argv[1] !== "agents") return recordedClaude()(argv);
    reads++;
    return out(reads === 1 ? [] : [dispatched]);
  });
  const pending = startHandoff(startRequest());
  await flush();
  t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(reads, 2);
  assert.equal(result.threadId, sessionId);
});

test("a start that never finds its job names the job to attach to", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = fakeClaude((argv) =>
    argv[1] === "agents" ? out([permission]) : recordedClaude()(argv),
  );
  let error;
  const pending = startHandoff(startRequest()).catch((e) => {
    error = e;
  });
  for (let i = 0; i < 3; i++) {
    await flush();
    t.mock.timers.tick(1000);
  }
  await pending;
  assert.equal(
    error.message,
    "Claude Code started background session e2cf2a01, but Ajour couldn't read its session ID. Open it with claude attach e2cf2a01 instead of handing off again.",
  );
  assert.equal(calls.filter((c) => c.argv[1] === "agents").length, 3);
});

test("a start stops waiting for the session id at 27 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  fakeClaude((argv) =>
    argv[1] === "agents" ? new Promise(() => {}) : recordedClaude()(argv),
  );
  let error;
  const pending = startHandoff(startRequest()).catch((e) => {
    error = e;
  });
  await flush();
  t.mock.timers.tick(26_999);
  await flush();
  assert.equal(error, undefined);
  t.mock.timers.tick(1);
  await pending;
  assert.match(
    error.message,
    /couldn't read its session ID \(Claude Code took too long/,
  );
  assert.match(error.message, /claude attach e2cf2a01/);
});

test("recorded sessions map to the common states, with Claude's words as labels", async () => {
  // The question was recorded blocked, then stopped: the list holds both
  // readings of one session, and the live one wins.
  const calls = fakeClaude(() => out([...recorded, question]));
  const sessions = [done, question, permission, interactive];
  const updates = await readHandoffStates({
    tool: "claude",
    handoffs: sessions.map((session, index) =>
      handoff(`h${index}`, session.sessionId),
    ),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ["claude", "agents", "--json", "--all"]);
  assert.deepEqual(
    updates.map((u) => [u.id, u.state, u.native.label, u.title]),
    [
      ["h0", "ready", "Done", "Ajour probe bg"],
      ["h1", "needs-you", "Input needed", "Ajour probe question"],
      ["h2", "needs-you", "Permission prompt", "Ajour probe permission"],
      ["h3", "ready", "Idle", "Ajour probe terminal"],
    ],
  );
  for (const update of updates) assertPrivate(update);
  assert.deepEqual(updates[2].native, {
    state: "needs-you",
    label: "Permission prompt",
    kind: "background",
    claudeState: "blocked",
    status: "waiting",
    waitingFor: "permission prompt",
    job: "de94c642",
  });
});

test("a session just dispatched is working", async () => {
  fakeClaude(() => out([dispatched]));
  const [update] = await readHandoffStates({
    tool: "claude",
    handoffs: [handoff("h1", sessionId)],
  });
  assert.equal(update.state, "working");
  assert.equal(update.native.label, "Working");
});

test("a stopped session is ready, labeled Stopped", async () => {
  fakeClaude(() => out(recorded));
  const [update] = await readHandoffStates({
    tool: "claude",
    handoffs: [handoff("h1", stopped.sessionId)],
  });
  assert.equal(update.state, "ready");
  assert.deepEqual(update.native, {
    state: "ready",
    label: "Stopped",
    kind: "background",
    claudeState: "stopped",
    job: "b0d639ed",
  });
});

test("failed is failed, and live process detail maps without a state", async () => {
  // Claude Code documents these values; the probe didn't induce them.
  const cases = [
    [{ ...done, state: "failed", status: undefined }, "failed", "Failed"],
    [{ ...interactive, status: "busy" }, "working", "Busy"],
    [{ ...interactive, status: "waiting" }, "needs-you", "Waiting"],
    [
      { ...interactive, status: "waiting", waitingFor: "dialog open" },
      "needs-you",
      "Dialog open",
    ],
    [{ ...dispatched, state: "paused" }, "unknown", "Paused"],
  ];
  for (const [session, state, label] of cases) {
    fakeClaude(() => out([session]));
    const [update] = await readHandoffStates({
      tool: "claude",
      handoffs: [handoff("h1", session.sessionId)],
    });
    assert.equal(update.state, state, JSON.stringify(session));
    assert.equal(update.native.label, label);
  }
});

test("a session missing from the list keeps its state, never gone", async () => {
  fakeClaude(() => out(recorded));
  const [update] = await readHandoffStates({
    tool: "claude",
    handoffs: [
      handoff("h1", "11111111-2222-4333-8444-555555555555", {
        state: "needs-you",
        label: "Input needed",
        kind: "background",
        claudeState: "blocked",
        waitingFor: "input needed",
        job: "11111111",
        cwd: "C:\\never\\kept",
      }),
    ],
  });
  assert.equal(update.state, "needs-you");
  assert.deepEqual(update.native, {
    state: "needs-you",
    label: "Input needed",
    kind: "background",
    claudeState: "blocked",
    waitingFor: "input needed",
    job: "11111111",
    missing: true,
    reason:
      "Claude Code no longer lists this session, such as after claude rm, so Open can't attach to it. Run claude --resume 11111111-2222-4333-8444-555555555555 in the repository folder.",
  });
});

test("a session listed twice reads the live entry", async () => {
  const resumed = {
    ...interactive,
    sessionId: stopped.sessionId,
    status: "busy",
  };
  fakeClaude(() => out([stopped, resumed]));
  const [update] = await readHandoffStates({
    tool: "claude",
    handoffs: [handoff("h1", stopped.sessionId)],
  });
  assert.equal(update.state, "working");
  assert.equal(update.native.kind, "interactive");
  // The job id comes from the job's own entry, so Open still attaches.
  assert.equal(update.native.job, stopped.id);
});

test("a session listed twice takes the job id from either entry, whichever comes first", async () => {
  const resumed = {
    ...interactive,
    sessionId: stopped.sessionId,
    status: "busy",
  };
  fakeClaude(() => out([resumed, stopped]));
  const [update] = await readHandoffStates({
    tool: "claude",
    handoffs: [handoff("h1", stopped.sessionId)],
  });
  assert.equal(update.state, "working");
  assert.equal(update.native.kind, "interactive");
  assert.equal(update.native.job, stopped.id);
});

test("a list claude can't give makes every session unknown, never gone", async () => {
  for (const answer of [refuse("executable_missing"), () => ok("not json")]) {
    fakeClaude(answer);
    const updates = await readHandoffStates({
      tool: "claude",
      handoffs: [
        handoff("h1", done.sessionId, { state: "ready", label: "Done" }),
        handoff("h2", permission.sessionId, { state: "needs-you" }),
      ],
    });
    assert.deepEqual(
      updates.map((u) => [u.state, u.native.state, u.native.label]),
      [
        ["unknown", "ready", "Unknown"],
        ["unknown", "needs-you", "Unknown"],
      ],
    );
    assert.match(
      updates[0].native.reason,
      /isn't installed|returned output Ajour can't read/,
    );
  }
});

test("a list that outlasts the refresh deadline keeps every state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  fakeClaude(() => new Promise(() => {}));
  const pending = readHandoffStates({
    tool: "claude",
    handoffs: [
      handoff("h1", done.sessionId, { state: "ready", label: "Done" }),
    ],
  });
  await flush();
  t.mock.timers.tick(19_999);
  await flush();
  t.mock.timers.tick(1);
  const [update] = await pending;
  assert.equal(update.state, "ready");
  assert.equal(update.native.label, "Done");
  assert.match(update.native.reason, late);
});

for (const code of ["timeout", "capture_incomplete"]) {
  test(`a list Ajour ends with ${code} keeps every state, never unknown`, async () => {
    fakeClaude(refuse(code));
    const [update] = await readHandoffStates({
      tool: "claude",
      handoffs: [handoff("h1", done.sessionId, { state: "needs-you" })],
    });
    assert.equal(update.state, "needs-you");
    assert.match(update.native.reason, late);
  });
}

test("a refresh with no handoffs runs nothing", async () => {
  const calls = fakeClaude(() => out(recorded));
  assert.deepEqual(
    await readHandoffStates({ tool: "claude", handoffs: [] }),
    [],
  );
  assert.deepEqual(calls, []);
});

test("each broker refusal names Claude Code and says what to do next", async () => {
  const cases = {
    concurrency: "Ajour is busy with other Claude Code commands; try again.",
    spawn_refused:
      "Ajour couldn't start claude safely (an unusual launcher, an argument it can't pass, or a command line that's too long). Check the Claude Code install and this handoff's title.",
    output_limit:
      "Claude Code listed more sessions than Ajour accepts. Remove old background sessions with claude rm, then try again.",
    needs_consent:
      "Open this plugin's Access section in Settings › Plugins and choose Allow and activate.",
    something_new: "Ajour couldn't run claude (something_new).",
  };
  for (const [code, expected] of Object.entries(cases)) {
    fakeClaude(refuse(code));
    const { tools } = await detectTools();
    assert.equal(tools[1].reason, expected, code);
  }
});

// Listing threads

// `claude agents --json --all --cwd <folder>`: the probe folder's sessions,
// renamed, with the stopped job also listed live after a terminal resumed it,
// and the sessions of another folder.
const PROBE = "C:\\Users\\me\\repos\\probe";
const OTHER = "C:\\Users\\me\\repos\\other";
const folderSessions = json("agents-folder");
const otherSessions = json("agents-folder-other");
const listRequest = (extra = {}) => ({
  tool: "claude",
  folder: { id: FOLDER },
  limit: 50,
  ...extra,
});

/** Answers like claude: --cwd keeps the sessions started under that folder. */
function listedClaude() {
  folders[FOLDER] = PROBE;
  folders["folder-2"] = OTHER;
  return fakeClaude((argv) => {
    if (argv[1] !== "agents") return undefined;
    const cwd = argv.indexOf("--cwd");
    if (cwd < 0) return out([...folderSessions, ...otherSessions]);
    return out(argv[cwd + 1] === OTHER ? otherSessions : folderSessions);
  });
}

test("a listing runs claude agents for the folder and answers its sessions newest first, as a start would", async () => {
  const calls = listedClaude();
  const { threads } = await listThreads(listRequest());
  assert.deepEqual(
    calls.map((c) => [c.argv, c.cwd]),
    [[["claude", "agents", "--json", "--all", "--cwd", PROBE], PROBE]],
  );
  const live = folderSessions.at(-1);
  // Newest first by start; the session listed twice reads its live entry.
  assert.deepEqual(
    threads.map((t) => [t.threadId, t.title, t.native.state]),
    [
      [live.sessionId, "[PAY-12] [PAY-13] Share the session cookie", "working"],
      [interactive.sessionId, "Look at the flaky sync test", "ready"],
      [permission.sessionId, "Bump the date library", "needs-you"],
      [folderSessions[2].sessionId, "[OPS-7] Rotate the signing keys", "ready"],
      [folderSessions[1].sessionId, "[OPS-7] Rotate the signing keys", "ready"],
      [done.sessionId, "[PAY-12] Fix login redirect", "ready"],
    ],
  );
  // A background job opens by attaching to it, as a started one does; an
  // interactive session has no job to attach to and is open already.
  const job = threads.find((t) => t.threadId === done.sessionId);
  assert.deepEqual(job.resume, {
    command: "claude-attach",
    args: { job: done.id, folder: FOLDER },
  });
  assert.deepEqual(argvOf(job.resume), ["claude", "attach", done.id, PROBE]);
  assert.deepEqual(job.native, {
    state: "ready",
    label: "Done",
    kind: "background",
    claudeState: "done",
    status: "idle",
    job: done.id,
  });
  // A job resumed in a terminal reads its live entry, and still attaches to
  // the job; an interactive session alone has no job, and is open already.
  assert.deepEqual(threads[0].resume, {
    command: "claude-attach",
    args: { job: folderSessions[3].id, folder: FOLDER },
  });
  assert.equal(threads[0].native.kind, "interactive");
  assert.equal(threads[0].native.job, folderSessions[3].id);
  assert.equal(
    threads.find((t) => t.threadId === interactive.sessionId).resume,
    undefined,
  );
  for (const thread of threads) {
    assert.equal(thread.link, undefined);
    // Claude Code doesn't say when a session last changed.
    assert.equal(thread.updatedAt, undefined);
    assertPrivate(thread);
  }
});

test("a listing answers only the folder's sessions, and another folder's from its own list", async () => {
  listedClaude();
  const first = await listThreads(listRequest());
  const second = await listThreads(listRequest({ folder: { id: "folder-2" } }));
  const others = otherSessions.map((s) => s.sessionId);
  assert.ok(!first.threads.some((t) => others.includes(t.threadId)));
  assert.deepEqual(
    second.threads.map((t) => [t.threadId, t.title]),
    otherSessions.map((s) => [s.sessionId, s.name]),
  );
});

test("a listing honors limit, and lists every session whatever since says", async () => {
  listedClaude();
  const limited = await listThreads(listRequest({ limit: 2 }));
  assert.equal(limited.threads.length, 2);
  const all = await listThreads(listRequest());
  const since = await listThreads(listRequest({ since: Date.now() }));
  assert.deepEqual(since, all);
});

test("a listing skips a session without a title or a session id Ajour can use", async () => {
  fakeClaude(() =>
    out([
      { ...done, name: "" },
      { ...permission, sessionId: "-flag" },
      { ...interactive, name: "  [PAY-12]  Spaced  " },
    ]),
  );
  const { threads } = await listThreads(listRequest());
  assert.deepEqual(
    threads.map((t) => [t.threadId, t.title]),
    [[interactive.sessionId, "[PAY-12]  Spaced"]],
  );
});

test("listed sessions refresh through readHandoffStates", async () => {
  listedClaude();
  const { threads } = await listThreads(listRequest());
  const updates = await readHandoffStates({
    tool: "claude",
    handoffs: threads.map((thread, i) => ({
      id: `h${i}`,
      threadId: thread.threadId,
      folderId: FOLDER,
      native: thread.native,
    })),
  });
  assert.deepEqual(
    updates.map((u) => [u.state, u.title, u.native]),
    threads.map((t) => [t.native.state, t.title, t.native]),
  );
});

test("a listing claude can't answer throws what to do", async () => {
  fakeClaude(refuse("executable_missing"));
  await assert.rejects(listThreads(listRequest()), /isn't installed/);
  fakeClaude(() => ok("not json"));
  await assert.rejects(listThreads(listRequest()), /can't read/);
});
