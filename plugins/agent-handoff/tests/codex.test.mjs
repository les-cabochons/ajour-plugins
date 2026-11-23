// The Codex tool against JSON-RPC exchanges recorded from the real
// `codex app-server` (codex-cli 0.169.0 on Windows, see
// fixtures/codex/README.md), replayed through the SDK fake's process
// sessions after the fake broker expands the session command from
// plugin.json the way Ajour does.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  closeThread,
  detectTools,
  listThreads,
  readHandoffStates,
  startHandoff,
} from "../src/plugin.ts";
import {
  BUSY_CLOSING,
  BUSY_LISTING,
  BUSY_READING,
  BUSY_STARTING,
  ELSEWHERE,
  GONE,
  NOT_RECORDED,
  RELEASED,
  STOPPED,
  UNKNOWN_TURN,
} from "../src/codex.ts";
import { find, recorded, replay } from "./codex-replay.mjs";
import {
  fakeBroker,
  flush,
  folders,
  manifest,
  ok,
  refuse,
  refused,
} from "./fake-broker.mjs";

const FOLDER = "folder-1";
const PATH = "C:\\work\\repo";
const version = "codex-cli 0.169.0\n";
const late = /Codex took too long; refreshing again later/;

/** The thread and turn ids a recorded start answered with. */
function started(name) {
  const thread = find(name, (m) => m.result?.thread).result.thread.id;
  const turn = find(name, (m) => m.result?.turn).result.turn.id;
  return { thread, turn };
}
const ok1 = started("start-ok");
const bad = started("start-bad");
const cut = started("start-cut");
const approval = started("approval");
const gone = "01a1e630-d2db-76c2-9ac3-00eddbdd743d";
const archived = "01a1e62f-b61a-75c2-a2cf-6695ede54dbf";
// A thread whose session ended a moment after its turn started.
const early = {
  thread: "01a1e63b-3db2-7ca0-8a9a-a1eea8201b74",
  turn: "01a1e63b-3fc3-7d82-9fb7-4b43c7768605",
};

afterEach(() => {
  delete globalThis.ajour;
  for (const id of Object.keys(folders)) delete folders[id];
});

/**
 * Installs a fake codex: `codex --version` answers as recorded, and each
 * session the plugin opens runs the next program of `programs`.
 */
function fakeCodex(programs = [], { run } = {}) {
  folders[FOLDER] = PATH;
  const queue = [...programs];
  const sent = [];
  const calls = fakeBroker(
    (argv, call) => {
      if (argv[0] !== "codex") throw refused("executable_missing");
      if (run) return run(argv, call);
      if (argv[1] === "--version") return ok(version);
      throw new Error(`unexpected ${argv.join(" ")}`);
    },
    {
      session: (argv, running) => {
        const next = queue.shift();
        if (!next) throw new Error(`no program for ${argv.join(" ")}`);
        if (typeof next === "function") return next(running);
        sent.push(next.log);
        return next.handler;
      },
    },
  );
  return { calls, sent };
}

/** A recorded program, with the lines the plugin sent it. */
function program(name, options = {}) {
  const log = [];
  return { log, handler: replay(name, { ...options, log }) };
}

const messages = (log) => log.map((line) => JSON.parse(line));

function startRequest(settings = {}) {
  return {
    tool: "codex",
    folder: { id: FOLDER, name: "repo" },
    prompt: "Reply with OK and do nothing else.",
    title: "Ajour live ok",
    item: { key: "AJ-1", url: "https://example.com/AJ-1" },
    settings: { open: "app", ...settings },
  };
}

function handoff(id, threadId, native) {
  return { id, threadId, folderId: FOLDER, native };
}

const sessionsOf = () => globalThis.ajour.sessions;

/**
 * A program that answers each request with `answer(message)`: a result, an
 * `{ error }`, or `undefined` for no answer. `{ lines }` writes those first.
 */
function answering(answer) {
  return () => ({
    receive(line) {
      const message = JSON.parse(line);
      if (message.id === undefined || !message.method) return [];
      const answered = answer(message);
      if (answered === undefined) return [];
      const { lines = [], ...rest } = answered;
      const reply = rest.error
        ? { id: message.id, error: rest.error }
        : { id: message.id, result: rest.result ?? rest };
      return [...lines, JSON.stringify(reply)];
    },
  });
}

/** Opens a session as a start would have, and returns its id. */
const openSession = () =>
  globalThis.ajour.process.session.open({
    command: "codex-app-server",
    args: { folder: FOLDER },
  });

const idleThread = (status = { type: "idle" }) => ({
  result: { thread: { id: ok1.thread, name: "Ajour live ok", status } },
});

/** Ticks mocked timers until `promise` settles, and returns its outcome. */
async function settle(t, promise, steps = 1300) {
  let outcome;
  const pending = promise.then(
    (value) => (outcome = { value }),
    (error) => (outcome = { error }),
  );
  for (let i = 0; i < steps && !outcome; i++) {
    await flush();
    t.mock.timers.tick(25);
  }
  await pending;
  return outcome;
}

test("detects Codex from codex --version", async () => {
  fakeCodex();
  const { tools } = await detectTools();
  assert.deepEqual(tools.find((tool) => tool.id === "codex"), {
    id: "codex",
    available: true,
    version: "0.169.0",
  });
});

test("a missing codex is unavailable with the reason", async () => {
  fakeCodex([], { run: refuse("executable_missing") });
  const { tools } = await detectTools();
  assert.deepEqual(tools.find((tool) => tool.id === "codex"), {
    id: "codex",
    available: false,
    reason: "Codex isn't installed, or its codex command isn't on PATH.",
  });
});

