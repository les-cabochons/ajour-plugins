// The plugin against outputs recorded from the real t3 CLI (v0.1.10 nightly,
// see fixtures/version.txt). A fake t3 answers each declared command, after
// expanding it to argv from plugin.json the way Ajour's process broker does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { createFakeAjour } from "@ajour/plugin-sdk/testing";
import { detectTools, readHandoffStates, startHandoff } from "../src/plugin.ts";

const read = (name) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const json = (name) => JSON.parse(read(`${name}.json`));
const manifest = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
);

const version = read("version.txt");
const started = json("start");
const threadId = started.threadId;
const listed = json("list")[0];
const shown = json("show").thread;
const completed = json("completed").thread;
const link = listed.link;
const FOLDER = "folder-1";

/** The argv the broker would run for a request, or a thrown refusal. */
function argvOf(request) {
  const command = manifest.processes.commands.find(
    (c) => c.id === request.command,
  );
  const executable = manifest.processes.executables[command.executable];
  const used = new Set();
  const fill = (arg) => {
    const slot = /^\{(\w+):(\w+)\}$/.exec(arg);
    if (!slot) return arg;
    const value = request.args[slot[1]];
    if (value === undefined) throw new Error(`Missing slot ${slot[1]}.`);
    if (String(value).startsWith("-")) throw new Error("Starts with -.");
    used.add(slot[1]);
    return String(value);
  };
  const argv = [executable.names[0]];
  for (const arg of command.args) {
    if (typeof arg === "string") argv.push(fill(arg));
    else if (request.args[arg.if] !== undefined)
      argv.push(...arg.args.map(fill));
  }
  for (const name of Object.keys(request.args))
    if (!used.has(name)) throw new Error(`Undeclared slot ${name}.`);
  if (request.stdin !== undefined && command.stdin !== "text")
    throw new Error("The command takes no stdin.");
  return argv;
}

const ok = (stdout) => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr) => ({ exitCode: 1, stdout: "", stderr });
const out = (value) => ok(`${JSON.stringify(value)}\n`);

/** Installs a fake t3. `answer` gets argv and returns a capture result. */
function fakeT3(answer) {
  const calls = [];
  globalThis.ajour = createFakeAjour({
    manifest,
    processRun: async (request) => {
      const argv = argvOf(request);
      calls.push({ argv, stdin: request.stdin });
      return answer(argv);
    },
  });
  return calls;
}

afterEach(() => {
  delete globalThis.ajour;
});

function assertNativeFits(native) {
  assert.ok(new TextEncoder().encode(JSON.stringify(native)).length <= 4096);
}

const startRequest = (settings = {}, extra = {}) => ({
  tool: "t3",
  folder: { id: FOLDER, name: "ajour" },
  prompt: "Work on AJ-38: hand off to T3 Code\n\nLine two.",
  title: "AJ-38 Hand off to T3 Code",
  branch: "aj-38-hand-off",
  item: { key: "AJ-38", url: "https://example.com/AJ-38" },
  settings,
  ...extra,
});

const handoff = (id, native = { state: "working" }, folderId = FOLDER) => ({
  id,
  threadId,
  folderId,
  native,
});

test("detection returns the recorded version when T3 Code runs", async () => {
  const calls = fakeT3((argv) =>
    argv[1] === "--version"
      ? ok(version)
      : fail(`Thread ${argv[3]} is no longer available.\n`),
  );
  assert.deepEqual(await detectTools(), {
    tools: [
      { id: "t3", available: true, version: "0.1.10-nightly.20261116.4761" },
    ],
  });
  assert.deepEqual(
    calls.map((c) => c.argv),
    [
      ["t3", "--version"],
      ["t3", "thread", "show", "ajour-detect", "--json"],
    ],
  );
});

