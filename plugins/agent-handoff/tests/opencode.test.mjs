// The OpenCode tool against answers recorded from a real `opencode serve`
// (opencode-ai 1.19.5 on Windows, isolated XDG folders, see
// fixtures/opencode/README.md). The SDK's fake `ajour.http` answers each
// request from a route and refuses one plugin.json doesn't declare, and the
// fake broker expands `opencode` commands to argv the way Ajour does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { detectTools, readHandoffStates, startHandoff } from "../src/plugin.ts";
import { validateConnection } from "../src/plugin.ts";
import { STARTING_MS, versionProblem } from "../src/opencode.ts";
import {
  fakeBroker,
  flush,
  folders,
  ok,
  refuse,
  refused,
} from "./fake-broker.mjs";

const fixture = (name) =>
  readFileSync(new URL(`fixtures/opencode/${name}`, import.meta.url), "utf8");
const recorded = (name) => JSON.parse(fixture(name));

const SESSION = "ses_e1a30df5cffeXQGw0N6jzQJRpm";
const UNANSWERED = "ses_e1a2e407bffeSYDCx5cZUJvgBj";
const CHILD = "ses_e1a2f0c1affeChild0Sub4gentX";
const ADDRESS = "http://127.0.0.1:4096";
const FOLDER = "folder-1";
const PATH = "C:\\Users\\dev\\repos\\ajour";
const connection = {
  id: "opencode_1",
  pluginId: "agent-handoff",
  label: "OpenCode",
  tenantLabel: "This computer",
  autoSync: false,
  autoSyncIntervalMinutes: 15,
  connectedAt: 1794856000000,
  config: { serverUrl: ADDRESS },
  access: [],
};

const SERVER_DOWN =
  "OpenCode's server isn't answering at this connection's address. Start it in the repository folder with opencode serve --hostname 127.0.0.1 --port 4096, or check the address.";
const NEEDS_CONNECTION =
  "OpenCode needs a connection to its server. Add one on this plugin's page, and pick it in OpenCode's settings.";
const late = /OpenCode took too long; refreshing again later/;
// `time.updated` in the recorded session.json.
const UPDATED = 1794856926529;

afterEach(() => {
  delete globalThis.ajour;
  for (const id of Object.keys(folders)) delete folders[id];
});

/** Rejects as the credential broker does when it can't send a request. */
const requestError = (code, message = `Request ${code}.`) =>
  Object.assign(new Error(message), { name: "AjourRequestError", code });

const answer = (json, status = 200) => ({ status, json });
const noContent = { status: 204, body: "" };

/** OpenCode's recorded answers, by method and path, which a test overrides. */
function server(overrides = {}) {
  const base = {
    "GET /global/health": answer(recorded("health.json")),
    "POST /session": answer(recorded("session-created.json")),
    [`POST /session/${SESSION}/prompt_async`]: noContent,
    "GET /session/status": answer(recorded("status-idle.json")),
    "GET /permission": answer(recorded("permissions-none.json")),
    "GET /question": answer(recorded("questions-none.json")),
    [`GET /session/${SESSION}`]: answer(recorded("session.json")),
    [`GET /session/${SESSION}/message`]: answer(
      recorded("messages-answered.json"),
    ),
    [`DELETE /session/${SESSION}`]: answer(true),
    ...overrides,
  };
  return Object.entries(base).map(([key, respond]) => {
    const [method, path] = key.split(" ");
    return { method, path, respond };
  });
}

/**
 * Installs a fake Ajour with OpenCode's server at the connection's address
 * and an `opencode` CLI. Returns the process calls; `ajour.requests` holds
 * the HTTP ones.
 */
function fakeOpenCode(overrides = {}, cli = () => ok(fixture("version.txt"))) {
  folders[FOLDER] = PATH;
  return fakeBroker(
    (argv, call) => {
      // Detection without a connection asks the other tools.
      if (argv[0] !== "opencode") throw refused("executable_missing");
      return cli(argv, call);
    },
    { routes: server(overrides), connectionUrl: ADDRESS },
  );
}