test("a start runs the app-server in the folder and sends the title and prompt as JSON", async () => {
  const server = program("start-ok");
  const { calls } = fakeCodex([server]);
  const result = await startHandoff(startRequest());
  // The broker starts the session in its first folder argument; app-server
  // ignores -C, and works in the folder it starts in.
  assert.deepEqual(calls, [
    {
      argv: ["codex", "-C", PATH, "app-server"],
      mode: "session",
      cwd: PATH,
      session: true,
    },
  ]);
  const sent = messages(server.log);
  assert.deepEqual(
    sent.map((m) => m.method),
    [
      "initialize",
      "initialized",
      "thread/start",
      "thread/name/set",
      "turn/start",
    ],
  );
  // Codex refuses initialize without a version; it is the plugin's own.
  assert.deepEqual(sent[0].params, {
    clientInfo: { name: "ajour", title: "Ajour", version: manifest.version },
  });
  // No model setting: the user's Codex config chooses.
  assert.deepEqual(sent[2].params, {});
  assert.deepEqual(sent[3].params, {
    threadId: ok1.thread,
    name: "Ajour live ok",
  });
  assert.deepEqual(sent[4].params, {
    threadId: ok1.thread,
    input: [{ type: "text", text: "Reply with OK and do nothing else." }],
  });
  assert.ok(sent.every((m) => m.id === undefined || /^ajour-/.test(m.id)));
  const [session] = sessionsOf();
  assert.equal(session.state, "open");
  assert.deepEqual(result, {
    threadId: ok1.thread,
    link: `codex://threads/${ok1.thread}`,
    resume: {
      command: "codex-resume",
      args: { thread: ok1.thread, folder: FOLDER },
    },
    native: {
      state: "working",
      label: "Working",
      open: "app",
      session: session.id,
      turn: ok1.turn,
      started: result.native.started,
    },
  });
  // When the turn started, which a refresh's grace is measured from.
  assert.match(result.native.started, /^\d+$/);
});

test("a multi-line prompt stays one JSON line, never an argument", async () => {
  const server = program("start-ok");
  const { calls } = fakeCodex([server]);
  const prompt =
    'Work on AJ-1: Fix login\n\n-- leading dash\r\nand quotes "here"';
  await startHandoff({ ...startRequest(), prompt });
  const turn = messages(server.log).find((m) => m.method === "turn/start");
  assert.equal(turn.params.input[0].text, prompt);
  assert.ok(!calls[0].argv.some((arg) => arg.includes("AJ-1")));
});

test("a model goes to thread/start, and the terminal open mode returns no link", async () => {
  const server = program("start-bad");
  fakeCodex([server]);
  const result = await startHandoff(
    startRequest({ model: " ajour-invalid-model-probe ", open: "terminal" }),
  );
  const [, , start] = messages(server.log);
  assert.deepEqual(start.params, { model: "ajour-invalid-model-probe" });
  assert.equal(result.link, undefined);
  assert.deepEqual(result.resume, {
    command: "codex-resume",
    args: { thread: bad.thread, folder: FOLDER },
  });
  assert.equal(result.native.open, "terminal");
});

test("a prompt over 1 MB as JSON is refused before a session opens", async () => {
  const { calls } = fakeCodex([]);
  await assert.rejects(
    startHandoff({ ...startRequest(), prompt: "é".repeat(600_000) }),
    {
      message:
        "The prompt is longer than the 1 MB Ajour sends Codex at once. Shorten the handoff template, such as by leaving out the item's description.",
    },
  );
  assert.deepEqual(calls, []);
});

test("each refusal of the session names Codex and says what to do next", async () => {
  const cases = {
    executable_missing:
      "Codex isn't installed, or its codex command isn't on PATH.",
    needs_consent:
      "Open this plugin's Access section in Settings › Plugins and choose Allow and activate.",
    folder_refused:
      "Ajour couldn't use this project's repository folder. Check the folder in the project's settings.",
    something_new: "Ajour couldn't run codex (something_new).",
  };
  for (const [code, message] of Object.entries(cases)) {
    fakeCodex([refuse(code)]);
    await assert.rejects(startHandoff(startRequest()), { message, code });
  }
});

test("a third start waits 3 seconds once, then says two handoffs are running", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  fakeCodex([program("start-ok"), program("start-bad"), program("start-cut")]);
  await startHandoff(startRequest());
  await startHandoff(startRequest());
  const began = Date.now();
  const { error } = await settle(t, startHandoff(startRequest()));
  assert.equal(error.code, "session_limit");
  assert.equal(error.message, BUSY_STARTING);
  assert.equal(
    BUSY_STARTING,
    "Ajour runs at most two Codex handoffs at once, and two are running. Hand off again when one finishes or waits for you.",
  );
  const waited = Date.now() - began;
  assert.ok(waited >= 3000 && waited < 4000, `waited ${waited} ms`);
  // The third program never ran.
  assert.equal(sessionsOf().length, 2);
});

test("a start that meets a refresh's reader gets the session once the reader closes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  fakeCodex([
    program("start-ok"),
    answering(() => undefined),
    program("start-ok"),
  ]);
  await startHandoff(startRequest());
  // A refresh of another project holds the second session for a moment.
  const reader = await openSession();
  setTimeout(() => globalThis.ajour.process.session.close(reader), 1000);
  const { value, error } = await settle(t, startHandoff(startRequest()));
  assert.equal(error, undefined);
  assert.equal(value.threadId, ok1.thread);
  assert.equal(sessionsOf().at(-1).state, "open");
});

test("Codex refusing the thread fails the start and ends the session", async () => {
  const server = program("start-ok", {});
  fakeCodex([
    () => ({
      receive(line) {
        const message = JSON.parse(line);
        if (message.method === "thread/start")
          return [
            JSON.stringify({
              id: message.id,
              error: {
                code: -32600,
                message: "invalid thread params\nmore detail",
              },
            }),
          ];
        return server.handler.receive(line);
      },
    }),
  ]);
  await assert.rejects(startHandoff(startRequest()), {
    message: "Codex didn't start the turn: invalid thread params",
  });
  assert.equal(sessionsOf()[0].state, "closed");
});

test("a program that exits during the start fails it", async () => {
  fakeCodex([
    (running) => ({
      receive() {
        // codex quits before it answers initialize.
        running.writeStderr("error: something went wrong");
        running.exit(1);
        return [];
      },
    }),
  ]);
  await assert.rejects(startHandoff(startRequest()), {
    message: "Ajour's session with Codex ended. Try again.",
  });
});

