// The OpenCode tool against answers recorded from the real OpenCode 2.3.2 CLI
// (macOS, isolated XDG folders, see fixtures/opencode/README.md). The fake
// broker expands each `opencode` command to argv from plugin.json the way
// Ajour does, and a fake opencode answers it with the recorded output.
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
  NO_ANSWER,
  STARTING_MS,
  newSessionId,
  versionProblem,
} from "../src/opencode.ts";
import {
  argvOf,
  fakeBroker,
  folders,
  ok,
  refuse,
  refused,
} from "./fake-broker.mjs";

const fixture = (name) =>
  readFileSync(new URL(`fixtures/opencode/${name}`, import.meta.url), "utf8");
const recorded = (name) => JSON.parse(fixture(name));

const FOLDER = "folder-1";
const PATH = "/Users/dev/repos/ajour";
const SUCCEEDED = recorded("session-succeeded.json").data;
const FAILED = recorded("session-failed.json").data;
const INTERRUPTED = recorded("session-interrupted.json").data;
const CREATED = recorded("session-created.json").data;
const ID_FORM = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const late = /OpenCode took too long; refreshing again later/;

afterEach(() => {
  delete globalThis.ajour;
  for (const id of Object.keys(folders)) delete folders[id];
});

/** `opencode api` on an error answer: the body, and the status on stderr. */
const notFound = {
  exitCode: 1,
  stdout: fixture("session-not-found.json"),
  stderr: "HTTP 404 Not Found\n",
};
const answer = (data) => ok(`${JSON.stringify({ data })}\n`);

/**
 * Installs a fake opencode. `sessions` answers `session.get` by session id,
 * and `messages` answers `session.message.list`.
 */
function fakeOpenCode({ sessions = {}, messages = {}, run } = {}) {
  folders[FOLDER] = PATH;
  return fakeBroker((argv, call) => {
    // Detection asks every tool; these tests have only opencode.
    if (argv[0] !== "opencode") throw refused("executable_missing");
    if (run) return run(argv, call);
    if (argv[1] === "--version") return ok(fixture("version.txt"));
    const session = argv[4]?.replace(/^sessionID=/, "");
    if (argv[2] === "session.get")
      return sessions[session] ? answer(sessions[session]) : notFound;
    if (argv[2] === "session.message.list")
      return messages[session]
        ? ok(JSON.stringify(messages[session]))
        : notFound;
    if (argv[1] === "session") return ok(fixture("sessions.json"));
    return undefined;
  });
}

const startRequest = (settings = {}) => ({
  tool: "opencode",
  folder: { id: FOLDER, name: "ajour" },
  prompt: "Work on AJ-42: hand off to OpenCode\n\n- Start it.\n",
  title: "AJ-42 Hand off to OpenCode",
  branch: "aj-42-opencode",
  item: { key: "AJ-42", url: "https://example.com/AJ-42" },
  settings,
});

const handoff = (session, native = { state: "working" }, id = "h1") => ({
  id,
  threadId: session.id ?? session,
  folderId: FOLDER,
  native,
});

const read = (...handoffs) =>
  readHandoffStates({ tool: "opencode", handoffs });

test("detection reads opencode --version and takes OpenCode 2.3.2", async () => {
  const calls = fakeOpenCode();
  const { tools } = await detectTools();
  assert.deepEqual(tools[3], {
    id: "opencode",
    available: true,
    version: "2.3.2",
  });
  assert.deepEqual(
    calls.filter((c) => c.argv[0] === "opencode").map((c) => c.argv),
    [["opencode", "--version"]],
  );
});

test("detection refuses OpenCode 1 and a later major version, with what to do", async () => {
  for (const [output, reason] of [
    // OpenCode 1 printed its version alone.
    [
      "1.19.5\n",
      "OpenCode 1.19.5 is older than 2.3.2, the first version Ajour supports. Run opencode upgrade.",
    ],
    [
      "opencode v3.0.0\n",
      "OpenCode 3.0.0 isn't supported yet. Ajour hands off to OpenCode 2.3.2 or a later 2.x version.",
    ],
  ]) {
    fakeOpenCode({ run: () => ok(output) });
    const { tools } = await detectTools();
    assert.deepEqual(tools[3], { id: "opencode", available: false, reason });
  }
});

test("a missing opencode is unavailable with the reason", async () => {
  fakeOpenCode({ run: refuse("executable_missing") });
  const { tools } = await detectTools();
  assert.equal(
    tools[3].reason,
    "OpenCode isn't installed, or its opencode command isn't on PATH.",
  );
});