const requests = () =>
  globalThis.ajour.requests.map((r) => `${r.method} ${r.path}`);

const startRequest = (settings = {}, extra = {}) => ({
  tool: "opencode",
  folder: { id: FOLDER, name: "ajour" },
  prompt:
    "Work on AJ-42: hand off to OpenCode\nhttps://example.com/AJ-42\n\n- Start it.\n- Reopen it.\n",
  title: "AJ-42 Hand off\nto OpenCode",
  branch: "aj-42-opencode",
  item: { key: "AJ-42", url: "https://example.com/AJ-42" },
  settings,
  ...extra,
});

const handoff = (id, native = { state: "working" }, threadId = SESSION) => ({
  id,
  threadId,
  folderId: FOLDER,
  native,
});

const read = (...handoffs) =>
  readHandoffStates(connection, { tool: "opencode", handoffs });

/** The recorded unanswered prompt, sent `ago` milliseconds before now. */
const unanswered = (ago) => {
  const messages = recorded("messages-unanswered.json");
  messages[0].info.time.created = Date.now() - ago;
  return answer(messages);
};

// Detection

test("detection through a connection reads the server's version and runs opencode --version", async () => {
  const calls = fakeOpenCode();
  assert.deepEqual(await detectTools(connection), {
    tools: [{ id: "opencode", available: true, version: "1.19.5" }],
  });
  assert.deepEqual(requests(), ["GET /global/health"]);
  assert.equal(globalThis.ajour.requests[0].connectionId, "opencode_1");
  assert.deepEqual(
    calls.map((c) => [c.argv, c.mode]),
    [[["opencode", "--version"], "capture"]],
  );
});

test("detection without a connection asks only the other tools", async () => {
  const calls = fakeOpenCode();
  const { tools } = await detectTools();
  assert.deepEqual(
    tools.map((tool) => tool.id),
    ["t3", "claude", "copilot"],
  );
  assert.deepEqual(requests(), []);
  assert.ok(calls.every((c) => c.argv[0] !== "opencode"));
});

test("detection says the server isn't answering when nothing listens at the address", async () => {
  fakeOpenCode({
    "GET /global/health": () => {
      throw requestError("network", "connect ECONNREFUSED 127.0.0.1:4096");
    },
  });
  assert.deepEqual((await detectTools(connection)).tools, [
    { id: "opencode", available: false, reason: SERVER_DOWN },
  ]);
});

test("detection refuses a server older than 1.19.5 or a 2.x one", async () => {
  for (const [version, reason] of [
    [
      "1.19.4",
      "OpenCode 1.19.4 is older than 1.19.5, the first version Ajour supports. Run opencode upgrade, then restart opencode serve.",
    ],
    [
      "2.0.0",
      "OpenCode 2.0.0 isn't supported yet. Ajour hands off to OpenCode 1.19.5 or a later 1.x version.",
    ],
  ]) {
    fakeOpenCode({
      "GET /global/health": answer({ healthy: true, version }),
    });
    assert.deepEqual((await detectTools(connection)).tools, [
      { id: "opencode", available: false, reason },
    ]);
  }
});

test("detection says the address isn't OpenCode when the health check isn't OpenCode's", async () => {
  const reason =
    "The server at this connection's address doesn't answer like OpenCode. Check the address, and that opencode serve runs there.";
  for (const health of [
    answer({ error: "Not Found" }, 404),
    { status: 200, body: "<html>Vite</html>" },
    answer({ healthy: true }),
  ]) {
    fakeOpenCode({ "GET /global/health": health });
    assert.deepEqual((await detectTools(connection)).tools, [
      { id: "opencode", available: false, reason },
    ]);
  }
});

