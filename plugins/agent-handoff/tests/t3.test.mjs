// The T3 Code tool against outputs recorded from the real t3 CLI (v0.1.10
// nightly, see fixtures/version.txt). A fake t3 answers each declared command,
// after the fake broker expands it to argv from plugin.json the way Ajour does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { createFakeAjour } from "@ajour/plugin-sdk/testing";
import {
  detectTools,
  listThreads,
  readHandoffStates,
  startHandoff,
} from "../src/plugin.ts";
import {
  argvOf,
  commandOf,
  fail,
  fakeBroker,
  flush,
  folders,
  manifest,
  ok,
  out,
  refuse,
  refused,
  settleWithTimers,
} from "./fake-broker.mjs";

const read = (name) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const json = (name) => JSON.parse(read(`${name}.json`));

const version = read("version.txt");
const started = json("start");
const threadId = started.threadId;
const listed = json("list")[0];
const shown = json("show").thread;
const completed = json("completed").thread;
// Open goes to the T3 Code app: the web link's path on its t3code: scheme.
const appLink = (web) =>
  web.replace("https://app.t3.codes/threads/", "t3code://threads/");
const link = appLink(listed.link);
const FOLDER = "folder-1";
const late = /T3 Code took too long; refreshing again later/;

/**
 * Installs a fake t3. `answer` gets argv and returns a capture result. Like
 * the real one, every t3 command but --version fails at the system root.
 */
function fakeT3(answer) {
  const calls = [];
  fakeBroker((argv, call) => {
    // Detection asks every tool; these tests have only t3.
    if (argv[0] !== "t3") throw refused("executable_missing");
    if (argv[2] === "show")
      assert.deepEqual(argv.slice(-3), ["--json", "--messages", "0"]);
    calls.push({ argv, stdin: call.stdin, cwd: call.cwd });
    if (argv[1] !== "--version" && call.cwd === "C:\\")
      return fail(read("root-refused.txt"));
    return answer(argv);
  });
  return calls;
}

afterEach(() => {
  delete globalThis.ajour;
});

function assertNativeFits(native) {
  assert.ok(new TextEncoder().encode(JSON.stringify(native)).length <= 4096);
}

/**
 * A start as Ajour sends it with Start in on New worktree (ajour#863): the
 * branch to create, and the source it starts from.
 */
const startRequest = (settings = {}, extra = {}) => ({
  tool: "t3",
  folder: { id: FOLDER, name: "ajour" },
  prompt: "Work on AJ-38: hand off to T3 Code\n\nLine two.",
  title: "AJ-38 Hand off to T3 Code",
  branch: "aj-38-hand-off",
  source: "origin/main",
  item: { key: "AJ-38", url: "https://example.com/AJ-38" },
  settings,
  ...extra,
});
// Start in on Main folder: Ajour sends neither a branch nor a source.
const inFolder = { branch: undefined, source: undefined };
// An Ajour that predates `source` sends the branch alone.
const noSource = { source: undefined };

const handoff = (id, native = { state: "working" }, folderId = FOLDER) => ({
  id,
  threadId,
  folderId,
  native,
});

test("detection runs only t3 --version, which answers at the system root", async () => {
  // Ajour starts a command without a folder at the root, where every t3
  // command that reaches the server fails (fixtures/root-refused.txt). So
  // detection doesn't ask whether a server runs; a refresh or start says so.
  const calls = fakeT3((argv) =>
    argv[1] === "--version" ? ok(version) : fail(read("root-refused.txt")),
  );
  const { tools } = await detectTools();
  assert.deepEqual(tools[0], {
    id: "t3",
    available: true,
    version: "0.1.10-nightly.20261116.4761",
  });
  assert.deepEqual(
    calls.map((c) => [c.argv, c.cwd]),
    [[["t3", "--version"], "C:\\"]],
  );
});

test("every T3 command but --version runs in the repository folder", () => {
  const inFolder = {
    "thread-start": { folder: FOLDER, title: "AJ-38" },
    "thread-list": { folder: FOLDER },
    "thread-show": { folder: FOLDER, thread: threadId },
  };
  for (const [command, args] of Object.entries(inFolder))
    assert.equal(commandOf({ command, args }).cwd, FOLDER, command);
  assert.equal(commandOf({ command: "version", args: {} }).cwd, "C:\\");
  // These are all of the plugin's t3 commands.
  assert.deepEqual(
    manifest.processes.commands
      .filter((c) => c.executable === "t3")
      .map((c) => c.id)
      .sort(),
    ["thread-list", "thread-show", "thread-start", "version"],
  );
});