test("detection says T3 Code isn't running when no server answers", async () => {
  fakeT3((argv) =>
    argv[1] === "--version" ? ok(version) : fail(read("no-server.txt")),
  );
  const [tool] = (await detectTools()).tools;
  assert.equal(tool.available, false);
  assert.equal(tool.version, "0.1.10-nightly.20261116.4761");
  assert.match(tool.reason, /isn't running/);
});

test("detection says T3 Code isn't installed when t3 is missing", async () => {
  globalThis.ajour = createFakeAjour({
    manifest,
    processRun: async () => {
      throw Object.assign(new Error("Executable missing."), {
        name: "AjourProcessError",
        code: "executable_missing",
      });
    },
  });
  const [tool] = (await detectTools()).tools;
  assert.equal(tool.available, false);
  assert.equal(tool.version, undefined);
  assert.match(tool.reason, /isn't installed/);
});

test("a start runs thread start in a worktree with the prompt on stdin", async () => {
  const calls = fakeT3((argv) =>
    argv[2] === "start" ? out(started) : out({ thread: shown }),
  );
  const request = startRequest({ worktree: true, base: "develop" });
  const result = await startHandoff(request);
  assert.deepEqual(calls[0], {
    argv: [
      "t3",
      "thread",
      "start",
      FOLDER,
      "-",
      "--title",
      "AJ-38 Hand off to T3 Code",
      "--json",
      "--worktree",
      "develop",
      "--branch",
      "aj-38-hand-off",
    ],
    stdin: request.prompt,
  });
  assert.deepEqual(calls[1].argv, ["t3", "thread", "show", threadId, "--json"]);
  assert.equal(result.threadId, threadId);
  assert.equal(result.link, link);
  assert.equal(result.native.projectId, started.projectId);
  assert.equal(result.native.state, "working");
  assert.equal(result.native.status, "preparing");
  assertNativeFits(result.native);
});

test("a start uses a worktree from main by default", async () => {
  const calls = fakeT3((argv) =>
    argv[2] === "start" ? out(started) : out({ thread: shown }),
  );
  await startHandoff(startRequest());
  assert.deepEqual(calls[0].argv.slice(-4), [
    "--worktree",
    "main",
    "--branch",
    "aj-38-hand-off",
  ]);
});

test("a start without a worktree passes the provider and model", async () => {
  const calls = fakeT3((argv) =>
    argv[2] === "start" ? out(started) : out({ thread: shown }),
  );
  await startHandoff(
    startRequest({
      worktree: false,
      provider: "claudeAgent",
      model: "claude-opus-5-5",
    }),
  );
  assert.deepEqual(calls[0].argv, [
    "t3",
    "thread",
    "start",
    FOLDER,
    "-",
    "--title",
    "AJ-38 Hand off to T3 Code",
    "--json",
    "--provider",
    "claudeAgent",
    "--model",
    "claude-opus-5-5",
  ]);
});

test("a start refuses a provider without a model, or a worktree without a branch", async () => {
  const calls = fakeT3(() => out(started));
  await assert.rejects(
    startHandoff(startRequest({ provider: "claudeAgent" })),
    /provider and the model together/,
  );
  await assert.rejects(
    startHandoff(startRequest({}, { branch: undefined })),
    /Name a branch/,
  );
  assert.deepEqual(calls, []);
});

test("a start keeps the thread when reading its link fails", async () => {
  fakeT3((argv) =>
    argv[2] === "start" ? out(started) : fail(read("no-server.txt")),
  );
  const result = await startHandoff(startRequest());
  assert.equal(result.threadId, threadId);
  assert.equal(result.link, undefined);
  assert.equal(result.native.projectId, started.projectId);
  assert.match(result.native.reason, /isn't running/);
});

test("a failed start returns T3's message", async () => {
  fakeT3(() => fail(read("no-project.txt")));
  await assert.rejects(
    startHandoff(startRequest()),
    /No T3 Code project matches/,
  );
});

test("a live thread is read with thread show, and a pending request wins over running", async () => {
  const running = { ...listed, status: "running" };
  const calls = fakeT3((argv) =>
    argv[2] === "list"
      ? out([running])
      : out({
          thread: { ...shown, status: "running", pendingRequestCount: 1 },
        }),
  );
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1")],
  });
  assert.equal(update.state, "needs-you");
  assert.equal(update.native.status, "running");
  assert.equal(update.native.pendingRequestCount, 1);
  assert.equal(update.link, link);
  assert.deepEqual(
    calls.map((c) => c.argv),
    [
      ["t3", "thread", "list", "--project", FOLDER, "--json"],
      ["t3", "thread", "show", threadId, "--json"],
    ],
  );
});

test("a running thread with no pending request is working", async () => {
  fakeT3((argv) =>
    argv[2] === "list"
      ? out([{ ...listed, status: "running" }])
      : out({ thread: shown }),
  );
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1")],
  });
  assert.equal(update.state, "working");
});

test("stopped, settled and failed threads map without thread show", async () => {
  const cases = [
    [{ status: "completed" }, "ready"],
    [{ status: "idle" }, "ready"],
    [{ status: "interrupted" }, "ready"],
    [{ status: "cancelled" }, "ready"],
    [{ status: "completed", settled: true }, "done"],
    [{ status: "running", settled: true }, "done"],
    [{ status: "failed" }, "failed"],
  ];
  for (const [fields, state] of cases) {
    const calls = fakeT3(() => out([{ ...completed, ...fields }]));
    const [update] = await readHandoffStates({
      tool: "t3",
      handoffs: [handoff("h1")],
    });
    assert.equal(update.state, state, JSON.stringify(fields));
    assert.equal(update.native.state, state);
    assert.equal(calls.length, 1);
  }
});