test("detection says a connection that isn't on-premises can't reach the loopback server", async () => {
  fakeOpenCode({
    "GET /global/health": () => {
      throw requestError(
        "refused",
        "The service's address is on this computer or a private network. Mark the connection as on-premises to reach it.",
      );
    },
  });
  const [tool] = (await detectTools(connection)).tools;
  assert.equal(
    tool.reason,
    "Ajour refused the request to OpenCode's server. The service's address is on this computer or a private network. Mark the connection as on-premises to reach it.",
  );
});

test("detection says the opencode command is missing even when the server answers", async () => {
  fakeOpenCode({}, refuse("executable_missing"));
  assert.deepEqual((await detectTools(connection)).tools, [
    {
      id: "opencode",
      available: false,
      reason:
        "OpenCode isn't installed, or its opencode command isn't on PATH.",
    },
  ]);
});

test("a server that asks for a password is explained", async () => {
  fakeOpenCode({ "GET /global/health": answer({}, 401) });
  const [tool] = (await detectTools(connection)).tools;
  assert.equal(
    tool.reason,
    "OpenCode's server asks for a password. Ajour reaches a server without one: start opencode serve on 127.0.0.1 without OPENCODE_SERVER_PASSWORD.",
  );
});

test("saving a connection checks the server is OpenCode", async () => {
  fakeOpenCode();
  assert.deepEqual(await validateConnection(connection), {
    normalizedConfig: { serverUrl: ADDRESS },
    connectionSummary: { Server: "OpenCode 1.19.5" },
  });
  fakeOpenCode({
    "GET /global/health": () => {
      throw requestError("network");
    },
  });
  await assert.rejects(validateConnection(connection), {
    message: SERVER_DOWN,
  });
});