test("thread show runs in the repository folder, which never joins its argv", () => {
  // The broker resolves the folder id to a path; neither is an argument.
  folders["folder-9"] = "C:\\work\\ajour";
  try {
    const { argv, cwd } = commandOf({
      command: "thread-show",
      args: { thread: threadId, folder: "folder-9" },
    });
    assert.equal(cwd, "C:\\work\\ajour");
    assert.deepEqual(argv, [
      "t3",
      "thread",
      "show",
      threadId,
      "--json",
      "--messages",
      "0",
    ]);
    assert.ok(!argv.some((a) => a.includes("folder-9") || a.includes("work")));
  } finally {
    delete folders["folder-9"];
  }
  // The command always needs its folder.
  assert.throws(
    () => commandOf({ command: "thread-show", args: { thread: threadId } }),
    { code: "invalid_request" },
  );
});

test("a thread show T3 refuses keeps the list's state and says why", async () => {
  const running = { ...listed, status: "running" };
  fakeT3((argv) =>
    argv[2] === "list"
      ? out([running])
      : fail("Error: T3 Code couldn't read the thread.\n    at show"),
  );
  const [update] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1")],
  });
  assert.equal(update.state, "working");
  assert.equal(
    update.native.reason,
    "Error: T3 Code couldn't read the thread.",
  );
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

test("a start with a branch runs thread start in a worktree from the request's source, with the prompt on stdin", async () => {
  const calls = fakeT3((argv) =>
    argv[2] === "start" ? out(started) : out({ thread: shown }),
  );
  const request = startRequest();
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
      "origin/main",
      "--branch",
      "aj-38-hand-off",
    ],
    stdin: request.prompt,
    cwd: FOLDER,
  });
  // The new thread's link comes from thread show, in the same folder.
  assert.deepEqual(calls[1], {
    argv: ["t3", "thread", "show", threadId, "--json", "--messages", "0"],
    stdin: undefined,
    cwd: FOLDER,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.threadId, threadId);
  assert.equal(result.link, link);
  assert.equal(result.native.reason, undefined);
  assert.equal(result.native.projectId, started.projectId);
  assert.equal(result.native.state, "working");
  assert.equal(result.native.status, "preparing");
  assertNativeFits(result.native);
});

test("a start without a branch runs in the project folder, with no worktree", async () => {
  const calls = fakeT3((argv) =>
    argv[2] === "start" ? out(started) : out({ thread: shown }),
  );
  const result = await startHandoff(startRequest({}, inFolder));
  assert.deepEqual(calls[0].argv, [
    "t3",
    "thread",
    "start",
    FOLDER,
    "-",
    "--title",
    "AJ-38 Hand off to T3 Code",
    "--json",
  ]);
  assert.equal(result.threadId, threadId);
});

test("a saved Create a worktree or Worktree base setting changes nothing", async () => {
  // 0.17.0 had both settings, so a project can still hold their values.
  const calls = fakeT3((argv) =>
    argv[2] === "start" ? out(started) : out({ thread: shown }),
  );
  await startHandoff(startRequest({ worktree: false, base: "develop" }));
  await startHandoff(
    startRequest({ worktree: true, base: "develop" }, inFolder),
  );
  const starts = calls.filter((c) => c.argv[2] === "start");
  assert.deepEqual(starts[0].argv.slice(8), [
    "--worktree",
    "origin/main",
    "--branch",
    "aj-38-hand-off",
  ]);
  assert.deepEqual(starts[1].argv.slice(8), []);
});

// T3 refuses these before it creates a thread (fixtures from t3 v0.1.5,
// as Ajour's log recorded them), so a start can try again (Ajour #819).
const baseMissing = (base) =>
  fail(read("base-missing.txt").replace('"main"', `"${base}"`));
const worktreeBase = (argv) => argv[argv.indexOf("--worktree") + 1];

