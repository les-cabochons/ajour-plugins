// The Copilot CLI tool against outputs recorded from the real copilot CLI
// (1.0.112 on Windows, see fixtures/copilot/version.txt) with an isolated
// COPILOT_HOME, signed out, in a throwaway repository. A fake copilot answers
// each declared command, after the fake broker expands it to argv from
// plugin.json the way Ajour does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { detectTools, readHandoffStates, startHandoff } from "../src/plugin.ts";
import {
  fakeBroker,
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

test("detection returns the recorded version", async () => {
  const calls = fakeCopilot(() => ok(version));
  const { tools } = await detectTools();
  assert.deepEqual(tools[2], {
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
      ["copilot", false],
    ],
  );
  assert.equal(
    tools[2].reason,
    "Copilot CLI isn't installed, or its copilot command isn't on PATH.",
  );
});

test("detection keeps an unexpected version line as it is", async () => {
  fakeCopilot(() => ok("1.1.0\n"));
  const { tools } = await detectTools();
  assert.equal(tools[2].version, "1.1.0");
});

test("a start chooses the session id and runs copilot -p detached in the folder", async () => {
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
      "-p",
      "Work on AJ-42: hand off to Copilot CLI https://example.com/AJ-42 - Start it. - Reopen it.",
    ],
    mode: "detached",
    cwd: "C:\\Users\\me\\probe",
    stdin: undefined,
  });
  assert.deepEqual(result, {
    threadId: result.threadId,
    resume: {
      command: "copilot-resume",
      args: { session: result.threadId, folder: FOLDER },
    },
    native: { state: "working", label: "Started", tools: "ask" },
  });
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
  assert.deepEqual(calls[0].argv.slice(9, 11), ["--allow-all-tools", "-p"]);
  assert.equal(result.native.tools, "allow");
});

test("another tools value never allows all tools", async () => {
  const calls = fakeCopilot();
  const result = await startHandoff(startRequest({ tools: "yes" }));
  assert.ok(!calls[0].argv.includes("--allow-all-tools"));
  assert.equal(result.native.tools, "ask");
});

test("a prompt that starts with a dash loses the dash, not the text", async () => {
  const calls = fakeCopilot();
  await startHandoff(startRequest({}, { prompt: "-- Fix it\n\n- now" }));
  assert.equal(calls[0].argv.at(-1), "Fix it - now");
});

test("a prompt longer than the command line takes is refused before copilot runs", async () => {
  const calls = fakeCopilot();
  await assert.rejects(
    startHandoff(startRequest({}, { prompt: "x".repeat(12_001) })),
    {
      message:
        "The prompt has 12,001 characters, and Copilot CLI takes at most 12,000 on its command line. Shorten the handoff template, such as by leaving out the item's description.",
    },
  );
  assert.equal(calls.length, 0);
  await startHandoff(startRequest({}, { prompt: "x".repeat(12_000) }));
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

test("every refresh is unknown and keeps the last state, never gone", async () => {
  const calls = fakeCopilot();
  const updates = await readHandoffStates({
    tool: "copilot",
    handoffs: [
      handoff("h1", { state: "working", label: "Started", tools: "allow" }),
      handoff("h2", { state: "ready", reason: "old" }),
      handoff("h3", {}),
    ],
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(updates, [
    {
      id: "h1",
      state: "unknown",
      native: {
        state: "working",
        tools: "allow",
        label: "Unknown",
        reason: NO_STATE,
      },
    },
    {
      id: "h2",
      state: "unknown",
      native: { state: "ready", label: "Unknown", reason: NO_STATE },
    },
    {
      id: "h3",
      state: "unknown",
      native: { state: "working", label: "Unknown", reason: NO_STATE },
    },
  ]);
});

test("a refresh with no handoffs returns none", async () => {
  fakeCopilot();
  assert.deepEqual(
    await readHandoffStates({ tool: "copilot", handoffs: [] }),
    [],
  );
});

test("the recorded copilot has every flag the commands use", () => {
  // From `copilot --help`: -C changes folder first, --session-id sets a new
  // session's UUID, -n names a new session, -p runs a prompt and exits.
  for (const flag of [
    "-C <directory>",
    "--session-id <id>",
    "-n, --name <name>",
    "-p, --prompt <text>",
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

test("a session started signed out keeps its id and name, and resumes", () => {
  // What a detached start leaves when copilot can't sign in: it exits after
  // writing the session, which Open can still resume.
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
    readHandoffStates({ tool: "codex", handoffs: [] }),
    /This plugin has no handoff tool "codex"/,
  );
});