test("a start keeps the handoff when the turn isn't answered by 27 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const server = program("start-ok");
  fakeCodex([
    () => ({
      receive(line) {
        // turn/start goes unanswered: the turn may be running.
        if (JSON.parse(line).method === "turn/start") return [];
        return server.handler.receive(line);
      },
    }),
  ]);
  let result;
  const pending = startHandoff(startRequest()).then((r) => {
    result = r;
  });
  for (let i = 0; i < 1100 && !result; i++) {
    await flush();
    t.mock.timers.tick(25);
  }
  await pending;
  assert.equal(result.threadId, ok1.thread);
  assert.equal(result.native.turn, undefined);
  assert.equal(
    result.native.reason,
    "Codex may have started the thread. Check Codex before handing off again.",
  );
  assert.equal(sessionsOf()[0].state, "open");
});

test("a start whose session ends once its thread exists says the thread may exist", async () => {
  const server = program("start-ok");
  fakeCodex([
    (running) => ({
      receive(line) {
        // codex quits once it has the turn: the turn may be running.
        if (JSON.parse(line).method === "turn/start") {
          running.exit(1);
          return [];
        }
        return server.handler.receive(line);
      },
    }),
  ]);
  await assert.rejects(startHandoff(startRequest()), {
    message:
      "Codex may have started the thread. Check Codex before handing off again.",
    // Ajour keeps the worktree the thread may run in (ajour#857).
    mayHaveStarted: true,
  });
});

test("a start that gets no thread by 27 seconds fails, and ends its session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const server = program("start-ok");
  fakeCodex([
    () => ({
      receive(line) {
        if (JSON.parse(line).method === "thread/start") return [];
        return server.handler.receive(line);
      },
    }),
  ]);
  let error;
  const pending = startHandoff(startRequest()).catch((e) => {
    error = e;
  });
  for (let i = 0; i < 1100 && !error; i++) {
    await flush();
    t.mock.timers.tick(25);
  }
  await pending;
  assert.equal(
    error.message,
    "Codex didn't start the thread in time. Try again.",
  );
  assert.equal(sessionsOf()[0].state, "closed");
});

test("a question Codex asked counts as needs-you even before its flag", async () => {
  const server = program("start-ok");
  let asking = false;
  fakeCodex([
    () => ({
      receive(line) {
        const lines = server.handler.receive(line);
        if (asking && JSON.parse(line).method === "thread/read")
          return [
            JSON.stringify({
              id: 3,
              method: "item/tool/requestUserInput",
              params: { threadId: ok1.thread },
            }),
            ...lines.map((l) => {
              const m = JSON.parse(l);
              // Read while the turn ran, before the flag was set.
              if (m.result?.thread)
                m.result.thread.status = { type: "active", activeFlags: [] };
              return JSON.stringify(m);
            }),
          ];
        return lines;
      },
    }),
  ]);
  const result = await startHandoff(startRequest());
  asking = true;
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [handoff("h1", result.threadId, result.native)],
  });
  assert.equal(update.state, "needs-you");
  assert.equal(update.native.label, "Waiting for your answer");
  assert.equal(sessionsOf()[0].state, "closed");
});

test("a refresh reads the live session: working, then completed, which ends the session", async () => {
  const server = program("start-ok");
  const { calls } = fakeCodex([server]);
  const result = await startHandoff(startRequest());
  const [first] = await readHandoffStates({
    tool: "codex",
    handoffs: [handoff("h1", result.threadId, result.native)],
  });
  // Codex records the turn a moment after turn/start answers.
  assert.equal(first.state, "working");
  assert.equal(first.native.session, result.native.session);
  assert.equal(sessionsOf()[0].state, "open");
  const [second] = await readHandoffStates({
    tool: "codex",
    handoffs: [handoff("h1", result.threadId, first.native)],
  });
  assert.deepEqual(second, {
    id: "h1",
    state: "ready",
    native: {
      state: "ready",
      label: "Completed",
      open: "app",
      turn: ok1.turn,
      started: result.native.started,
      status: "idle",
      turnStatus: "completed",
    },
    title: "Ajour live ok",
  });
  // The session ended, so the Codex app can open the thread.
  assert.equal(sessionsOf()[0].state, "closed");
  assert.equal(calls.length, 1);
  // The reads ask for no messages.
  const reads = messages(server.log).filter(
    (m) => m.method === "thread/turns/list",
  );
  assert.ok(reads.every((m) => m.params.itemsView === "notLoaded"));
});

test("a thread without a session is read through a new app-server, which the refresh ends", async () => {
  const reader = program("read-ok");
  const { calls } = fakeCodex([reader]);
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("h1", ok1.thread, {
        state: "ready",
        label: "Completed",
        open: "app",
        turn: ok1.turn,
      }),
    ],
  });
  assert.equal(update.state, "ready");
  assert.equal(update.native.status, "notLoaded");
  assert.equal(update.native.session, undefined);
  assert.equal(calls[0].cwd, PATH);
  assert.equal(sessionsOf()[0].state, "closed");
});

test("a turn Codex failed is failed with its own message, live and from its files", async () => {
  fakeCodex([program("start-bad"), program("read-bad")]);
  const result = await startHandoff(
    startRequest({ model: "ajour-invalid-model-probe" }),
  );
  const handoffs = (native) => [handoff("h1", result.threadId, native)];
  const [working] = await readHandoffStates({
    tool: "codex",
    handoffs: handoffs(result.native),
  });
  assert.equal(working.state, "working");
  const [failed] = await readHandoffStates({
    tool: "codex",
    handoffs: handoffs(working.native),
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.native.status, "systemError");
  assert.equal(
    failed.native.reason,
    "The 'ajour-invalid-model-probe' model is not supported when using Codex with a ChatGPT account.",
  );
  assert.equal(sessionsOf()[0].state, "closed");
  const [again] = await readHandoffStates({
    tool: "codex",
    handoffs: handoffs(failed.native),
  });
  assert.equal(again.state, "failed");
  assert.equal(again.native.status, "notLoaded");
  assert.equal(again.native.reason, failed.native.reason);
});

test("an approval request is needs-you, and the session lets go of the thread", async () => {
  // The recording read the thread, not its turns: the turn is the one
  // turn/start answered, still in progress.
  const turn = find("approval", (m) => m.result?.turn).result.turn;
  const server = program("approval", {
    unrecorded: (m) =>
      m.method === "thread/turns/list" ? { data: [turn] } : undefined,
  });
  fakeCodex([server]);
  // The start recorded here asked Codex for approvals; the plugin never does.
  const result = await startHandoff({
    ...startRequest(),
    prompt:
      "Create a file named b.txt containing the word hi. Do nothing else.",
    title: "Ajour codex approval probe",
  });
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [handoff("h1", result.threadId, result.native)],
  });
  assert.equal(update.state, "needs-you");
  assert.equal(update.native.label, "Waiting for approval");
  assert.equal(update.native.flags, "waitingOnApproval");
  assert.equal(update.native.released, true);
  assert.equal(update.native.reason, RELEASED);
  assert.equal(update.native.session, undefined);
  assert.equal(sessionsOf()[0].state, "closed");
  // The plugin never answers the approval itself.
  assert.ok(
    !messages(server.log).some((m) => m.id === 0 && m.method === undefined),
  );
});

