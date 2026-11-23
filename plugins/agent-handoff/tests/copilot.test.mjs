// The Copilot CLI tool against outputs recorded from the real copilot CLI
// (1.0.112 on Windows, see fixtures/copilot/version.txt) with an isolated
// COPILOT_HOME, signed out, in a throwaway repository. A fake copilot answers
// each declared command, after the fake broker expands it to argv from
// plugin.json the way Ajour does. The stdin fixtures come from the same
// copilot with its own COPILOT_HOME, against a local model through its BYOK
// variables, so without signing in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import {
  closeThread,
  detectTools,
  listThreads,
  readHandoffStates,
  startHandoff,
} from "../src/plugin.ts";
import {
  fakeBroker,
  flush,
  folders,
  manifest,
  ok,
  refuse,
  refused,
} from "./fake-broker.mjs";

const read = (name) =>
  readFileSync(new URL(`fixtures/copilot/${name}`, import.meta.url), "utf8");

const version = read("version.txt");
const help = read("help.txt");
const FOLDER = "folder-1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NO_STATE = "Copilot CLI doesn't report a session's state.";

afterEach(() => {
  delete globalThis.ajour;
  for (const id of Object.keys(folders)) delete folders[id];
});

/** Installs a fake copilot. `answer` gets argv and returns a result. */
function fakeCopilot(answer = () => undefined) {
  return fakeBroker((argv, call) => {
    // Detection asks every tool; these tests have only copilot.
    if (argv[0] !== "copilot") throw refused("executable_missing");
    return answer(argv, call);
  });
}

const startRequest = (settings = {}, extra = {}) => ({
  tool: "copilot",
  folder: { id: FOLDER, name: "ajour" },
  prompt:
    "Work on AJ-42: hand off to Copilot CLI\nhttps://example.com/AJ-42\n\n  - Start it.\r\n- Reopen it.\n",
  title: "AJ-42 Hand off to Copilot CLI",
  branch: "aj-42-copilot",
  item: { key: "AJ-42", url: "https://example.com/AJ-42" },
  settings,
  ...extra,
});

const handoff = (id, native = { state: "working" }) => ({
  id,
  threadId: "4920efe0-a33d-4eb7-9d21-661dd49a265d",
  folderId: FOLDER,
  native,
});

// Detection answers each tool once, in the manifest's order.
const copilotOf = (tools) => tools.find((tool) => tool.id === "copilot");

test("detection returns the recorded version", async () => {
  const calls = fakeCopilot(() => ok(version));
  const { tools } = await detectTools();
  assert.deepEqual(copilotOf(tools), {
    id: "copilot",
    available: true,
    version: "1.0.112",
  });
  assert.deepEqual(
    calls.filter((c) => c.argv[0] === "copilot").map((c) => c.argv),
    [["copilot", "--version"]],
  );
});

test("detection says Copilot CLI isn't installed when copilot is missing", async () => {
  fakeCopilot(refuse("executable_missing"));
  const { tools } = await detectTools();
  assert.deepEqual(
    tools.map((tool) => [tool.id, tool.available]),
    [
      ["t3", false],
      ["claude", false],
      ["claude-desktop", false],
      ["copilot", false],
      ["opencode", false],
      ["codex", false],
      ["vscode", false],
    ],
  );
  assert.equal(
    copilotOf(tools).reason,
    "Copilot CLI isn't installed, or its copilot command isn't on PATH.",
  );
});

test("detection keeps an unexpected version line as it is", async () => {
  fakeCopilot(() => ok("1.1.0\n"));
  const { tools } = await detectTools();
  assert.equal(copilotOf(tools).version, "1.1.0");
});

