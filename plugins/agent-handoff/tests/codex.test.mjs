// The Codex tool against JSON-RPC exchanges recorded from the real
// `codex app-server` (codex-cli 0.169.0 on Windows, see
// fixtures/codex/README.md), replayed through the SDK fake's process
// sessions after the fake broker expands the session command from
// plugin.json the way Ajour does.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { detectTools, readHandoffStates, startHandoff } from "../src/plugin.ts";
import {
  ELSEWHERE,
  GONE,
  NOT_RECORDED,
  RELEASED,
  STOPPED,
} from "../src/codex.ts";
import { find, recorded, replay } from "./codex-replay.mjs";
import {
  fakeBroker,
  flush,
  folders,
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

test("detects Codex from codex --version", async () => {
  fakeCodex();
  const { tools } = await detectTools();
  assert.deepEqual(tools.at(-1), {
    id: "codex",
    available: true,
    version: "0.169.0",
  });
});

test("a missing codex is unavailable with the reason", async () => {
  fakeCodex([], { run: refuse("executable_missing") });
  const { tools } = await detectTools();
  assert.deepEqual(tools.at(-1), {
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
  assert.deepEqual(sent[0].params, {
    clientInfo: { name: "ajour", title: "Ajour", version: "0.4.0" },
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
    },
  });
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
    session_limit:
      "Ajour keeps at most two Codex sessions running for this plugin, and both are busy with other handoffs. Hand off again once one of them is ready.",
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

test("a third session is refused while two handoffs run", async () => {
  fakeCodex([program("start-ok"), program("start-bad"), program("start-cut")]);
  await startHandoff(startRequest());
  await startHandoff(startRequest());
  await assert.rejects(startHandoff(startRequest()), {
    code: "session_limit",
  });
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

test("when no session can open to read, every state is kept with the reason", async () => {
  fakeCodex([refuse("session_limit")]);
  const [update] = await readHandoffStates({
    tool: "codex",
    handoffs: [
      handoff("h1", ok1.thread, { state: "ready", label: "Completed" }),
    ],
  });
  assert.equal(update.state, "ready");
  assert.equal(update.native.label, "Completed");
  assert.match(update.native.reason, /at most two Codex sessions/);
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