test("a released thread stays needs-you until another turn runs", async () => {
  fakeCodex([program("read-cut")]);
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("h1", cut.thread, {
        state: "needs-you",
        label: "Waiting for approval",
        turn: cut.turn,
        released: true,
      }),
    ],
  });
  assert.equal(update.state, "needs-you");
  assert.equal(update.native.label, "Waiting for approval");
  assert.equal(update.native.reason, RELEASED);
});

test("a session that ended reads the thread from Codex's files: a cut turn is stopped", async () => {
  fakeCodex([program("start-cut"), program("read-cut")]);
  const result = await startHandoff(startRequest());
  // Ajour ended the session, as when it quits.
  await globalThis.ajour.process.session.close(result.native.session);
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [handoff("h1", result.threadId, result.native)],
  });
  assert.equal(update.state, "failed");
  assert.equal(update.native.label, "Stopped");
  assert.equal(update.native.turnStatus, "interrupted");
  assert.equal(update.native.reason, STOPPED);
  assert.equal(update.native.session, undefined);
  assert.equal(sessionsOf()[1].state, "closed");
});

test("a session id Ajour no longer knows is never gone", async () => {
  fakeCodex([program("read-cut")]);
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("h1", cut.thread, {
        state: "working",
        session: "fake-session-99",
        turn: cut.turn,
      }),
    ],
  });
  assert.equal(update.state, "failed");
  assert.equal(update.native.reason, STOPPED);
});

test("an interrupted turn the plugin didn't start may run elsewhere: unknown", async () => {
  fakeCodex([program("read-cut")]);
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("h1", cut.thread, {
        state: "ready",
        turn: "01a1e600-0000-7000-8000-000000000000",
      }),
    ],
  });
  assert.equal(update.state, "unknown");
  assert.equal(update.native.reason, ELSEWHERE);
});

test("a thread with no recorded turn failed when the plugin started one", async () => {
  fakeCodex([program("read-unrecorded"), program("read-unrecorded")]);
  const read = (native) =>
    readHandoffStates({
      tool: "codex",
      handoffs: [handoff("h1", gone, native)],
    });
  const [ours] = await read({
    state: "working",
    turn: "01a1e630-d4ac-7500-b223-98be24f6fdeb",
  });
  assert.equal(ours.state, "failed");
  assert.equal(ours.native.reason, NOT_RECORDED);
  const [theirs] = await read({ state: "working" });
  assert.equal(theirs.state, "unknown");
});

test("a deleted thread is gone, an archived one done, in one batch", async () => {
  const reader = program("read-gone-archived");
  fakeCodex([reader]);
  const updates = await readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("gone", gone, { state: "working" }),
      handoff("archived", archived, { state: "failed" }),
      handoff("early", early.thread, { state: "working", turn: early.turn }),
    ],
  });
  assert.deepEqual(
    updates.map((u) => [u.id, u.state, u.native.label]),
    [
      ["gone", "gone", "Deleted in Codex"],
      ["archived", "done", "Archived"],
      ["early", "failed", "Stopped"],
    ],
  );
  assert.equal(updates[0].native.reason, GONE);
  // One app-server for the batch.
  assert.equal(sessionsOf().length, 1);
});

test("a read error other than a missing thread keeps the last state", async () => {
  const reader = replay("read-ok");
  fakeCodex([
    () => ({
      receive(line) {
        const message = JSON.parse(line);
        // How a second app-server answered while a new thread's first line
        // wasn't written yet (recorded, with the path replaced).
        if (message.method === "thread/read")
          return [
            JSON.stringify({
              id: message.id,
              error: {
                code: -32603,
                message:
                  "failed to read thread: thread-store internal error: failed to read session metadata C:\\Users\\user\\.codex\\sessions\\x.jsonl: rollout at C:\\Users\\user\\.codex\\sessions\\x.jsonl is empty",
              },
            }),
          ];
        return reader.receive(line);
      },
    }),
  ]);
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [handoff("h1", ok1.thread, { state: "working", turn: ok1.turn })],
  });
  assert.equal(update.state, "working");
  assert.equal(
    update.native.reason,
    "Codex couldn't read this thread. Refreshing again later.",
  );
  assert.ok(!JSON.stringify(update).includes("sessions"));
});

test("a live session that outlasts the refresh deadline keeps its state and session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  fakeCodex([() => ({ receive: () => [] })]);
  const session = await globalThis.ajour.process.session.open({
    command: "codex-app-server",
    args: { folder: FOLDER },
  });
  let updates;
  const pending = readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("h1", ok1.thread, {
        state: "working",
        label: "Working",
        session,
        turn: ok1.turn,
      }),
    ],
  }).then((u) => {
    updates = u;
  });
  for (let i = 0; i < 900 && !updates; i++) {
    await flush();
    t.mock.timers.tick(25);
  }
  await pending;
  const [update] = updates;
  assert.equal(update.state, "working");
  assert.equal(update.native.session, session);
  assert.match(update.native.reason, late);
  assert.equal(sessionsOf()[0].state, "open");
});

test("when both sessions run handoffs, a refresh keeps every state and says so", async () => {
  fakeCodex([refuse("session_limit")]);
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("h1", ok1.thread, { state: "ready", label: "Completed" }),
    ],
  });
  assert.equal(update.state, "ready");
  assert.equal(update.native.label, "Completed");
  assert.equal(update.native.reason, BUSY_READING);
  assert.equal(
    BUSY_READING,
    "Both of Ajour's Codex sessions are running handoffs; refreshing again once one is free.",
  );
});