test("a start chooses the session id and runs copilot detached in the folder, the prompt on stdin", async () => {
  folders[FOLDER] = "C:\\Users\\me\\probe";
  const calls = fakeCopilot();
  const result = await startHandoff(startRequest());
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.match(result.threadId, UUID);
  assert.deepEqual(call, {
    argv: [
      "copilot",
      "-C",
      "C:\\Users\\me\\probe",
      "--session-id",
      result.threadId,
      "-n",
      "AJ-42 Hand off to Copilot CLI",
    ],
    mode: "detached",
    cwd: "C:\\Users\\me\\probe",
    stdin: startRequest().prompt,
  });
  assert.deepEqual(result, {
    threadId: result.threadId,
    resume: {
      command: "copilot-resume",
      args: { session: result.threadId, folder: FOLDER },
    },
    // No state: Ajour shows the handoff as Started and never reads it again.
    native: { label: "Started", tools: "ask" },
  });
});

test("the prompt never reaches the command line, and keeps its line breaks", async () => {
  const calls = fakeCopilot();
  const prompt =
    "[AJ-42] Hand off\n\n  - Start it.\r\n- Reopen it.\n\n" +
    "line\n".repeat(5000);
  await startHandoff(startRequest({ tools: "allow" }, { prompt }));
  const [call] = calls;
  assert.equal(call.stdin, prompt);
  assert.ok(!call.argv.includes("-p"));
  assert.ok(
    call.argv.every((value) => !/Start it|Reopen it|\n/.test(value)),
    call.argv.join(" "),
  );
});

test("each start gets its own session id", async () => {
  fakeCopilot();
  const first = await startHandoff(startRequest());
  const second = await startHandoff(startRequest());
  assert.notEqual(first.threadId, second.threadId);
});

test("a start passes the model, the title on one line, and allows all tools when set", async () => {
  const calls = fakeCopilot();
  const result = await startHandoff(
    startRequest(
      { model: " gpt-5.6-sol ", tools: "allow" },
      { title: "- AJ-42\tHand off\r\n\nto  Copilot CLI \n" },
    ),
  );
  assert.deepEqual(calls[0].argv.slice(0, 9), [
    "copilot",
    "-C",
    FOLDER,
    "--session-id",
    result.threadId,
    "-n",
    "AJ-42 Hand off to Copilot CLI",
    "--model",
    "gpt-5.6-sol",
  ]);
  assert.deepEqual(calls[0].argv.slice(9), ["--allow-all-tools"]);
  assert.equal(result.native.tools, "allow");
});

// Copilot CLI 1.0.109 exits with "Session name must be 100 characters or
// less." Its start is detached, so Ajour showed the handoff as Started, and
// Open then found no session.
test("a title over 80 characters reaches copilot cut after its last whole word, so copilot keeps the session", async () => {
  const calls = fakeCopilot();
  const title =
    "[AJ-42] Send each customer the price list for their own products, every week, from the warehouse";
  await startHandoff(startRequest({}, { title }));
  const name = calls[0].argv[calls[0].argv.indexOf("-n") + 1];
  assert.equal(
    name,
    "[AJ-42] Send each customer the price list for their own products, every week,…",
  );
  assert.ok(name.length <= 80);
});

test("another tools value never allows all tools", async () => {
  const calls = fakeCopilot();
  const result = await startHandoff(startRequest({ tools: "yes" }));
  assert.ok(!calls[0].argv.includes("--allow-all-tools"));
  assert.equal(result.native.tools, "ask");
});

test("a prompt that starts with a dash goes to stdin as it is", async () => {
  const calls = fakeCopilot();
  await startHandoff(startRequest({}, { prompt: "-- Fix it\n\n- now" }));
  assert.equal(calls[0].stdin, "-- Fix it\n\n- now");
});

test("a prompt over Ajour's 1 MB of stdin is refused before copilot runs", async () => {
  const calls = fakeCopilot();
  await assert.rejects(
    startHandoff(startRequest({}, { prompt: "x".repeat(1_048_577) })),
    {
      message:
        "The prompt has 1,048,577 characters, and Ajour gives Copilot CLI at most 1,048,576. Shorten the prompt.",
    },
  );
  assert.equal(calls.length, 0);
  await startHandoff(startRequest({}, { prompt: "x".repeat(1_048_576) }));
  assert.equal(calls.length, 1);
});

test("a prompt of only line breaks is refused", async () => {
  fakeCopilot();
  await assert.rejects(startHandoff(startRequest({}, { prompt: "\r\n \n" })), {
    message: "The prompt is empty. Check the handoff template.",
  });
});

