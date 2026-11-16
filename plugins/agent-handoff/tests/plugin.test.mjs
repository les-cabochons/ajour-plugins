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

const refused = (code) =>
  Object.assign(new Error(`Process request refused: ${code}.`), {
    name: "AjourProcessError",
    code,
  });

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
  return value;
}

/** The argv the broker would run for a request, or a thrown refusal. */
function argvOf(request) {
  const command = manifest.processes.commands.find(
    (c) => c.id === request.command,
  );
  if (!command) throw refused("undeclared");
  const executable = manifest.processes.executables[command.executable];
  const has = (name) => Object.hasOwn(request.args, name);
  const slotOf = (arg) => /^\{(\w+):([\w-]+)\}$/.exec(arg);
  const slots = command.args
    .flatMap((a) => (typeof a === "string" ? [a] : a.args))
    .flatMap((a) => slotOf(a)?.[1] ?? []);
  if (Object.keys(request.args).some((name) => !slots.includes(name)))
    throw refused("invalid_request");
  const fill = (arg) => {
    const slot = slotOf(arg);
    return slot ? slotValue(slot[2], request.args[slot[1]]) : arg;
  };
  const argv = [executable.names[0]];
  for (const arg of command.args) {
    if (typeof arg === "string") argv.push(fill(arg));
    else if (has(arg.if)) argv.push(...arg.args.map(fill));
    else if (arg.args.some((a) => has(slotOf(a)?.[1] ?? "")))
      throw refused("invalid_request");
  }
  if (request.stdin !== undefined && command.stdin !== "text")
    throw refused("invalid_request");
  return argv;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const late = /T3 Code took too long; refreshing again later/;

/** Makes the fake broker refuse the command, as Ajour does. */
const refuse = (code) => () => {
  throw refused(code);
};

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
      if (argv[2] === "show")
        assert.deepEqual(argv.slice(-3), ["--json", "--messages", "0"]);
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
      ["t3", "thread", "show", "ajour-detect", "--json", "--messages", "0"],
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
  assert.deepEqual(calls[1].argv, [
    "t3",
    "thread",
    "show",
    threadId,
    "--json",
    "--messages",
    "0",
  ]);
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

test("a start passes a model without a provider, and slugs with slashes stay one argument", async () => {
  const calls = fakeT3((argv) =>
    argv[2] === "start" ? out(started) : out({ thread: shown }),
  );
  await startHandoff(
    startRequest({ worktree: false, model: "anthropic/claude-opus-5-5" }),
  );
  await startHandoff(
    startRequest({
      worktree: false,
      provider: "openrouter/main",
      model: "anthropic/claude-opus-5-5",
    }),
  );
  const starts = calls.filter((c) => c.argv[2] === "start");
  assert.deepEqual(starts[0].argv.slice(8), [
    "--model",
    "anthropic/claude-opus-5-5",
  ]);
  assert.deepEqual(starts[1].argv.slice(8), [
    "--provider",
    "openrouter/main",
    "--model",
    "anthropic/claude-opus-5-5",
  ]);
});

test("a start sends the title on one line", async () => {
  const calls = fakeT3((argv) =>
    argv[2] === "start" ? out(started) : out({ thread: shown }),
  );
  await startHandoff(
    startRequest({}, { title: "- AJ-38\tHand off\r\n\nto  T3 Code \n" }),
  );
  assert.equal(calls[0].argv[6], "AJ-38 Hand off to T3 Code");
});

test("a start refuses a provider without a model, or a worktree without a branch", async () => {
  const calls = fakeT3(() => out(started));
  await assert.rejects(
    startHandoff(startRequest({ provider: "claudeAgent" })),
    /Set a model for the provider/,
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

test("a start Ajour ends before t3 answers says the thread may exist", async () => {
  for (const code of ["timeout", "capture_incomplete", "output_limit"]) {
    fakeT3(refuse(code));
    await assert.rejects(startHandoff(startRequest()), {
      message:
        "T3 Code may have started the thread. Check T3 Code before handing off again.",
    });
  }
});

test("a start keeps the new thread when thread show outlasts the start deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = fakeT3((argv) =>
    argv[2] === "start" ? out(started) : new Promise(() => {}),
  );
  let settled = false;
  const pending = startHandoff(startRequest()).finally(() => {
    settled = true;
  });
  await flush();
  // Ajour ends the operation at 30 s; the start stops waiting at 27 s.
  t.mock.timers.tick(26_999);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.threadId, threadId);
  assert.equal(result.native.projectId, started.projectId);
  assert.equal(result.native.state, "working");
  assert.match(result.native.reason, late);
  assert.deepEqual(
    calls.map((c) => c.argv[2]),
    ["start", "show"],
  );
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
      ["t3", "thread", "show", threadId, "--json", "--messages", "0"],
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

test("a pull request T3 gives no title is named repository#number", async () => {
  // The shape thread list printed for a real thread with pull requests.
  fakeT3(() =>
    out([
      {
        ...completed,
        pullRequests: [
          {
            host: "github.com",
            repository: "les-cabochons/ajour",
            number: 738,
            url: "https://github.com/les-cabochons/ajour/pull/738",
            source: "agent",
            state: "open",
          },
          { url: "https://example.com/pull/9", repository: "x/y" },
        ],
      },
    ]),
  );
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1")],
  });
  assert.deepEqual(update.pullRequests, [
    {
      url: "https://github.com/les-cabochons/ajour/pull/738",
      title: "les-cabochons/ajour#738",
    },
    { url: "https://example.com/pull/9" },
  ]);
});

test("an archived thread missing from the list takes its state from thread show, and settles", async () => {
  const calls = fakeT3((argv) =>
    argv[2] === "list"
      ? out([])
      : out({ thread: { ...completed, archived: true } }),
  );
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1", { state: "working", status: "running" })],
  });
  assert.equal(update.state, "done");
  assert.equal(update.native.state, "done");
  assert.equal(update.native.label, "Archived");
  assert.equal(update.native.status, "completed");
  assert.equal(update.native.archived, true);
  assert.equal(update.native.missing, true);
  // thread show prints no pull request list, so the host keeps the last one.
  assert.equal(update.pullRequests, undefined);
  assert.equal(update.link, link);
  assert.equal(calls.length, 2);
});