test("a refresh opens no reader with less than 2 seconds left", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { calls } = fakeCodex([
    (running) => ({
      receive(line) {
        const message = JSON.parse(line);
        // The live thread answers 18.5 seconds in, completed.
        const answer =
          message.method === "thread/read"
            ? idleThread().result
            : {
                data: [{ id: ok1.turn, status: "completed", completedAt: 1 }],
              };
        setTimeout(
          () =>
            running.write(JSON.stringify({ id: message.id, result: answer })),
          18_500,
        );
        return [];
      },
    }),
  ]);
  const session = await openSession();
  const { value } = await settle(
    t,
    readHandoffStates({
      tool: "codex",
      handoffs: [
        handoff("live", ok1.thread, {
          state: "working",
          session,
          turn: ok1.turn,
        }),
        handoff("other", cut.thread, { state: "ready", label: "Completed" }),
      ],
    }),
  );
  const [live, other] = value;
  assert.equal(live.state, "ready");
  assert.equal(other.state, "ready");
  assert.equal(other.native.label, "Completed");
  assert.match(other.native.reason, late);
  // Only the live session ran; no reader opened.
  assert.equal(calls.length, 1);
  assert.equal(sessionsOf().length, 1);
});

test("a live working session reads the batch's other threads, with no new app-server", async () => {
  // The other thread answers as read-ok recorded its thread.
  const read = find("read-ok", (m) => m.result?.thread).result;
  const turns = find("read-ok", (m) => Array.isArray(m.result?.data)).result;
  const server = program("start-ok", {
    unrecorded: (m) =>
      m.method === "thread/read"
        ? read
        : m.method === "thread/turns/list"
          ? turns
          : undefined,
  });
  fakeCodex([server]);
  const result = await startHandoff(startRequest());
  const updates = await readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("live", result.threadId, result.native),
      handoff("other", "01a1e63c-0000-7000-8000-000000000000", {
        state: "working",
        turn: ok1.turn,
      }),
    ],
  });
  assert.deepEqual(
    updates.map((u) => [u.id, u.state]),
    [
      ["live", "working"],
      ["other", "ready"],
    ],
  );
  assert.equal(sessionsOf().length, 1);
  assert.equal(sessionsOf()[0].state, "open");
});

test("a request Codex makes that isn't for the user gets an error answer", async () => {
  const server = program("read-ok");
  fakeCodex([
    () => ({
      receive(line) {
        const lines = server.handler.receive(line);
        if (JSON.parse(line).method === "thread/read")
          return [
            JSON.stringify({
              id: 7,
              method: "item/tool/call",
              params: { threadId: ok1.thread },
            }),
            ...lines,
          ];
        return lines;
      },
    }),
  ]);
  await readHandoffStates({
    tool: "codex",
    handoffs: [handoff("h1", ok1.thread, { state: "ready" })],
  });
  const reply = messages(server.log).find((m) => m.id === 7);
  assert.deepEqual(reply, {
    id: 7,
    error: { code: -32601, message: "Ajour can't answer this request." },
  });
});

/** Reads one handoff whose turn runs in a session the test opened. */
async function readLiveOne(native = {}) {
  const session = await openSession();
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("h1", ok1.thread, {
        state: "working",
        label: "Working",
        session,
        turn: ok1.turn,
        ...native,
      }),
    ],
  });
  return { update, session };
}

test("a live thread Codex no longer has is gone, and its session closes", async () => {
  fakeCodex([
    answering((m) => ({
      error: {
        code: -32600,
        message: `thread not loaded: ${m.params.threadId}`,
      },
    })),
  ]);
  const { update } = await readLiveOne();
  assert.equal(update.state, "gone");
  assert.equal(update.native.reason, GONE);
  assert.equal(update.native.session, undefined);
  assert.equal(sessionsOf()[0].state, "closed");
});

test("a live thread that isn't active closes its session even when its turns can't be read", async () => {
  for (const status of [{ type: "idle" }, { type: "systemError" }]) {
    fakeCodex([
      answering((m) =>
        m.method === "thread/read"
          ? idleThread(status)
          : { error: { code: -32603, message: "turns unavailable" } },
      ),
    ]);
    const { update } = await readLiveOne();
    assert.equal(update.state, "working", status.type);
    assert.equal(
      update.native.reason,
      "Codex couldn't read this thread's turns. Refreshing again later.",
    );
    assert.equal(update.native.session, undefined, status.type);
    assert.equal(sessionsOf()[0].state, "closed", status.type);
  }
});

test("a fresh turn's session stays open while Codex still reads its thread as idle and its turns can't be read", async () => {
  fakeCodex([
    answering((m) =>
      m.method === "thread/read"
        ? idleThread({ type: "idle" })
        : { error: { code: -32603, message: "turns unavailable" } },
    ),
  ]);
  const { update, session } = await readLiveOne({
    started: String(Date.now()),
  });
  assert.equal(update.state, "working");
  assert.equal(update.native.session, session);
  assert.equal(update.native.started !== undefined, true);
  assert.equal(sessionsOf()[0].state, "open");
});

test("past its grace, an idle thread whose turns can't be read closes its session", async () => {
  fakeCodex([
    answering((m) =>
      m.method === "thread/read"
        ? idleThread({ type: "idle" })
        : { error: { code: -32603, message: "turns unavailable" } },
    ),
  ]);
  const { update } = await readLiveOne({
    started: String(Date.now() - 60_000),
  });
  assert.equal(update.native.session, undefined);
  assert.equal(sessionsOf()[0].state, "closed");
});

test("a fresh turn's grace doesn't keep a session whose thread reports a system error", async () => {
  fakeCodex([
    answering((m) =>
      m.method === "thread/read"
        ? idleThread({ type: "systemError" })
        : { error: { code: -32603, message: "turns unavailable" } },
    ),
  ]);
  const { update } = await readLiveOne({ started: String(Date.now()) });
  assert.equal(update.native.session, undefined);
  assert.equal(sessionsOf()[0].state, "closed");
});

test("past its grace, a live idle thread that never recorded the plugin's turn fails and closes its session", async () => {
  fakeCodex([
    answering((m) =>
      m.method === "thread/read"
        ? idleThread({ type: "idle" })
        : { result: { data: [] } },
    ),
  ]);
  const { update } = await readLiveOne({
    started: String(Date.now() - 60_000),
  });
  assert.equal(update.state, "failed");
  assert.equal(update.native.session, undefined);
  assert.equal(sessionsOf()[0].state, "closed");
});