test("versions read as the plugin supports them", () => {
  assert.equal(versionProblem("2.3.2"), undefined);
  assert.equal(versionProblem("2.10.0"), undefined);
  assert.match(versionProblem("2.3.1"), /older than 2\.3\.2/);
  assert.match(versionProblem("dev"), /a version Ajour can't read: dev/);
});

test("session ids have OpenCode's form, and sort newest first as OpenCode's do", () => {
  // OpenCode made this id itself, for a session created without one.
  const own = recorded("session-create-own-id.json").data;
  assert.match(own.id, ID_FORM);
  const at = own.time.created;
  assert.match(newSessionId(at), ID_FORM);
  assert.ok(newSessionId(at + 1000) < own.id);
  assert.ok(newSessionId(at - 1000) > own.id);
});

test("a start runs opencode run detached in the folder, with its own session id, the title, and the prompt on stdin", async () => {
  const calls = fakeOpenCode();
  const before = Date.now();
  const result = await startHandoff(startRequest());
  assert.match(result.threadId, ID_FORM);
  assert.deepEqual(calls, [
    {
      argv: [
        "opencode",
        "run",
        "-s",
        result.threadId,
        "--title",
        "AJ-42 Hand off to OpenCode",
      ],
      mode: "detached",
      cwd: PATH,
      stdin: startRequest().prompt,
    },
  ]);
  assert.deepEqual(result.resume, {
    command: "opencode-open",
    args: { session: result.threadId, folder: FOLDER },
  });
  assert.equal(result.native.state, "working");
  assert.equal(result.native.label, "Starting");
  assert.ok(result.native.started >= before);
});

test("Open shows the session in OpenCode's terminal interface, in its folder", async () => {
  fakeOpenCode();
  const { threadId, resume } = await startHandoff(startRequest());
  assert.deepEqual(argvOf(resume), ["opencode", PATH, "-s", threadId]);
});

test("a start passes the model and agent settings", async () => {
  const calls = fakeOpenCode();
  await startHandoff(
    startRequest({ model: "anthropic/claude-sonnet-4-5", agent: "plan" }),
  );
  assert.deepEqual(calls[0].argv.slice(6), [
    "--model",
    "anthropic/claude-sonnet-4-5",
    "--agent",
    "plan",
  ]);
});

test("a start refuses a model without a provider before it runs opencode", async () => {
  const calls = fakeOpenCode();
  await assert.rejects(startHandoff(startRequest({ model: "sonnet" })), {
    message:
      "Write OpenCode's model as provider/model, such as anthropic/claude-sonnet-4-5.",
  });
  assert.deepEqual(calls, []);
});

test("a start opencode didn't read says what to check", async () => {
  fakeOpenCode({ run: refuse("stdin_failed") });
  await assert.rejects(startHandoff(startRequest()), {
    message:
      "OpenCode didn't read the prompt: it stopped first, or took more than 10 seconds to start. Run opencode in the repository folder to check that it starts, then hand off again.",
  });
});

test("a session whose run succeeded is ready for review, from one read", async () => {
  const calls = fakeOpenCode({ sessions: { [SUCCEEDED.id]: SUCCEEDED } });
  assert.deepEqual(await read(handoff(SUCCEEDED)), [
    {
      id: "h1",
      state: "ready",
      native: {
        state: "ready",
        label: "Ready for review",
        idle: SUCCEEDED.time.idle,
        outcome: "succeeded",
      },
    },
  ]);
  assert.deepEqual(
    calls.map((c) => [c.argv, c.mode]),
    [
      [
        ["opencode", "api", "session.get", "--param", `sessionID=${SUCCEEDED.id}`],
        "capture",
      ],
    ],
  );
});

test("a session you stopped is ready, labeled Stopped", async () => {
  fakeOpenCode({ sessions: { [INTERRUPTED.id]: INTERRUPTED } });
  const [update] = await read(handoff(INTERRUPTED));
  assert.equal(update.state, "ready");
  assert.equal(update.native.label, "Stopped");
});

test("a failed run is failed with OpenCode's reason, read from its newest message once", async () => {
  const calls = fakeOpenCode({
    sessions: { [FAILED.id]: FAILED },
    messages: { [FAILED.id]: recorded("messages-failed.json") },
  });
  const [first] = await read(handoff(FAILED));
  assert.deepEqual(first, {
    id: "h1",
    state: "failed",
    native: {
      state: "failed",
      label: "Failed",
      idle: FAILED.time.idle,
      outcome: "failed",
      reason: "Model unavailable: missing-provider/missing-model",
      error: "provider.no-route",
    },
  });
  assert.deepEqual(calls[1].argv, [
    "opencode",
    "api",
    "session.message.list",
    "--param",
    `sessionID=${FAILED.id}`,
    "--param",
    "limit=1",
  ]);
  // Unchanged since: the reason is kept, and the messages aren't read again.
  calls.length = 0;
  const [again] = await read(handoff(FAILED, first.native));
  assert.equal(again.state, "failed");
  assert.equal(again.native.reason, first.native.reason);
  assert.deepEqual(
    calls.map((c) => c.argv[2]),
    ["session.get"],
  );
});

test("a later failed run reads its own reason, not the one before", async () => {
  const calls = fakeOpenCode({
    sessions: { [FAILED.id]: FAILED },
    messages: { [FAILED.id]: recorded("messages-failed.json") },
  });
  const [update] = await read(
    handoff(FAILED, {
      state: "failed",
      label: "Failed",
      idle: FAILED.time.idle - 60_000,
      outcome: "failed",
      reason: "An earlier run's reason",
    }),
  );
  assert.equal(
    update.native.reason,
    "Model unavailable: missing-provider/missing-model",
  );
  assert.deepEqual(
    calls.map((c) => c.argv[2]),
    ["session.get", "session.message.list"],
  );
});

test("a session with a run in progress is working, a later turn included", async () => {
  // Between the start and the end of a run, OpenCode stores `time.busy`, and
  // `time.idle` stays at the previous run's end, if any.
  const running = {
    ...SUCCEEDED,
    time: { ...SUCCEEDED.time, idle: undefined },
    outcome: undefined,
  };
  const again = {
    ...SUCCEEDED,
    time: { ...SUCCEEDED.time, busy: SUCCEEDED.time.idle + 5000 },
  };
  fakeOpenCode({ sessions: { [running.id]: running, ses_again0000000: again } });
  const updates = await read(
    handoff(running),
    handoff("ses_again0000000", { state: "ready" }, "h2"),
  );
  assert.deepEqual(
    updates.map((u) => [u.state, u.native.label]),
    [
      ["working", "Working"],
      ["working", "Working"],
    ],
  );
});

test("a session OpenCode created without a run is starting for a minute, then failed", async (t) => {
  fakeOpenCode({ sessions: { [CREATED.id]: CREATED } });
  t.mock.timers.enable({ apis: ["Date"], now: CREATED.time.created + 5000 });
  const [starting] = await read(handoff(CREATED));
  assert.deepEqual(
    [starting.state, starting.native.label],
    ["working", "Starting"],
  );
  t.mock.timers.setTime(CREATED.time.created + STARTING_MS + 1);
  const [failed] = await read(handoff(CREATED));
  assert.deepEqual([failed.state, failed.native.reason], ["failed", NO_ANSWER]);
});

test("a session OpenCode doesn't have is starting right after the start, then gone", async () => {
  fakeOpenCode();
  const id = "ses_e0ae30357ffe4n3E2Vl9D928ae";
  const started = Date.now();
  const [starting] = await read(handoff(id, { state: "working", started }));
  assert.deepEqual(starting, {
    id: "h1",
    state: "working",
    native: { state: "working", label: "Starting", started },
  });
  const [gone] = await read(
    handoff(id, { state: "working", started: started - STARTING_MS - 1 }),
  );
  assert.deepEqual(gone.native, { state: "gone", label: "Not on OpenCode" });
});

test("a read opencode can't answer leaves the handoff unknown with the reason, never gone", async () => {
  fakeOpenCode({
    run: () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Error: Background service failed to start\n",
    }),
  });
  const [update] = await read(
    handoff(SUCCEEDED, { state: "ready", label: "Ready for review" }),
  );
  assert.equal(update.state, "unknown");
  assert.equal(update.native.reason, "Background service failed to start");
});