test("a thread missing from the list but not archived takes its state from thread show", async () => {
  fakeT3((argv) =>
    argv[2] === "list"
      ? out([])
      : out({
          thread: { ...shown, status: "running", pendingRequestCount: 2 },
        }),
  );
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1", { state: "ready", status: "completed" })],
  });
  assert.equal(update.state, "needs-you");
  assert.equal(update.native.state, "needs-you");
  assert.equal(update.native.status, "running");
  assert.equal(update.native.archived, false);
  assert.equal(update.native.missing, true);
});

test("a listed thread that is archived settles", async () => {
  fakeT3(() => out([{ ...completed, status: "running", archived: true }]));
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1")],
  });
  assert.equal(update.state, "done");
  assert.equal(update.native.label, "Archived");
});

test("a settled thread reads Settled, archived or not", async () => {
  for (const archived of [false, true]) {
    fakeT3(() => out([{ ...completed, settled: true, archived }]));
    const [update] = await readHandoffStates({
      tool: "t3",
      handoffs: [handoff("h1")],
    });
    assert.equal(update.state, "done");
    assert.equal(update.native.label, "Settled", String(archived));
  }
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

test("a refresh stops waiting at its deadline and keeps the threads it couldn't read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const never = new Promise(() => {});
  const slow = { ...listed, threadId: "mcp:slow", status: "running" };
  const calls = fakeT3((argv) => {
    if (argv[2] === "list")
      return out([{ ...listed, status: "running" }, slow]);
    return argv[3] === threadId
      ? out({ thread: { ...shown, status: "running", pendingRequestCount: 1 } })
      : never;
  });
  const pending = readHandoffStates({
    tool: "t3",
    handoffs: [
      handoff("h1"),
      {
        ...handoff("h2", { state: "needs-you", status: "running" }),
        threadId: "mcp:slow",
      },
      handoff("h3", { state: "ready" }, "folder-2"),
      handoff("h4", { state: "done" }, "folder-3"),
    ],
  });
  await flush();
  t.mock.timers.tick(19_999);
  await flush();
  t.mock.timers.tick(1);
  const updates = await pending;
  assert.deepEqual(
    updates.map((u) => [u.id, u.state, u.native.state]),
    [
      ["h1", "needs-you", "needs-you"],
      ["h2", "needs-you", "needs-you"],
      ["h3", "ready", "ready"],
      ["h4", "done", "done"],
    ],
  );
  assert.equal(updates[0].native.reason, undefined);
  for (const update of updates.slice(1))
    assert.match(update.native.reason, late);
  // Folders after the deadline are never listed.
  assert.deepEqual(
    calls.map((c) => [
      c.argv[2],
      c.argv[3] === "--project" ? c.argv[4] : c.argv[3],
    ]),
    [
      ["list", FOLDER],
      ["show", threadId],
      ["show", "mcp:slow"],
    ],
  );
});

test("a thread list that outlasts the deadline keeps every state, never unknown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  fakeT3(() => new Promise(() => {}));
  const pending = readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1", { state: "ready" })],
  });
  await flush();
  t.mock.timers.tick(20_000);
  const [update] = await pending;
  assert.equal(update.state, "ready");
  assert.match(update.native.reason, late);
});