test("native keeps status, settled and snooze, and pull requests are https only", async () => {
  fakeT3(() =>
    out([
      {
        ...completed,
        snoozed: true,
        snoozedUntil: "2026-11-17T09:00:00.000Z",
        pullRequests: [
          {
            url: "https://github.com/les-cabochons/ajour/pull/1",
            title: "One",
          },
          { url: "http://example.com/pull/2", title: "Plain HTTP" },
          { url: "javascript:alert(1)" },
          { title: "No URL" },
        ],
        linkedPullRequest: {
          url: "https://github.com/les-cabochons/ajour/pull/3",
        },
      },
    ]),
  );
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1")],
  });
  assert.deepEqual(update.pullRequests, [
    { url: "https://github.com/les-cabochons/ajour/pull/1", title: "One" },
    { url: "https://github.com/les-cabochons/ajour/pull/3" },
  ]);
  assert.deepEqual(update.native, {
    state: "ready",
    label: "Ready for review",
    status: "completed",
    projectId: completed.projectId,
    settled: false,
    snoozed: true,
    archived: false,
    snoozedUntil: "2026-11-17T09:00:00.000Z",
    pendingRequestCount: 0,
  });
  assert.equal(update.branch, "fixture-38");
  assert.equal(update.title, "Ajour handoff fixture");
  assert.equal(JSON.stringify(update).includes("worktreePath"), false);
  assert.equal(JSON.stringify(update).includes("Reply with OK"), false);
});

test("an archived thread missing from the list keeps its previous state", async () => {
  const calls = fakeT3((argv) =>
    argv[2] === "list"
      ? out([])
      : out({ thread: { ...completed, archived: true } }),
  );
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1", { state: "ready", status: "completed" })],
  });
  assert.equal(update.state, "ready");
  assert.equal(update.native.state, "ready");
  assert.equal(update.native.missing, true);
  assert.equal(update.native.archived, true);
  assert.equal(calls.length, 2);
});

test("a thread T3 says doesn't exist is gone", async () => {
  fakeT3((argv) =>
    argv[2] === "list"
      ? out([])
      : fail(read("not-found.txt").replace(/mcp:\S+/, threadId)),
  );
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1", { state: "ready" })],
  });
  assert.equal(update.state, "gone");
});

test("a missing thread T3 can't show keeps its previous state", async () => {
  fakeT3((argv) =>
    argv[2] === "list" ? out([]) : fail(read("no-server.txt")),
  );
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1", { state: "needs-you" })],
  });
  assert.equal(update.state, "needs-you");
  assert.equal(update.native.missing, true);
  assert.match(update.native.reason, /isn't running/);
});

test("an unreachable server makes every thread unknown, never gone", async () => {
  fakeT3(() => fail(read("no-server.txt")));
  const updates = await readHandoffStates({
    tool: "t3",
    handoffs: [
      handoff("h1", { state: "ready" }),
      handoff("h2", { state: "done" }),
    ],
  });
  assert.deepEqual(
    updates.map((u) => [u.id, u.state, u.native.state]),
    [
      ["h1", "unknown", "ready"],
      ["h2", "unknown", "done"],
    ],
  );
  assert.match(updates[0].native.reason, /isn't running/);
});

test("one thread list runs per folder, and answers follow the request order", async () => {
  const other = { ...completed, threadId: "mcp:other" };
  const calls = fakeT3((argv) =>
    argv[4] === "folder-2" ? out([other]) : out([completed]),
  );
  const updates = await readHandoffStates({
    tool: "t3",
    handoffs: [
      handoff("h1"),
      { ...handoff("h2", undefined, "folder-2"), threadId: "mcp:other" },
      handoff("h3"),
    ],
  });
  assert.deepEqual(
    updates.map((u) => u.id),
    ["h1", "h2", "h3"],
  );
  assert.deepEqual(
    calls.map((c) => c.argv[4]),
    [FOLDER, "folder-2"],
  );
  for (const update of updates) assertNativeFits(update.native);
});

test("another tool id is refused", async () => {
  fakeT3(() => ok(""));
  await assert.rejects(
    readHandoffStates({ tool: "codex", handoffs: [] }),
    /no handoff tool/,
  );
});