test("a start with a branch and no source tries main, then master", async () => {
  const calls = fakeT3((argv) => {
    if (argv[2] !== "start") return out({ thread: shown });
    return worktreeBase(argv) === "master"
      ? out(started)
      : baseMissing(worktreeBase(argv));
  });
  const result = await startHandoff(startRequest({}, noSource));
  assert.equal(result.threadId, threadId);
  assert.deepEqual(
    calls.filter((c) => c.argv[2] === "start").map((c) => worktreeBase(c.argv)),
    ["main", "master"],
  );
});

test("a slow refusal of main leaves master the rest of the start's deadline, and a cut-off master may have started", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const after = (ms, result) =>
    new Promise((resolve) => setTimeout(() => resolve(result), ms));
  // master alone would answer at 34 s, after Ajour ends the operation at 30.
  fakeT3((argv) =>
    worktreeBase(argv) === "main"
      ? after(19_000, baseMissing("main"))
      : after(15_000, out(started)),
  );
  let settled = false;
  const pending = assert
    .rejects(startHandoff(startRequest({}, noSource)), {
      message:
        "T3 Code may have started the thread. Check T3 Code before handing off again.",
      mayHaveStarted: true,
    })
    .finally(() => {
      settled = true;
    });
  await flush();
  t.mock.timers.tick(19_000);
  await flush();
  t.mock.timers.tick(7_999);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await pending;
});

test("a source T3 Code can't resolve is refused in plain words, with no setting for Ajour to ask", async () => {
  /** The refusal has this message and no `setting` hint. */
  const plain = (message) => (error) => {
    assert.equal(error.message, message);
    assert.equal(error.setting, undefined);
    assert.equal(error.branchExists, undefined);
    assert.equal(error.mayHaveStarted, undefined);
    return true;
  };
  const calls = fakeT3((argv) => baseMissing(worktreeBase(argv)));
  await assert.rejects(
    startHandoff(startRequest({}, { source: "origin/develop" })),
    plain(
      "\"origin/develop\" doesn't exist in ajour, so T3 Code can't start the worktree. Pick another source branch in Ajour.",
    ),
  );
  // The request's source is the only one tried.
  assert.deepEqual(
    calls.map((c) => worktreeBase(c.argv)),
    ["origin/develop"],
  );
  fakeT3((argv) => baseMissing(worktreeBase(argv)));
  await assert.rejects(
    startHandoff(startRequest({}, noSource)),
    plain(
      'Neither "main" nor "master" exists in ajour, so T3 Code can\'t start the worktree. Update Ajour to pick the source branch.',
    ),
  );
});

test("a start on a branch that exists says so, for Ajour to offer the item's thread", async () => {
  // T3 can log a warning on stderr before its error.
  const calls = fakeT3(() =>
    fail(`${read("db-warning.txt")}${read("branch-exists.txt")}`),
  );
  await assert.rejects(startHandoff(startRequest()), {
    message:
      'The branch "aj-38-hand-off" already exists in ajour, so T3 Code started no thread. Hand off with another branch from Review prompt.',
    branchExists: true,
  });
  assert.equal(calls.length, 1);
});