for (const code of ["timeout", "capture_incomplete"]) {
  test(`a thread list Ajour ends with ${code} keeps every state, never unknown`, async () => {
    fakeT3(refuse(code));
    const updates = await readHandoffStates({
      tool: "t3",
      handoffs: [
        handoff("h1", { state: "ready", status: "completed" }),
        handoff("h2", { state: "needs-you", status: "running" }),
      ],
    });
    assert.deepEqual(
      updates.map((u) => [u.id, u.state, u.native.state]),
      [
        ["h1", "ready", "ready"],
        ["h2", "needs-you", "needs-you"],
      ],
    );
    for (const update of updates) {
      assert.match(update.native.reason, late);
      assert.notEqual(update.native.label, "Unknown");
    }
  });

  test(`a thread show Ajour ends with ${code} keeps the last state`, async () => {
    fakeT3((argv) =>
      argv[2] === "list"
        ? out([{ ...listed, status: "running" }])
        : refuse(code)(),
    );
    const [update] = await readHandoffStates({
      tool: "t3",
      handoffs: [handoff("h1", { state: "needs-you", status: "running" })],
    });
    assert.equal(update.state, "needs-you");
    assert.equal(update.native.state, "needs-you");
    assert.match(update.native.reason, late);

    fakeT3((argv) => (argv[2] === "list" ? out([]) : refuse(code)()));
    const [missing] = await readHandoffStates({
      tool: "t3",
      handoffs: [handoff("h1", { state: "ready", status: "completed" })],
    });
    assert.equal(missing.state, "ready");
    assert.match(missing.native.reason, late);
  });
}

test("T3's not-running and not-found messages count on any stderr line", async () => {
  const warning = "(node:1) Warning: something deprecated\n";
  fakeT3((argv) =>
    argv[1] === "--version"
      ? ok(version)
      : fail(`${warning}${read("no-server.txt")}`),
  );
  const [tool] = (await detectTools()).tools;
  assert.equal(tool.available, false);
  assert.match(tool.reason, /isn't running/);

  fakeT3((argv) =>
    argv[2] === "list"
      ? out([])
      : fail(`${warning}${read("not-found.txt").replace(/mcp:\S+/, threadId)}`),
  );
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1", { state: "ready" })],
  });
  assert.equal(update.state, "gone");
});

test("each broker refusal reads as what to do next", async () => {
  const cases = {
    needs_consent:
      "Open this plugin's Access section in Settings › Plugins and choose Allow and activate.",
    unsigned_processes_off:
      "Turn on Unsigned plugins can start processes in Settings › Plugins.",
    process_acceptance_required:
      "Allow this plugin to start processes on its page.",
    concurrency: "Ajour is busy with other T3 Code commands; try again.",
    executable_missing: /isn't installed/,
    package_unverified: /verify this plugin's package/,
    spawn_refused:
      "Ajour couldn't start t3 safely (an unusual launcher, an argument it can't pass, or a command line that's too long). Check the T3 Code install and this handoff's title.",
    output_limit: /more output than Ajour accepts/,
    timeout: /didn't answer in time/,
    invalid_request: /Check the branch, base ref, provider and model/,
    plugin_off: /Turn this plugin on/,
    something_new: "Ajour couldn't run t3 (something_new).",
  };
  for (const [code, expected] of Object.entries(cases)) {
    globalThis.ajour = createFakeAjour({
      manifest,
      processRun: async () => {
        throw refused(code);
      },
    });
    const [tool] = (await detectTools()).tools;
    if (typeof expected === "string") assert.equal(tool.reason, expected, code);
    else assert.match(tool.reason, expected, code);
  }
});

test("another tool id is refused", async () => {
  fakeT3(() => ok(""));
  await assert.rejects(
    readHandoffStates({ tool: "codex", handoffs: [] }),
    /no handoff tool/,
  );
});
