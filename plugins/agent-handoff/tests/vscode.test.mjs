// The VS Code tool against outputs recorded from the real code CLI (VS Code
// 1.146.0 on macOS, see fixtures/vscode/version.txt). A fake code answers
// each declared command, after the fake broker expands it to argv from
// plugin.json the way Ajour does. A real start opens VS Code and runs an
// agent, so no start is recorded; what `code chat` does with its input comes
// from VS Code 1.146.0's own code, as each test says.
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
  fakeBroker,
  flush,
  folders,
  manifest,
  ok,
  refuse,
  refused,
} from "./fake-broker.mjs";

const read = (name) =>
  readFileSync(new URL(`fixtures/vscode/${name}`, import.meta.url), "utf8");

const version = read("version.txt");
const help = read("chat-help.txt");
const FOLDER = "folder-1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  delete globalThis.ajour;
  for (const id of Object.keys(folders)) delete folders[id];
});

/** Installs a fake code. `answer` gets argv and returns a result. */
function fakeCode(answer = () => undefined) {
  return fakeBroker((argv, call) => {
    // Detection asks every tool; these tests have only code.
    if (argv[0] !== "code") throw refused("executable_missing");
    return answer(argv, call);
  });
}

const startRequest = (extra = {}) => ({
  tool: "vscode",
  folder: { id: FOLDER, name: "ajour" },
  prompt:
    "Work on AJ-42: hand off to VS Code\nhttps://example.com/AJ-42\n\n  - Start it.\r\n- Reopen it.\n",
  title: "AJ-42 Hand off to VS Code",
  branch: "aj-42-vscode",
  item: { key: "AJ-42", url: "https://example.com/AJ-42" },
  settings: {},
  ...extra,
});

// Detection answers each tool once, in the manifest's order.
const vscodeOf = (tools) => tools.find((tool) => tool.id === "vscode");

test("detection returns the recorded version", async () => {
  const calls = fakeCode(() => ok(version));
  const { tools } = await detectTools();
  assert.deepEqual(vscodeOf(tools), {
    id: "vscode",
    available: true,
    version: "1.146.0",
  });
  assert.deepEqual(
    calls.filter((c) => c.argv[0] === "code").map((c) => c.argv),
    [["code", "--version"]],
  );
});

test("detection says VS Code isn't installed when code is missing", async () => {
  fakeCode(refuse("executable_missing"));
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
    vscodeOf(tools).reason,
    "VS Code isn't installed, or its code command isn't on PATH.",
  );
});

test("detection refuses output that isn't a version", async () => {
  fakeCode(() => ok(""));
  const { tools } = await detectTools();
  assert.deepEqual(vscodeOf(tools), {
    id: "vscode",
    available: false,
    reason: "code returned no version.",
  });
});

test("a start runs code chat detached in the repository folder, in agent mode, the prompt on stdin", async () => {
  folders[FOLDER] = "/Users/me/probe";
  const calls = fakeCode();
  const result = await startHandoff(startRequest());
  assert.deepEqual(calls, [
    {
      // VS Code 1.146.0 joins the words after `chat` into the prompt it sends,
      // and saves stdin to a temporary file it attaches (`-`). Without -r or
      // -n it opens the folder code runs in.
      argv: [
        "code",
        "chat",
        "-m",
        "agent",
        "Follow the handoff in the attached file: AJ-42 Hand off to VS Code",
        "-",
      ],
      mode: "detached",
      cwd: "/Users/me/probe",
      stdin: startRequest().prompt,
    },
  ]);
  assert.match(result.threadId, UUID);
  // No state, no link and no resume: Ajour shows the handoff as Started,
  // and VS Code is already open on the chat.
  assert.deepEqual(result, {
    threadId: result.threadId,
    native: { label: "Started" },
  });
});

test("the prompt never reaches the command line, and keeps its line breaks", async () => {
  const calls = fakeCode();
  const prompt =
    "[AJ-42] Hand off\n\n  - Start it.\r\n- Reopen it.\n\n" +
    "line\n".repeat(5000);
  await startHandoff(startRequest({ prompt }));
  const [call] = calls;
  assert.equal(call.stdin, prompt);
  assert.ok(
    call.argv.every((value) => !/Start it|Reopen it|\n/.test(value)),
    call.argv.join(" "),
  );
});

test("each start gets its own thread id", async () => {
  fakeCode();
  const first = await startHandoff(startRequest());
  const second = await startHandoff(startRequest());
  assert.notEqual(first.threadId, second.threadId);
});