test("a start Ajour refuses says what to do", async () => {
  const cases = [
    [
      "executable_missing",
      "Copilot CLI isn't installed, or its copilot command isn't on PATH.",
    ],
    [
      "needs_consent",
      "Open this plugin's Access section in Settings › Plugins and choose Allow and activate.",
    ],
    [
      "spawn_refused",
      "Ajour couldn't start copilot safely (an unusual launcher, an argument it can't pass, or a command line that's too long). Check the Copilot CLI install and this handoff's title.",
    ],
    ["folder_refused", /couldn't use this project's repository folder/],
    [
      "stdin_failed",
      "Copilot CLI didn't read the prompt: it stopped first, for example because it isn't signed in, or took more than 10 seconds to start. Run copilot in the repository folder to check that it starts and is signed in, then hand off again.",
    ],
    ["operation_ended", "Ajour stopped waiting for Copilot CLI. Try again."],
  ];
  for (const [code, message] of cases) {
    fakeCopilot(refuse(code));
    await assert.rejects(startHandoff(startRequest()), (error) => {
      if (typeof message === "string") assert.equal(error.message, message);
      else assert.match(error.message, message);
      assert.equal(error.code, code);
      return true;
    });
  }
});

test("Open resumes the session in a terminal in its folder", async () => {
  folders[FOLDER] = "C:\\Users\\me\\probe";
  fakeCopilot();
  const { resume } = await startHandoff(startRequest());
  const calls = fakeCopilot();
  await globalThis.ajour.process.run(resume);
  assert.deepEqual(calls, [
    {
      argv: [
        "copilot",
        "-C",
        "C:\\Users\\me\\probe",
        "--resume",
        resume.args.session,
      ],
      mode: "terminal",
      cwd: "C:\\Users\\me\\probe",
      stdin: undefined,
    },
  ]);
});