test("an active live thread whose turns can't be read keeps its session", async () => {
  fakeCodex([
    answering((m) =>
      m.method === "thread/read"
        ? idleThread({ type: "active", activeFlags: [] })
        : { error: { code: -32603, message: "turns unavailable" } },
    ),
  ]);
  const { update, session } = await readLiveOne();
  assert.equal(update.state, "working");
  assert.equal(update.native.session, session);
  assert.equal(sessionsOf()[0].state, "open");
});

test("a Codex that doesn't know thread/read closes the live session", async () => {
  fakeCodex([
    answering(() => ({ error: { code: -32601, message: "Method not found" } })),
  ]);
  const { update } = await readLiveOne();
  assert.equal(update.state, "working");
  assert.equal(
    update.native.reason,
    "This Codex version doesn't answer the reads Ajour follows a handoff with. Check for an update of this plugin.",
  );
  assert.equal(update.native.session, undefined);
  assert.equal(sessionsOf()[0].state, "closed");
});

test("a live read Ajour refuses keeps the last state and the session", async () => {
  fakeCodex([answering(() => undefined)]);
  const session = await openSession();
  globalThis.ajour.process.session.read = async () => {
    throw refused("rate_limit");
  };
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("h1", ok1.thread, {
        state: "needs-you",
        label: "Waiting for approval",
        session,
      }),
    ],
  });
  assert.equal(update.state, "needs-you");
  assert.equal(update.native.label, "Waiting for approval");
  assert.equal(update.native.session, session);
  assert.equal(
    update.native.reason,
    "Ajour is limiting this plugin's commands. Try again in a minute.",
  );
});

test("answers that arrive with the session's exit still count", async () => {
  fakeCodex([
    answering((m) =>
      m.method === "thread/read"
        ? idleThread()
        : { data: [{ id: ok1.turn, status: "completed", completedAt: 1 }] },
    ),
  ]);
  const session = await openSession();
  const sessions = globalThis.ajour.process.session;
  const read = sessions.read.bind(sessions);
  // Ajour reports the exit with the program's last lines.
  sessions.read = async (id, options) => ({
    ...(await read(id, options)),
    exited: true,
  });
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("h1", ok1.thread, { state: "working", session, turn: ok1.turn }),
    ],
  });
  assert.equal(update.state, "ready");
  assert.equal(update.native.session, undefined);
  // No reader opened to read it again.
  assert.equal(sessionsOf().length, 1);
});

test("a question Codex asks under a method the plugin doesn't know is still for the user", async () => {
  const cases = [
    ["item/newTool/requestApproval", "Waiting for approval"],
    ["item/newTool/requestChoice", "Waiting for your answer"],
  ];
  for (const [method, label] of cases) {
    const log = [];
    fakeCodex([
      () => {
        const program = answering((m) =>
          m.method === "thread/read"
            ? {
                ...idleThread({ type: "active", activeFlags: [] }),
                lines: [
                  JSON.stringify({
                    id: 9,
                    method,
                    params: { threadId: ok1.thread },
                  }),
                ],
              }
            : { data: [{ id: ok1.turn, status: "inProgress" }] },
        )();
        return {
          receive(line) {
            log.push(line);
            return program.receive(line);
          },
        };
      },
    ]);
    const { update } = await readLiveOne();
    assert.equal(update.state, "needs-you", method);
    assert.equal(update.native.label, label, method);
    assert.ok(!messages(log).some((m) => m.id === 9), method);
  }
});

test("a refresh with no handoffs opens nothing", async () => {
  const { calls } = fakeCodex([]);
  assert.deepEqual(
    await readHandoffStates({ tool: "codex", handoffs: [] }),
    [],
  );
  assert.deepEqual(calls, []);
});

test("the recordings carry no home folder", () => {
  for (const name of [
    "start-ok",
    "read-ok",
    "start-bad",
    "read-bad",
    "start-cut",
    "read-cut",
    "approval",
    "read-gone-archived",
    "read-unrecorded",
  ])
    assert.ok(!/alext|AppData/.test(JSON.stringify(recorded(name))), name);
});

// Listing threads

// One recorded listing (fixtures/codex/list.jsonl): the app-server says the
// folder it runs in, then lists that folder's threads, renamed: one titled
// with two keys, two untitled ones whose first prompt line Codex shows, and
// one titled without a key.
const listedThreads = find("list", (m) => m.result?.readStates).result.data;
const OTHER = PATH.replace("repo", "other");
const listRequest = (extra = {}) => ({
  tool: "codex",
  folder: { id: FOLDER },
  limit: 50,
  ...extra,
});

/** A program answering a listing with `threads`, and reads with `read`. */
const listingProgram = (threads, read = () => undefined) =>
  answering((message) => {
    if (message.method === "initialize") return { result: {} };
    if (message.method === "hooks/list")
      return { data: [{ cwd: PATH, hooks: [], warnings: [], errors: [] }] };
    if (message.method === "thread/list")
      return { data: threads, nextCursor: null, readStates: {} };
    return read(message);
  });