test("the title reaches the chat on one line, cut after 80 characters", async () => {
  const calls = fakeCode();
  await startHandoff(
    startRequest({
      title:
        "- [AJ-42]\tSend each customer the price list\r\n\nfor their own products, every week, from the warehouse",
    }),
  );
  assert.equal(
    calls[0].argv[4],
    "Follow the handoff in the attached file: [AJ-42] Send each customer the price list for their own products, every week,…",
  );
});

test("a prompt over Ajour's 1 MB of stdin is refused before code runs", async () => {
  const calls = fakeCode();
  await assert.rejects(
    startHandoff(startRequest({ prompt: "x".repeat(1_048_577) })),
    {
      message:
        "The prompt has 1,048,577 characters, and Ajour gives VS Code at most 1,048,576. Shorten the prompt.",
    },
  );
  assert.equal(calls.length, 0);
  await startHandoff(startRequest({ prompt: "x".repeat(1_048_576) }));
  assert.equal(calls.length, 1);
});

test("a prompt of only line breaks is refused", async () => {
  const calls = fakeCode();
  await assert.rejects(startHandoff(startRequest({ prompt: "\r\n \n" })), {
    message: "The prompt is empty. Check the handoff template.",
  });
  assert.equal(calls.length, 0);
});

test("a start Ajour refuses says what to do", async () => {
  const cases = [
    [
      "executable_missing",
      "VS Code isn't installed, or its code command isn't on PATH.",
    ],
    [
      "needs_consent",
      "Open this plugin's Access section in Settings › Plugins and choose Allow and activate.",
    ],
    [
      "spawn_refused",
      "Ajour couldn't start code safely (an unusual launcher, an argument it can't pass, or a command line that's too long). Check the VS Code install and this handoff's title.",
    ],
    ["folder_refused", /couldn't use this project's repository folder/],
    [
      "stdin_failed",
      "VS Code didn't read the prompt: code stopped first, or took more than 10 seconds to start. Run code in the repository folder to check that it opens, then hand off again.",
    ],
    ["operation_ended", "Ajour stopped waiting for VS Code. Try again."],
  ];
  for (const [code, message] of cases) {
    fakeCode(refuse(code));
    await assert.rejects(startHandoff(startRequest()), (error) => {
      if (typeof message === "string") assert.equal(error.message, message);
      else assert.match(error.message, message);
      assert.equal(error.code, code);
      return true;
    });
  }
});

test("VS Code doesn't follow state or list chats, so neither runs a command", async () => {
  // plugin.json sets followsState and listsThreads to false, so Ajour never
  // asks; the plugin still refuses without running anything.
  const calls = fakeCode();
  await assert.rejects(
    readHandoffStates({
      tool: "vscode",
      handoffs: [
        {
          id: "h1",
          threadId: "4920efe0-a33d-4eb7-9d21-661dd49a265d",
          folderId: FOLDER,
          native: { label: "Started" },
        },
      ],
    }),
    /VS Code doesn't report a chat's state\. Open VS Code to follow it\./,
  );
  await assert.rejects(
    listThreads({ tool: "vscode", folder: { id: FOLDER }, limit: 50 }),
    /VS Code's code command doesn't list its chats/,
  );
  assert.deepEqual(calls, []);
});

test("the recorded code chat has every flag the commands use, and reads stdin with -", () => {
  assert.match(help, /^Usage: code chat \[options\] \[prompt\]$/m);
  assert.match(help, /To read from stdin, append '-'/);
  assert.match(help, /-m --mode <mode>.*\n.*'agent'/);
  const codeArgs = manifest.processes.commands
    .filter((c) => c.executable === "vscode" && c.args[0] === "chat")
    .flatMap((c) => c.args)
    .filter((a) => typeof a === "string" && /^-./.test(a));
  assert.deepEqual(codeArgs, ["-m"]);
  for (const flag of codeArgs)
    assert.match(help, new RegExp(`^\\s+${flag} `, "m"), flag);
});

test("a start whose launch Ajour cuts short, or that outlasts the start's deadline, says VS Code may have started (ajour#857)", async (t) => {
  // Ajour keeps the worktree it made for the start, since VS Code may run there.
  for (const code of ["timeout", "capture_incomplete", "output_limit"]) {
    fakeCode(refuse(code));
    await assert.rejects(startHandoff(startRequest()), {
      code,
      mayHaveStarted: true,
    });
  }
  // A refused launch starts nothing: the worktree can go.
  fakeCode(refuse("executable_missing"));
  await assert.rejects(startHandoff(startRequest()), (error) => {
    assert.equal(error.mayHaveStarted, undefined);
    return true;
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  fakeCode(() => new Promise(() => {}));
  const pending = startHandoff(startRequest());
  await flush();
  t.mock.timers.tick(27_000);
  await assert.rejects(pending, { code: "late", mayHaveStarted: true });
});