test("versions read as the plugin supports them", () => {
  assert.equal(versionProblem("1.19.5"), undefined);
  assert.equal(versionProblem("1.20.0"), undefined);
  assert.equal(versionProblem("1.19.6-beta.1"), undefined);
  assert.match(versionProblem("1.2.30"), /older than 1.19.5/);
  assert.match(versionProblem("0.99.0"), /older than 1.19.5/);
  assert.match(versionProblem("local"), /can't read: local/);
});

// Start

test("a start checks the server, creates a titled session and sends the prompt in the body", async () => {
  const calls = fakeOpenCode();
  const result = await startHandoff(connection, startRequest());
  assert.deepEqual(result, {
    threadId: SESSION,
    resume: {
      command: "opencode-attach",
      args: { session: SESSION, folder: FOLDER },
    },
    native: { state: "working", label: "Started" },
  });
  assert.deepEqual(requests(), [
    "GET /global/health",
    "POST /session",
    `POST /session/${SESSION}/prompt_async`,
  ]);
  const [, create, prompt] = globalThis.ajour.requests;
  assert.deepEqual(JSON.parse(create.bodyText), {
    title: "AJ-42 Hand off to OpenCode",
  });
  assert.equal(create.headers["content-type"], "application/json");
  // The prompt goes whole, line breaks included, and never on a command line.
  assert.deepEqual(JSON.parse(prompt.bodyText), {
    parts: [{ type: "text", text: startRequest().prompt }],
  });
  assert.deepEqual(calls, []);
});

test("Open attaches to the same server: Ajour fills the address, the plugin passes the session", async () => {
  const calls = fakeOpenCode();
  const { resume } = await startHandoff(connection, startRequest());
  await globalThis.ajour.process.run(resume);
  assert.deepEqual(calls, [
    {
      argv: ["opencode", "attach", ADDRESS, "-s", SESSION, "--dir", PATH],
      mode: "terminal",
      cwd: PATH,
      stdin: undefined,
    },
  ]);
  // The plugin can't name the address, and Ajour refuses the slot without a connection.
  await assert.rejects(
    globalThis.ajour.process.run({
      command: "opencode-attach",
      args: { ...resume.args, server: "http://evil.test" },
    }),
    { code: "invalid_request" },
  );
  fakeBroker(() => undefined);
  await assert.rejects(globalThis.ajour.process.run(resume), {
    code: "connection_refused",
  });
});

test("a start passes the model and agent settings", async () => {
  fakeOpenCode();
  await startHandoff(
    connection,
    startRequest({
      model: " openrouter/anthropic/claude-sonnet-4.5 ",
      agent: "plan",
    }),
  );
  const prompt = globalThis.ajour.requests.at(-1);
  assert.deepEqual(JSON.parse(prompt.bodyText), {
    model: {
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-4.5",
    },
    agent: "plan",
    parts: [{ type: "text", text: startRequest().prompt }],
  });
});

test("a start refuses a model without a provider before it reaches the server", async () => {
  fakeOpenCode();
  for (const model of ["claude-sonnet-4-5", "/model", "anthropic/"])
    await assert.rejects(startHandoff(connection, startRequest({ model })), {
      message:
        "Write OpenCode's model as provider/model, such as anthropic/claude-sonnet-4-5.",
    });
  assert.deepEqual(requests(), []);
});

test("a start without a connection says to pick one", async () => {
  fakeOpenCode();
  await assert.rejects(startHandoff(startRequest()), {
    message: NEEDS_CONNECTION,
  });
  assert.deepEqual(requests(), []);
});

test("a start with the server down creates nothing", async () => {
  fakeOpenCode({
    "GET /global/health": () => {
      throw requestError("network");
    },
  });
  await assert.rejects(startHandoff(connection, startRequest()), {
    message: SERVER_DOWN,
  });
  assert.deepEqual(requests(), ["GET /global/health"]);
});

test("a start refuses a server of the wrong version before creating a session", async () => {
  fakeOpenCode({
    "GET /global/health": answer({ healthy: true, version: "1.4.0" }),
  });
  await assert.rejects(startHandoff(connection, startRequest()), {
    message:
      "OpenCode 1.4.0 is older than 1.19.5, the first version Ajour supports. Run opencode upgrade, then restart opencode serve.",
  });
  assert.deepEqual(requests(), ["GET /global/health"]);
});

test("a server without the v1 session API is refused by name", async () => {
  fakeOpenCode({ "POST /session": answer({ error: "Not Found" }, 404) });
  await assert.rejects(startHandoff(connection, startRequest()), {
    message:
      "This OpenCode server doesn't have the API Ajour uses. Ajour hands off to OpenCode 1.19.5 or a later 1.x version.",
  });
});

test("a prompt OpenCode refuses removes the empty session", async () => {
  fakeOpenCode({
    [`POST /session/${SESSION}/prompt_async`]: answer(
      { name: "UnknownError", data: { message: 'Agent not found: "review"' } },
      400,
    ),
  });
  await assert.rejects(
    startHandoff(connection, startRequest({ agent: "review" })),
    {
      message:
        "OpenCode didn't take the prompt. OpenCode's server answered HTTP 400: Agent not found: \"review\"",
    },
  );
  assert.deepEqual(requests().slice(-1), [`DELETE /session/${SESSION}`]);
});

test("a 404 on the session's prompt route is OpenCode's answer, not a missing API", async () => {
  fakeOpenCode({
    [`POST /session/${SESSION}/prompt_async`]: answer(
      { name: "NotFoundError", data: { message: "Session not found" } },
      404,
    ),
  });
  await assert.rejects(startHandoff(connection, startRequest()), {
    message:
      "OpenCode didn't take the prompt. OpenCode's server answered HTTP 404: Session not found",
  });
});

test("a prompt that times out may have been taken, so the session stays", async () => {
  fakeOpenCode({
    [`POST /session/${SESSION}/prompt_async`]: () => {
      throw requestError("timeout");
    },
  });
  await assert.rejects(startHandoff(connection, startRequest()), {
    message:
      'OpenCode may have taken the prompt: check the session "AJ-42 Hand off to OpenCode" in OpenCode before handing off again.',
  });
  assert.ok(!requests().some((r) => r.startsWith("DELETE")));
});

test("a session id Ajour can't use as an id is refused", async () => {
  fakeOpenCode({
    "POST /session": answer({
      ...recorded("session-created.json"),
      id: "../x",
    }),
  });
  await assert.rejects(startHandoff(connection, startRequest()), {
    message: "OpenCode created a session without an id Ajour can read.",
  });
});

// Refresh

test("a refresh reads status, permissions and questions once for every session", async () => {
  const other = "ses_e1a2f9d00ffeAnotherBusyOne";
  fakeOpenCode({
    "GET /session/status": answer({
      ...recorded("status-busy.json"),
      [other]: { type: "busy" },
    }),
  });
  const updates = await read(
    handoff("h1"),
    handoff("h2", { state: "needs-you" }, other),
  );
  assert.deepEqual(
    updates.map((u) => [u.id, u.state, u.native]),
    [
      ["h1", "working", { state: "working", label: "Working", status: "busy" }],
      ["h2", "working", { state: "working", label: "Working", status: "busy" }],
    ],
  );
  assert.deepEqual(requests(), [
    "GET /session/status",
    "GET /permission",
    "GET /question",
  ]);
});

test("a session that stopped after answering is ready for review", async () => {
  fakeOpenCode();
  const [update] = await read(handoff("h1"));
  assert.equal(update.state, "ready");
  assert.deepEqual(update.native, {
    state: "ready",
    label: "Ready for review",
    status: "absent",
    updated: UPDATED,
  });
  assert.deepEqual(requests().slice(3), [
    `GET /session/${SESSION}`,
    `GET /session/${SESSION}/message`,
  ]);
  assert.deepEqual(globalThis.ajour.requests.at(-1).query, { limit: 1 });
});

test("a session read as stopped before, and unchanged since, is only checked to still exist", async () => {
  fakeOpenCode();
  const [update] = await read(
    handoff("h1", {
      state: "ready",
      label: "Stopped",
      status: "idle",
      updated: UPDATED,
    }),
  );
  assert.deepEqual(
    [update.state, update.native],
    [
      "ready",
      { state: "ready", label: "Stopped", status: "absent", updated: UPDATED },
    ],
  );
  assert.deepEqual(requests().slice(3), [`GET /session/${SESSION}`]);
});

test("a failed handoff whose session answered a later turn becomes ready", async () => {
  fakeOpenCode();
  const [update] = await read(
    handoff("h1", {
      state: "failed",
      label: "Failed",
      status: "idle",
      error: "APIError",
      reason: "APIError: Your credit balance is too low.",
      updated: UPDATED - 60_000,
    }),
  );
  assert.deepEqual(
    [update.state, update.native],
    [
      "ready",
      {
        state: "ready",
        label: "Ready for review",
        status: "absent",
        updated: UPDATED,
      },
    ],
  );
  assert.deepEqual(requests().slice(3), [
    `GET /session/${SESSION}`,
    `GET /session/${SESSION}/message`,
  ]);
});

test("a ready handoff whose session failed a later turn becomes failed", async () => {
  fakeOpenCode({
    [`GET /session/${SESSION}/message`]: answer(
      recorded("schema/messages-error.json"),
    ),
  });
  // A handoff saved before the plugin kept time.updated reads its messages too.
  for (const native of [
    { state: "ready", label: "Stopped", updated: UPDATED - 1 },
    { state: "ready", label: "Ready for review" },
  ]) {
    const [update] = await read(handoff("h1", native));
    assert.equal(update.state, "failed");
    assert.equal(update.native.error, "APIError");
    assert.equal(update.native.updated, UPDATED);
  }
});

test("a retrying session is working, with OpenCode's reason", async () => {
  fakeOpenCode({
    "GET /session/status": answer(recorded("schema/status-retry.json")),
  });
  const [update] = await read(handoff("h1"));
  assert.deepEqual(
    [update.state, update.native],
    [
      "working",
      {
        state: "working",
        label: "Retrying",
        status: "retry",
        attempt: 2,
        reason: "Rate limited. Retrying in 8 seconds.",
      },
    ],
  );
});

test("pending permissions and questions wait for you, a subagent's on its parent's handoff", async () => {
  fakeOpenCode({
    "GET /session/status": answer(recorded("status-busy.json")),
    "GET /permission": answer(recorded("schema/permissions-pending.json")),
    "GET /question": answer(recorded("schema/questions-pending.json")),
    [`GET /session/${CHILD}`]: answer(recorded("schema/session-child.json")),
  });
  const updates = await read(
    handoff("h1"),
    handoff("h2", { state: "working" }, UNANSWERED),
  );
  assert.deepEqual(
    updates.map((u) => [u.id, u.state, u.native]),
    [
      [
        "h1",
        "needs-you",
        {
          state: "needs-you",
          label: "Asks for permission",
          status: "busy",
          permissions: 1,
          questions: 0,
        },
      ],
      [
        "h2",
        "needs-you",
        {
          state: "needs-you",
          label: "Asks for permission",
          status: "absent",
          permissions: 1,
          questions: 1,
        },
      ],
    ],
  );
  // Only the subagent's session, which isn't a handoff, is read.
  assert.deepEqual(requests().slice(3), [`GET /session/${CHILD}`]);
});

test("a question alone is labeled as one", async () => {
  fakeOpenCode({
    "GET /question": answer(recorded("schema/questions-pending.json")),
  });
  const [update] = await read(handoff("h2", { state: "working" }, UNANSWERED));
  assert.equal(update.state, "needs-you");
  assert.equal(update.native.label, "Asks a question");
});

test("a session that stopped without answering failed, once the start has had time", async () => {
  fakeOpenCode({
    [`GET /session/${UNANSWERED}`]: answer(recorded("session.json")),
    [`GET /session/${UNANSWERED}/message`]: unanswered(STARTING_MS + 1000),
  });
  const [update] = await read(handoff("h1", undefined, UNANSWERED));
  assert.deepEqual(
    [update.state, update.native],
    [
      "failed",
      {
        state: "failed",
        label: "Failed",
        status: "absent",
        reason:
          "OpenCode stopped without answering. Open the session to see why, such as a model it can't reach.",
        updated: UPDATED,
      },
    ],
  );
});

test("a prompt just sent is starting, before OpenCode marks the session busy", async () => {
  // Recorded: right after prompt_async, /session/status was still {}, so for
  // a moment OpenCode hasn't marked the session busy yet.
  fakeOpenCode({
    [`GET /session/${UNANSWERED}`]: answer(recorded("session.json")),
    [`GET /session/${UNANSWERED}/message`]: unanswered(1000),
  });
  const [update] = await read(handoff("h1", undefined, UNANSWERED));
  assert.equal(update.state, "working");
  assert.equal(update.native.label, "Starting");
});

test("a session that stopped on an error failed with OpenCode's reason, and one you stopped is ready", async () => {
  fakeOpenCode({
    [`GET /session/${SESSION}/message`]: answer(
      recorded("schema/messages-error.json"),
    ),
  });
  const [failed] = await read(handoff("h1"));
  assert.deepEqual(
    [failed.state, failed.native],
    [
      "failed",
      {
        state: "failed",
        label: "Failed",
        status: "absent",
        error: "APIError",
        reason:
          "APIError: Your credit balance is too low to access the Anthropic API.",
        updated: UPDATED,
      },
    ],
  );
  // A failed session keeps its reason while it stays stopped and unchanged.
  const [kept] = await read(handoff("h1", failed.native));
  assert.deepEqual([kept.state, kept.native], [failed.state, failed.native]);
  assert.equal(
    requests().filter((r) => r.endsWith("/message")).length,
    1,
    "the unchanged session's messages aren't read again",
  );

  fakeOpenCode({
    [`GET /session/${SESSION}/message`]: answer(
      recorded("schema/messages-aborted.json"),
    ),
  });
  const [stopped] = await read(handoff("h1", { state: "needs-you" }));
  assert.equal(stopped.state, "ready");
  assert.equal(stopped.native.label, "Stopped");
});

test("only OpenCode answering 404 for the session makes it gone from this server", async () => {
  fakeOpenCode({
    [`GET /session/${SESSION}`]: answer(
      recorded("session-not-found.json"),
      404,
    ),
  });
  const [update] = await read(handoff("h1", { state: "ready" }));
  assert.deepEqual(
    [update.state, update.native],
    [
      "gone",
      { state: "gone", label: "Not on this OpenCode server", status: "absent" },
    ],
  );
});

test("a server that is down leaves every session unknown, never gone", async () => {
  fakeOpenCode({
    "GET /session/status": () => {
      throw requestError("network");
    },
  });
  const updates = await read(
    handoff("h1", { state: "ready", status: "idle" }),
    handoff("h2", { state: "needs-you" }, UNANSWERED),
  );
  assert.deepEqual(
    updates.map((u) => [u.id, u.state, u.native]),
    [
      [
        "h1",
        "unknown",
        {
          state: "ready",
          status: "idle",
          label: "Unknown",
          reason: SERVER_DOWN,
        },
      ],
      [
        "h2",
        "unknown",
        { state: "needs-you", label: "Unknown", reason: SERVER_DOWN },
      ],
    ],
  );
});

test("a refresh without a connection says to pick one", async () => {
  fakeOpenCode();
  const [update] = await readHandoffStates({
    tool: "opencode",
    handoffs: [handoff("h1", { state: "ready" })],
  });
  assert.deepEqual(
    [update.state, update.native],
    ["unknown", { state: "ready", label: "Unknown", reason: NEEDS_CONNECTION }],
  );
  assert.deepEqual(requests(), []);
});

test("a server without the v1 status route is refused by name, and a password is explained", async () => {
  fakeOpenCode({ "GET /session/status": answer({}, 404) });
  const [missing] = await read(handoff("h1"));
  assert.equal(missing.state, "unknown");
  assert.match(missing.native.reason, /doesn't have the API Ajour uses/);

  fakeOpenCode({ "GET /permission": answer({}, 401) });
  const [locked] = await read(handoff("h1"));
  assert.match(locked.native.reason, /asks for a password/);
});

test("a refresh stops waiting at its deadline and keeps the sessions it couldn't read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const never = () => new Promise(() => {});
  fakeOpenCode({
    "GET /session/status": answer({}),
    [`GET /session/${SESSION}`]: never,
  });
  const pending = read(handoff("h1", { state: "ready", status: "idle" }));
  await flush();
  t.mock.timers.tick(19_999);
  await flush();
  t.mock.timers.tick(1);
  const [update] = await pending;
  assert.equal(update.state, "ready");
  assert.match(update.native.reason, late);

  fakeOpenCode({ "GET /session/status": never });
  const listing = read(handoff("h1", { state: "needs-you" }));
  await flush();
  t.mock.timers.tick(20_000);
  const [kept] = await listing;
  assert.equal(kept.state, "needs-you");
  assert.match(kept.native.reason, late);
});

test("a broker timeout keeps every state, as the refresh deadline does", async () => {
  fakeOpenCode({
    "GET /question": () => {
      throw requestError("timeout");
    },
  });
  const [update] = await read(handoff("h1", { state: "working" }));
  assert.equal(update.state, "working");
  assert.match(update.native.reason, late);
});

// The broker's own messages for its limits (apps/api/src/broker-limits.ts and
// credential-broker.ts in Ajour). The plugin sees the code and the message.
const RATE_LIMITED =
  "The plugin sent too many requests. Try again in a moment.";
const TOO_MANY_QUEUED = "The plugin sent too many requests at once.";
const RESPONSE_TOO_LARGE = "The service's answer is larger than 8 MB.";
const UNCHECKED_RESPONSE =
  "The service's answer couldn't be checked for secrets, so it was dropped.";

test("a broker limit keeps every state, as the refresh deadline does", async () => {
  fakeOpenCode({
    "GET /session/status": () => {
      throw requestError("limit", RATE_LIMITED);
    },
  });
  const [update] = await read(
    handoff("h1", { state: "ready", label: "Stopped", status: "idle" }),
  );
  assert.deepEqual(
    [update.state, update.native],
    [
      "ready",
      {
        state: "ready",
        status: "idle",
        reason:
          "Ajour is limiting this plugin's requests to OpenCode. Try again in a minute.",
      },
    ],
  );

  // The same when the limit comes on one session's read.
  fakeOpenCode({
    [`GET /session/${SESSION}`]: () => {
      throw requestError("limit", TOO_MANY_QUEUED);
    },
  });
  const [read2] = await read(handoff("h1", { state: "failed" }));
  assert.equal(read2.state, "failed");
  assert.match(read2.native.reason, /limiting this plugin's requests/);
});

test("an answer too large for the broker makes a session unknown with the broker's reason, not a retry", async () => {
  for (const message of [RESPONSE_TOO_LARGE, UNCHECKED_RESPONSE]) {
    fakeOpenCode({
      [`GET /session/${SESSION}/message`]: () => {
        throw requestError("limit", message);
      },
    });
    const [update] = await read(
      handoff("h1", { state: "ready", status: "idle", updated: UPDATED - 1 }),
    );
    assert.deepEqual(
      [update.state, update.native],
      [
        "unknown",
        {
          state: "ready",
          status: "idle",
          label: "Unknown",
          reason: `Ajour refused the request to OpenCode's server. ${message}`,
        },
      ],
    );
  }

  // On the shared status read, every handoff is unknown for that reason.
  fakeOpenCode({
    "GET /session/status": () => {
      throw requestError("limit", RESPONSE_TOO_LARGE);
    },
  });
  const [listed] = await read(handoff("h1", { state: "working" }));
  assert.equal(listed.state, "unknown");
  assert.match(listed.native.reason, /larger than 8 MB/);
});

test("after a refused refresh, the next read takes the session's own reason back", async () => {
  const failedHandoff = {
    state: "failed",
    label: "Failed",
    status: "idle",
    error: "APIError",
    reason:
      "APIError: Your credit balance is too low to access the Anthropic API.",
    updated: UPDATED,
  };
  for (const message of [RATE_LIMITED, RESPONSE_TOO_LARGE]) {
    fakeOpenCode({
      [`GET /session/${SESSION}`]: () => {
        throw requestError("limit", message);
      },
    });
    const [refused] = await read(handoff("h1", failedHandoff));
    assert.notEqual(refused.native.reason, failedHandoff.reason);

    // The session hasn't changed, but its last message is read again.
    fakeOpenCode({
      [`GET /session/${SESSION}/message`]: answer(
        recorded("schema/messages-error.json"),
      ),
    });
    const [recovered] = await read(handoff("h1", refused.native));
    assert.deepEqual(
      [recovered.state, recovered.native],
      [
        "failed",
        {
          state: "failed",
          label: "Failed",
          status: "absent",
          updated: UPDATED,
          error: "APIError",
          reason: failedHandoff.reason,
        },
      ],
    );
    // And a later read keeps it without reading the message.
    const [kept] = await read(handoff("h1", recovered.native));
    assert.deepEqual(kept.native, recovered.native);
  }
});

test("a handoff whose session id isn't OpenCode's is unknown, and never goes in a path", async () => {
  fakeOpenCode();
  const [update] = await read(
    handoff("h1", { state: "ready" }, "../global/health"),
  );
  assert.equal(update.state, "unknown");
  assert.equal(
    update.native.reason,
    "This handoff's OpenCode session id isn't one Ajour can read.",
  );
  assert.deepEqual(requests(), [
    "GET /session/status",
    "GET /permission",
    "GET /question",
  ]);
});