test("a start in the project folder passes the provider and model", async () => {
  const calls = fakeT3((argv) =>
    argv[2] === "start" ? out(started) : out({ thread: shown }),
  );
  await startHandoff(
    startRequest(
      { provider: "claudeAgent", model: "claude-opus-5-5" },
      inFolder,
    ),
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
    startRequest({ model: "anthropic/claude-opus-5-5" }, inFolder),
  );
  await startHandoff(
    startRequest(
      { provider: "openrouter/main", model: "anthropic/claude-opus-5-5" },
      inFolder,
    ),
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

test("a start refuses a provider without a model", async () => {
  const calls = fakeT3(() => out(started));
  await assert.rejects(
    startHandoff(startRequest({ provider: "claudeAgent" })),
    /Set a model for the provider/,
  );
  assert.deepEqual(calls, []);
});

test("a thread opens in the T3 Code app, which the manifest declares; a link T3 serves elsewhere stays https", async () => {
  assert.ok(manifest.processes.openSchemes.includes("t3code"));
  // The app routes t3code://threads/<environment>/<thread> to the thread's
  // page, so the id keeps the encoding T3 gave it.
  assert.equal(
    link,
    "t3code://threads/48ed0ee0-97a7-4156-8cc9-73e223805014/mcp%3Ac1e0d197-f95e-4388-b011-c17ab63ddef3",
  );
  const elsewhere = "https://t3.example.com/threads/env/thread-1";
  fakeT3((argv) =>
    argv[2] === "start"
      ? out(started)
      : out({ thread: { ...shown, link: elsewhere } }),
  );
  assert.equal((await startHandoff(startRequest())).link, elsewhere);
});

test("a start keeps the thread when reading its link fails, and never lists the folder", async () => {
  for (const [stderr, reason] of [
    [read("no-server.txt"), /isn't running/],
    ["Error: T3 Code couldn't read the thread.", /couldn't read the thread/],
  ]) {
    const calls = fakeT3((argv) =>
      argv[2] === "start" ? out(started) : fail(stderr),
    );
    const result = await startHandoff(startRequest());
    assert.equal(result.threadId, threadId);
    assert.equal(result.link, undefined);
    assert.equal(result.native.projectId, started.projectId);
    assert.match(result.native.reason, reason);
    assert.deepEqual(
      calls.map((c) => c.argv[2]),
      ["start", "show"],
    );
  }
});

test("a start Ajour ends before t3 answers says the thread may exist", async () => {
  for (const code of ["timeout", "capture_incomplete", "output_limit"]) {
    fakeT3(refuse(code));
    await assert.rejects(startHandoff(startRequest()), {
      message:
        "T3 Code may have started the thread. Check T3 Code before handing off again.",
      // Ajour keeps the worktree the thread may run in (ajour#857).
      mayHaveStarted: true,
    });
  }
});

test("a start whose answer names no thread says the thread may exist", async () => {
  fakeT3(() => out({}));
  await assert.rejects(startHandoff(startRequest()), {
    message:
      "T3 Code returned no thread ID. Check T3 Code before handing off again.",
    mayHaveStarted: true,
  });
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
    calls.map((c) => [c.argv, c.cwd]),
    [
      [["t3", "thread", "list", "--project", FOLDER, "--json"], FOLDER],
      [["t3", "thread", "show", threadId, "--json", "--messages", "0"], FOLDER],
    ],
  );
});

test("each thread show runs in its own handoff's folder", async () => {
  const other = { ...listed, threadId: "mcp:other", status: "running" };
  const calls = fakeT3((argv) => {
    if (argv[2] === "list")
      return out(
        argv[4] === "folder-2" ? [other] : [{ ...listed, status: "running" }],
      );
    return out({ thread: { ...shown, threadId: argv[3], status: "running" } });
  });
  const updates = await readHandoffStates({
    tool: "t3",
    handoffs: [
      handoff("h1"),
      { ...handoff("h2", undefined, "folder-2"), threadId: "mcp:other" },
    ],
  });
  assert.deepEqual(
    updates.map((u) => [u.state, u.native.reason]),
    [
      ["working", undefined],
      ["working", undefined],
    ],
  );
  assert.deepEqual(
    calls.map((c) => [c.argv[2], c.argv[2] === "show" ? c.argv[3] : "", c.cwd]),
    [
      ["list", "", FOLDER],
      ["show", threadId, FOLDER],
      ["list", "", "folder-2"],
      ["show", "mcp:other", "folder-2"],
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
  // thread show runs in the handoff's folder, as the list does.
  assert.deepEqual(
    calls.map((c) => [c.argv[2], c.cwd]),
    [
      ["list", FOLDER],
      ["show", FOLDER],
    ],
  );
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
  fakeT3(() => fail(`${warning}${read("no-server.txt")}`));
  const [unknown] = await readHandoffStates({
    tool: "t3",
    handoffs: [handoff("h1", { state: "ready" })],
  });
  assert.equal(unknown.state, "unknown");
  assert.match(unknown.native.reason, /isn't running/);

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

test("each broker refusal reads as what to do next", async (t) => {
  // A concurrency refusal is asked again for about 3 seconds first.
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
    invalid_request: /Check the branch, source branch, provider and model/,
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
    const [tool] = (await settleWithTimers(t, detectTools())).tools;
    if (typeof expected === "string") assert.equal(tool.reason, expected, code);
    else assert.match(tool.reason, expected, code);
  }
});

test("another tool id is refused", async () => {
  fakeT3(() => ok(""));
  await assert.rejects(
    readHandoffStates({ tool: "aider", handoffs: [] }),
    /no handoff tool/,
  );
});

// Listing threads

// `t3 thread list --project <folder> --json`, recorded and renamed: titles
// with one and two keys, settled and running threads, and a subagent's.
const folderThreads = json("list-threads");
const otherThreads = json("list-threads-other");
const listRequest = (extra = {}) => ({
  tool: "t3",
  folder: { id: FOLDER },
  limit: 50,
  ...extra,
});

/** Answers thread list with each folder's own recorded threads. */
const listedT3 = (argv) =>
  argv[2] === "list"
    ? out(argv[4] === "folder-2" ? otherThreads : folderThreads)
    : undefined;

test("a listing runs thread list for the folder and answers its threads newest first, as a start would", async () => {
  const calls = fakeT3(listedT3);
  const { threads } = await listThreads(listRequest());
  assert.deepEqual(
    calls.map((c) => c.argv),
    [["t3", "thread", "list", "--project", FOLDER, "--json"]],
  );
  // A subagent's thread works for its parent, so only top-level threads.
  const top = folderThreads.slice(0, 4);
  assert.deepEqual(
    threads.map((t) => [t.threadId, t.title, t.link, t.updatedAt]),
    top.map((t) => [
      t.threadId,
      t.title,
      appLink(t.link),
      Date.parse(t.updatedAt),
    ]),
  );
  // A title with several keys stays whole; Ajour reads its keys.
  assert.equal(threads[0].title, "[PAY-12] [PAY-13] Share the session cookie");
  assert.deepEqual(
    threads.map((t) => [t.native.state, t.native.label]),
    [
      ["working", "Working"],
      ["done", "Settled"],
      ["done", "Settled"],
      ["ready", "Ready for review"],
    ],
  );
  // The state as the listing saw it, which Ajour's clean up reads (ajour#857).
  assert.deepEqual(
    threads.map((t) => t.state),
    ["working", "done", "done", "ready"],
  );
  assert.deepEqual(threads[0].native, {
    state: "working",
    label: "Working",
    status: "running",
    projectId: top[0].projectId,
    settled: false,
    snoozed: false,
    snoozedUntil: null,
  });
  for (const thread of threads) {
    assert.equal(thread.resume, undefined);
    assertNativeFits(thread.native);
  }
});

test("a listing answers only the folder's threads, and another folder's from its own list", async () => {
  const calls = fakeT3(listedT3);
  const first = await listThreads(listRequest());
  const second = await listThreads(listRequest({ folder: { id: "folder-2" } }));
  assert.deepEqual(
    calls.map((c) => c.argv[4]),
    [FOLDER, "folder-2"],
  );
  assert.ok(
    !first.threads.some((t) => t.threadId === otherThreads[0].threadId),
  );
  assert.deepEqual(
    second.threads.map((t) => [t.threadId, t.title]),
    [[otherThreads[0].threadId, "[PAY-12] The same key in another repository"]],
  );
});

test("a listing keeps threads changed after since, each once, at most limit", async () => {
  fakeT3((argv) => out([...folderThreads, folderThreads[1]]));
  const since = Date.parse(folderThreads[2].updatedAt);
  const { threads } = await listThreads(listRequest({ since }));
  assert.deepEqual(
    threads.map((t) => t.threadId),
    folderThreads.slice(0, 2).map((t) => t.threadId),
  );
  const limited = await listThreads(listRequest({ limit: 1 }));
  assert.deepEqual(
    limited.threads.map((t) => t.threadId),
    [folderThreads[0].threadId],
  );
  const once = await listThreads(listRequest());
  assert.equal(
    new Set(once.threads.map((t) => t.threadId)).size,
    once.threads.length,
  );
});

test("a listing skips a thread without an id or a title, and cuts a long title", async () => {
  const long = { ...folderThreads[3], title: `[PAY-12] ${"x".repeat(600)}` };
  fakeT3(() =>
    out([
      { ...folderThreads[0], threadId: "" },
      { ...folderThreads[1], title: "   " },
      long,
      "not a thread",
    ]),
  );
  const { threads } = await listThreads(listRequest());
  assert.deepEqual(
    threads.map((t) => t.threadId),
    [long.threadId],
  );
  assert.equal(threads[0].title.length, 500);
});

test("a long title is cut at 500 characters without splitting an emoji", async () => {
  // The 500th code unit is the first half of 🚀, so the cut drops it whole.
  const title = `${"x".repeat(499)}🚀 and more`;
  fakeT3(() => out([{ ...folderThreads[0], title }]));
  const { threads } = await listThreads(listRequest());
  assert.equal(threads[0].title, "x".repeat(499));
  assert.ok(threads[0].title.isWellFormed());
});

test("a listed thread refreshes through readHandoffStates and opens from its link", async () => {
  fakeT3(listedT3);
  const { threads } = await listThreads(listRequest());
  const ready = threads[3];
  const settled = threads[1];
  const updates = await readHandoffStates({
    tool: "t3",
    handoffs: [ready, settled].map((thread, i) => ({
      id: `h${i}`,
      threadId: thread.threadId,
      folderId: FOLDER,
      native: thread.native,
    })),
  });
  assert.deepEqual(
    updates.map((u) => [u.id, u.state, u.title]),
    [
      ["h0", "ready", ready.title],
      ["h1", "done", settled.title],
    ],
  );
  // Open goes to the T3 Code app, as for a started thread.
  assert.match(ready.link, /^t3code:\/\/threads\//);
  // T3 shows a listed thread by the id it listed it under.
  assert.deepEqual(
    argvOf({
      command: "thread-show",
      args: { thread: threads[0].threadId, folder: FOLDER },
    }).slice(0, 3),
    ["t3", "thread", "show"],
  );
});

test("a listing T3 can't answer throws what to do", async () => {
  fakeT3(() => fail(read("no-server.txt")));
  await assert.rejects(listThreads(listRequest()), /T3 Code isn't running/);
  fakeT3(() => ok("not json"));
  await assert.rejects(listThreads(listRequest()), {
    message:
      "T3 Code returned output Ajour can't read. It starts with: not json",
  });
  fakeT3(() => ok(""));
  await assert.rejects(listThreads(listRequest()), {
    message: "T3 Code returned no output Ajour can read.",
  });
});

// The t3 CLI logs to stdout. A CLI older than the T3 Code app warns that the
// database is newer than it before every answer (t3 v0.1.5 against T3 Code
// 0.1.11, fixtures/db-warning.txt). Ajour read none of its answers, and a
// start it couldn't read left a thread Ajour never knew.
const warned = (value) =>
  ok(`${read("db-warning.txt")}${JSON.stringify(value)}\n`);

test("a listing reads T3's threads after the log lines t3 prints first", async () => {
  fakeT3(() => warned(json("list")));
  const { threads } = await listThreads(listRequest());
  assert.equal(threads[0].threadId, listed.threadId);
  assert.equal(threads[0].link, link);
});

test("a start reads the new thread after the log lines t3 prints first", async () => {
  fakeT3((argv) =>
    argv[2] === "start" ? warned(started) : warned(json("show")),
  );
  const result = await startHandoff(startRequest());
  assert.equal(result.threadId, threadId);
  assert.equal(result.link, link);
  assert.equal(result.native.reason, undefined);
});

test("a start whose answer Ajour can't read says the thread may exist, and what t3 printed", async () => {
  fakeT3(() => ok(read("db-warning.txt")));
  await assert.rejects(startHandoff(startRequest()), {
    message:
      "T3 Code may have started the thread. Check T3 Code before handing off again. T3 Code returned output Ajour can't read. It starts with: [15:17:44.306] WARN (#20): Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name. {",
    mayHaveStarted: true,
  });
});

test("a command Ajour refuses as busy runs once one of the plugin's commands ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let refusals = 0;
  globalThis.ajour = createFakeAjour({
    manifest,
    processRun: async (request) => {
      if (request.command !== "thread-list")
        throw refused("executable_missing");
      if (refusals < 3) {
        refusals += 1;
        throw refused("concurrency");
      }
      return out(json("list"));
    },
  });
  const { threads } = await settleWithTimers(t, listThreads(listRequest()));
  assert.equal(refusals, 3);
  assert.equal(threads[0].threadId, listed.threadId);
});