test("a listing asks an app-server in the folder which folder it runs in, and lists that folder's threads newest first", async () => {
  const server = program("list");
  const { calls } = fakeCodex([server]);
  const { threads } = await listThreads(listRequest());
  assert.deepEqual(calls, [
    {
      argv: ["codex", "-C", PATH, "app-server"],
      mode: "session",
      cwd: PATH,
      session: true,
    },
  ]);
  const sent = messages(server.log);
  assert.deepEqual(
    sent.map((m) => m.method),
    ["initialize", "initialized", "hooks/list", "thread/list"],
  );
  // Codex filters by the exact folder it reported: the plugin never has it.
  assert.deepEqual(sent[3].params, {
    cwd: PATH,
    limit: 50,
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: ["cli", "vscode", "exec", "appServer"],
  });
  assert.deepEqual(
    threads.map((t) => [t.threadId, t.title, t.updatedAt]),
    [
      [
        listedThreads[0].id,
        "[PAY-12] [PAY-13] Share the session cookie",
        listedThreads[0].updatedAt * 1000,
      ],
      // An untitled thread shows its first prompt line, as the Codex app does.
      [
        listedThreads[1].id,
        "[PAY-12] Fix login redirect",
        listedThreads[1].updatedAt * 1000,
      ],
      [
        listedThreads[2].id,
        "Look at the flaky sync test.",
        listedThreads[2].updatedAt * 1000,
      ],
      [
        listedThreads[3].id,
        "Rename the settings page",
        listedThreads[3].updatedAt * 1000,
      ],
    ],
  );
  // What a start with the default Open answers: the app's link, the
  // terminal's resume, and the same native keys.
  const [first] = threads;
  assert.equal(first.link, `codex://threads/${first.threadId}`);
  assert.deepEqual(first.resume, {
    command: "codex-resume",
    args: { thread: first.threadId, folder: FOLDER },
  });
  assert.deepEqual(first.native, {
    state: "unknown",
    label: "Unknown",
    open: "app",
    status: "notLoaded",
  });
  for (const thread of threads)
    assert.ok(
      new TextEncoder().encode(JSON.stringify(thread.native)).length <= 4096,
    );
  // The listing lets go of its session, which frees one of the two.
  assert.equal(sessionsOf()[0].state, "closed");
});

test("a listing keeps only the folder's own top-level threads, each once", async () => {
  const [first, second, third, fourth] = listedThreads;
  fakeCodex([
    listingProgram([
      first,
      { ...second, cwd: OTHER },
      { ...third, parentThreadId: first.id },
      { ...fourth, ephemeral: true },
      first,
      { ...fourth, id: "not-a-uuid" },
      {
        ...fourth,
        id: "01a1a9cc-0000-7000-8000-000000000001",
        name: null,
        preview: "  ",
      },
    ]),
  ]);
  const { threads } = await listThreads(listRequest());
  assert.deepEqual(
    threads.map((t) => t.threadId),
    [first.id],
  );
});