test("Copilot CLI doesn't follow state, so a refresh runs nothing and is refused", async () => {
  // plugin.json sets followsState: false, so Ajour shows its handoffs as
  // Started and never asks for their state (Ajour #759).
  const calls = fakeCopilot();
  await assert.rejects(
    readHandoffStates({
      tool: "copilot",
      handoffs: [handoff("h1", { label: "Started", tools: "allow" })],
    }),
    new RegExp(NO_STATE.replace(/[.']/g, "\\$&")),
  );
  await assert.rejects(
    readHandoffStates({ tool: "copilot", handoffs: [] }),
    /doesn't report a session's state/,
  );
  assert.deepEqual(calls, []);
});

test("the recorded copilot has every flag the commands use", () => {
  // From `copilot --help`: -C changes folder first, --session-id sets a new
  // session's UUID, -n names a new session. Without -p, copilot reads the
  // prompt from piped stdin, runs it and exits.
  assert.match(help, /combine with -i, -p, or piped stdin/);
  for (const flag of [
    "-C <directory>",
    "--session-id <id>",
    "-n, --name <name>",
    "--model <model>",
    "--allow-all-tools",
    "-r, --resume [<value>]",
    "-v, --version",
  ])
    assert.ok(help.includes(flag), flag);
  const copilotArgs = manifest.processes.commands
    .filter((c) => c.executable === "copilot")
    .flatMap((c) =>
      c.args.flatMap((a) => (typeof a === "string" ? [a] : a.args)),
    )
    .filter((a) => a.startsWith("-"));
  for (const flag of new Set(copilotArgs))
    assert.match(help, new RegExp(`(?:^|[ ,])${flag}\\b`, "m"), flag);
});

test("copilot takes the whole prompt from stdin, with its line breaks, and names the session", () => {
  // Recorded with the start's flags and a bracketed title, with
  // startRequest()'s prompt written to stdin the way Ajour writes a detached
  // command's: copilot read all of it within about a second, ran it without
  // a terminal and exited 0.
  const event = JSON.parse(read("stdin-user-message.json"));
  assert.equal(event.type, "user.message");
  assert.equal(event.data.content, startRequest().prompt);
  const workspace = read("stdin-workspace.yaml");
  assert.match(workspace, /^id: b94f4e9c-6fc2-41b3-9ee5-c17bd43903e0$/m);
  assert.match(workspace, /^name: '\[AJ-42\] Hand off to Copilot CLI'$/m);
  assert.match(workspace, /^cwd: C:\\Users\\me\\probe$/m);
});

test("a session started signed out keeps its id and name, and resumes", () => {
  // Recorded with the earlier argument start: copilot wrote the session
  // before it found it wasn't signed in. Whether it reads stdin before that
  // check isn't recorded; if it doesn't, the start fails with stdin_failed.
  const workspace = read("workspace.yaml");
  assert.match(workspace, /^id: 8e1f1abb-41cf-4a1a-9a38-e39ff17cf360$/m);
  assert.match(workspace, /^name: Ajour probe detached$/m);
  assert.match(workspace, /^cwd: C:\\Users\\me\\probe$/m);
  assert.match(
    read("no-auth.txt"),
    /^Error: No authentication information found\./,
  );
  // Without a terminal, resume refuses; Open runs it in one.
  assert.match(
    read("resume-no-tty.txt"),
    /^No prompt provided\. Run in an interactive terminal/,
  );
  assert.match(read("resume-unknown.txt"), /No session, task, or name matched/);
  // A name only applies to a new session, so the start passes it once.
  assert.match(
    read("name-existing.txt"),
    /--name only names a brand-new session/,
  );
});

test("another tool id is still refused", async () => {
  fakeCopilot();
  await assert.rejects(
    readHandoffStates({ tool: "aider", handoffs: [] }),
    /This plugin has no handoff tool "aider"/,
  );
});

test("Copilot CLI doesn't list its sessions, so a listing runs nothing", async () => {
  // Copilot CLI 1.0.112 lists sessions only in its interactive picker
  // (`copilot --resume`); `copilot sessions` only imports. plugin.json
  // leaves listsThreads off, so Ajour never asks.
  const calls = fakeBroker(() => {
    throw new Error("no command should run");
  });
  await assert.rejects(
    listThreads({ tool: "copilot", folder: { id: "folder-1" }, limit: 50 }),
    /interactive picker/,
  );
  assert.deepEqual(calls, []);
  await assert.rejects(
    listThreads({ tool: "aider", folder: { id: "folder-1" }, limit: 50 }),
    /no handoff tool/,
  );
});

test("T3 Code, Copilot CLI and VS Code close no thread, so a close refuses and runs nothing", async () => {
  // plugin.json gives them no closesThreads, so Ajour never asks (#850). A
  // close that answered would make Ajour drop a handoff whose thread is
  // still open.
  const calls = fakeBroker(() => {
    throw new Error("no command should run");
  });
  for (const [tool, reason] of [
    ["t3", /t3 command can't close a thread yet/],
    ["copilot", /no command that closes a session/],
    ["vscode", /can't close a chat/],
    ["aider", /no handoff tool/],
  ])
    await assert.rejects(
      closeThread({
        tool,
        handoff: { id: "h1", threadId: "t1", folderId: "folder-1", native: {} },
      }),
      reason,
      tool,
    );
  assert.deepEqual(calls, []);
});

test("a start whose launch Ajour cuts short, or that outlasts the start's deadline, says Copilot CLI may have started (ajour#857)", async (t) => {
  // Ajour keeps the worktree it made for the start, since Copilot CLI may run there.
  for (const code of ["timeout", "capture_incomplete", "output_limit"]) {
    fakeCopilot(refuse(code));
    await assert.rejects(startHandoff(startRequest()), {
      code,
      mayHaveStarted: true,
    });
  }
  // A refused launch starts nothing: the worktree can go.
  fakeCopilot(refuse("executable_missing"));
  await assert.rejects(startHandoff(startRequest()), (error) => {
    assert.equal(error.mayHaveStarted, undefined);
    return true;
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  fakeCopilot(() => new Promise(() => {}));
  const pending = startHandoff(startRequest());
  await flush();
  t.mock.timers.tick(27_000);
  await assert.rejects(pending, { code: "late", mayHaveStarted: true });
});