test("a refresh cut short keeps every state", async () => {
  fakeOpenCode({ run: refuse("timeout") });
  const [update] = await read(
    handoff(SUCCEEDED, { state: "ready", label: "Ready for review", idle: 1 }),
  );
  assert.equal(update.state, "ready");
  assert.equal(update.native.label, "Ready for review");
  assert.equal(update.native.idle, 1);
  assert.match(update.native.reason, late);
});

test("a handoff whose session id isn't OpenCode's is unknown, and never reaches a command", async () => {
  const calls = fakeOpenCode();
  const [update] = await read(handoff("thr_from-another-tool"));
  assert.equal(update.state, "unknown");
  assert.equal(
    update.native.reason,
    "This handoff's OpenCode session id isn't one Ajour can read.",
  );
  assert.deepEqual(calls, []);
});

test("a listing runs opencode session list in the folder and lists the project's sessions newest first", async () => {
  const calls = fakeOpenCode();
  const sessions = recorded("sessions.json");
  const { threads } = await listThreads({
    tool: "opencode",
    folder: { id: FOLDER },
    limit: 50,
  });
  assert.deepEqual(calls, [
    {
      argv: ["opencode", "session", "list", "--format", "json", "-n", "50"],
      mode: "capture",
      cwd: PATH,
      stdin: undefined,
    },
  ]);
  // The subfolder's session is in the repository's project; the other
  // repository's session isn't listed by OpenCode at all.
  assert.deepEqual(
    threads.map((t) => [t.threadId, t.title, t.updatedAt]),
    sessions.map((s) => [s.id, s.title, s.updated]),
  );
  assert.deepEqual(threads[0].resume, {
    command: "opencode-open",
    args: { session: sessions[0].id, folder: FOLDER },
  });
  assert.deepEqual(threads[0].native, { state: "unknown", label: "Unknown" });
});

test("a listing keeps the sessions changed after since", async () => {
  fakeOpenCode();
  const sessions = recorded("sessions.json");
  const { threads } = await listThreads({
    tool: "opencode",
    folder: { id: FOLDER },
    since: sessions[1].updated,
    limit: 50,
  });
  assert.deepEqual(
    threads.map((t) => t.threadId),
    [sessions[0].id],
  );
});