for (const root of [
  "C:\\",
  "C:/",
  "C:",
  "/",
  "\\",
  "\\\\server\\share\\",
  "\\\\server\\share",
  "//server/share/",
])
  test(`a Codex that reports the root ${JSON.stringify(root)} as its folder lists nothing and throws`, async () => {
    const sent = [];
    const server = answering((message) => {
      sent.push(message.method);
      if (message.method === "initialize") return { result: {} };
      if (message.method === "hooks/list")
        return { data: [{ cwd: root, hooks: [], warnings: [], errors: [] }] };
      if (message.method === "thread/list")
        return { data: listedThreads, nextCursor: null, readStates: {} };
      return undefined;
    });
    fakeCodex([server]);
    await assert.rejects(listThreads(listRequest()), /can't list its threads/);
    assert.deepEqual(sent, ["initialize", "hooks/list"]);
    assert.equal(sessionsOf()[0].state, "closed");
  });

test("a listing passes limit to Codex and keeps the threads changed after since", async () => {
  const server = program("list");
  fakeCodex([server]);
  const since = listedThreads[1].updatedAt * 1000;
  const { threads } = await listThreads(listRequest({ since, limit: 3 }));
  assert.equal(messages(server.log)[3].params.limit, 3);
  assert.deepEqual(
    threads.map((t) => t.threadId),
    [listedThreads[0].id],
  );
});

test("listed threads refresh through readHandoffStates", async () => {
  const server = program("list");
  const reads = [];
  fakeCodex([
    server,
    listingProgram([], (message) => {
      reads.push(message.method);
      if (message.method === "thread/read")
        return {
          thread: {
            ...listedThreads.find((t) => t.id === message.params.threadId),
            status: { type: "notLoaded" },
          },
        };
      if (message.method === "thread/turns/list")
        return {
          data: [
            { id: "turn-1", status: "completed", completedAt: 1793850689 },
          ],
        };
      return undefined;
    }),
  ]);
  const { threads } = await listThreads(listRequest());
  const updates = await readHandoffStates({
    tool: "codex",
    handoffs: threads
      .slice(0, 2)
      .map((thread, i) => handoff(`h${i}`, thread.threadId, thread.native)),
  });
  assert.deepEqual(
    updates.map((u) => [u.id, u.state, u.native.label, u.native.open]),
    [
      ["h0", "ready", "Completed", "app"],
      ["h1", "ready", "Completed", "app"],
    ],
  );
  assert.deepEqual(reads, [
    "thread/read",
    "thread/turns/list",
    "thread/read",
    "thread/turns/list",
  ]);
});

test("a listing while two handoffs run says so", async () => {
  fakeCodex([refuse("session_limit")]);
  await assert.rejects(listThreads(listRequest()), (error) => {
    assert.equal(error.message, BUSY_LISTING);
    return true;
  });
});

test("a Codex that can't say its folder or list threads throws why, and closes its session", async () => {
  fakeCodex([
    answering((message) =>
      message.method === "initialize"
        ? { result: {} }
        : { error: { code: -32601, message: "Method not found" } },
    ),
  ]);
  await assert.rejects(listThreads(listRequest()), /can't list its threads/);
  assert.equal(sessionsOf()[0].state, "closed");
});

// Closing a thread (ajour#850): turn/interrupt for a turn the handoff's own
// session runs, then thread/archive. The reads are recorded; the answers to
// turn/interrupt and thread/archive aren't (codex-cli 0.170.0 has both
// methods, which answer {} as Codex's app-server documentation says), and no
// real thread was archived.
const closeCodex = (threadId, native) =>
  closeThread({ tool: "codex", handoff: handoff("h1", threadId, native) });
const methodsOf = (log) =>
  messages(log)
    .filter((m) => m.method && m.id !== undefined)
    .map((m) => m.method);

test("a close archives a thread no session holds through a new app-server, which it ends", async () => {
  // The second handoff's session ended, as when Ajour quits.
  for (const session of [undefined, "fake-session-99"]) {
    const reader = program("read-ok", {
      unrecorded: (m) => (m.method === "thread/archive" ? {} : undefined),
    });
    const { calls } = fakeCodex([reader]);
    assert.deepEqual(
      await closeCodex(ok1.thread, {
        state: "ready",
        turn: ok1.turn,
        ...(session ? { session } : {}),
      }),
      {},
    );
    assert.deepEqual(methodsOf(reader.log), [
      "initialize",
      "thread/read",
      "thread/turns/list",
      "thread/archive",
    ]);
    const archive = messages(reader.log).find(
      (m) => m.method === "thread/archive",
    );
    assert.deepEqual(archive.params, { threadId: ok1.thread });
    assert.equal(calls[0].cwd, PATH);
    assert.equal(sessionsOf()[0].state, "closed");
  }
});

/**
 * A program whose thread is active with the plugin's turn until Codex gets
 * turn/interrupt, then idle. `answers` overrides an answer by method.
 */
function runningThread(answers = {}) {
  let stopped = false;
  const log = [];
  const handler = answering((m) => {
    log.push(m);
    if (Object.hasOwn(answers, m.method)) return answers[m.method](m);
    if (m.method === "thread/read")
      return idleThread(
        stopped ? { type: "idle" } : { type: "active", activeFlags: [] },
      );
    if (m.method === "thread/turns/list")
      return {
        data: [
          { id: ok1.turn, status: stopped ? "interrupted" : "inProgress" },
        ],
      };
    if (m.method === "turn/interrupt") {
      stopped = true;
      return {};
    }
    if (m.method === "thread/archive") return {};
    return { error: { code: -32601, message: `unexpected ${m.method}` } };
  });
  return { log, handler };
}

test("a turn the handoff's own session runs is interrupted first, then the thread archived, and the session ends", async () => {
  const thread = runningThread();
  fakeCodex([thread.handler]);
  const session = await openSession();
  assert.deepEqual(
    await closeCodex(ok1.thread, {
      state: "working",
      session,
      turn: ok1.turn,
    }),
    {},
  );
  assert.deepEqual(
    thread.log.map((m) => m.method),
    [
      "thread/read",
      "thread/turns/list",
      "turn/interrupt",
      "thread/read",
      "thread/archive",
    ],
  );
  assert.deepEqual(thread.log[2].params, {
    threadId: ok1.thread,
    turnId: ok1.turn,
  });
  assert.equal(sessionsOf().length, 1);
  assert.equal(sessionsOf()[0].state, "closed");
});

test("a running turn the plugin didn't record is the last turn in progress, and one it can't name stays running", async () => {
  // A start that ran out of time before turn/start answered kept no turn.
  const thread = runningThread();
  fakeCodex([thread.handler]);
  const session = await openSession();
  assert.deepEqual(
    await closeCodex(ok1.thread, { state: "working", session }),
    {},
  );
  assert.equal(thread.log[2].params.turnId, ok1.turn);

  const unnamed = runningThread({
    "thread/turns/list": () => ({
      error: { code: -32603, message: "turns unavailable" },
    }),
  });
  fakeCodex([unnamed.handler]);
  const own = await openSession();
  await assert.rejects(
    closeCodex(ok1.thread, { state: "working", session: own }),
    {
      message: UNKNOWN_TURN,
    },
  );
  assert.ok(!unnamed.log.some((m) => m.method === "thread/archive"));
  // The turn still runs, so its session stays for the next refresh.
  assert.equal(sessionsOf()[0].state, "open");
});

test("a turn that ended before the interrupt, or still reads active 5 seconds after it, is archived all the same", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const thread = runningThread({
    "turn/interrupt": () => ({
      error: { code: -32600, message: "no active turn" },
    }),
  });
  fakeCodex([thread.handler]);
  const session = await openSession();
  const { value } = await settle(
    t,
    closeCodex(ok1.thread, { state: "working", session, turn: ok1.turn }),
  );
  assert.deepEqual(value, {});
  const reads = thread.log.filter((m) => m.method === "thread/read");
  // One read before the interrupt, then one every 250 ms for 5 seconds.
  assert.ok(reads.length >= 18 && reads.length <= 22, String(reads.length));
  assert.equal(thread.log.at(-1).method, "thread/archive");
});

test("Codex refusing to stop the turn keeps the thread and its session, with Codex's reason", async () => {
  const thread = runningThread({
    "turn/interrupt": () => ({
      error: { code: -32603, message: "interrupt failed: busy" },
    }),
  });
  fakeCodex([thread.handler]);
  const session = await openSession();
  await assert.rejects(
    closeCodex(ok1.thread, { state: "working", session, turn: ok1.turn }),
    { message: "Codex didn't stop the turn: interrupt failed: busy" },
  );
  assert.ok(!thread.log.some((m) => m.method === "thread/archive"));
  assert.equal(sessionsOf()[0].state, "open");
});

test("Codex refusing the archive throws its reason", async () => {
  const reader = program("read-ok", {
    unrecorded: (m) =>
      m.method === "thread/archive"
        ? {
            error: {
              code: -32603,
              message: "failed to archive thread: disk full",
            },
          }
        : undefined,
  });
  fakeCodex([reader]);
  await assert.rejects(closeCodex(ok1.thread, { state: "ready" }), {
    message:
      "Codex didn't archive the thread: failed to archive thread: disk full",
  });
  assert.equal(sessionsOf()[0].state, "closed");
});

test("a thread Codex deleted or archived already, or has no file for, counts as closed", async () => {
  for (const threadId of [gone, archived]) {
    const reader = program("read-gone-archived");
    fakeCodex([reader]);
    assert.deepEqual(await closeCodex(threadId, { state: "ready" }), {});
    assert.ok(!methodsOf(reader.log).includes("thread/archive"), threadId);
  }
  const reader = program("read-ok", {
    unrecorded: (m) =>
      m.method === "thread/archive"
        ? {
            error: {
              code: -32600,
              message: `no rollout found for thread id ${ok1.thread}`,
            },
          }
        : undefined,
  });
  fakeCodex([reader]);
  assert.deepEqual(await closeCodex(ok1.thread, { state: "ready" }), {});
});

test("a close while both sessions run handoffs says so", async () => {
  fakeCodex([refuse("session_limit")]);
  await assert.rejects(closeCodex(ok1.thread, { state: "ready" }), {
    message: BUSY_CLOSING,
  });
});

test("a Codex without thread/archive says to update the plugin", async () => {
  const reader = program("read-ok");
  fakeCodex([reader]);
  await assert.rejects(closeCodex(ok1.thread, { state: "ready" }), {
    message:
      "This Codex version can't archive threads the way Ajour asks. Check for an update of this plugin.",
  });
});
