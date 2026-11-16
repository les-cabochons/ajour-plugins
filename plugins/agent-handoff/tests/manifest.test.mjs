// Checks the rules Ajour applies to plugin.json that a type cannot say, from
// packages/shared/plugin-api-4.ts and handoffs.ts, and pins the exact
// commands the user approves in Access.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const manifest = JSON.parse(
  await readFile(new URL("../plugin.json", import.meta.url), "utf8"),
);
const { executables, commands } = manifest.processes;
const copilotStart = (extra) => [
  "-C",
  "{folder:folder}",
  "--session-id",
  "{session:id}",
  "-n",
  "{title:text}",
  { if: "model", args: ["--model", "{model:text}"] },
  ...extra,
  "-p",
  "{prompt:text}",
];

test("the manifest is a handoff plugin with T3 Code, Claude Code, Copilot CLI and Codex tools and no network", () => {
  assert.equal(manifest.apiVersion, 4);
  assert.equal(manifest.entrypoint, "src/plugin.ts");
  assert.deepEqual(Object.keys(manifest.capabilities), ["handoff"]);
  assert.equal(manifest.network, undefined);
  const tools = manifest.capabilities.handoff.tools;
  assert.deepEqual(
    tools.map((tool) => [tool.id, tool.label]),
    [
      ["t3", "T3 Code"],
      ["claude", "Claude Code"],
      ["copilot", "Copilot CLI"],
      ["codex", "Codex"],
    ],
  );
  for (const tool of tools) {
    assert.match(tool.id, /^[a-z][a-z0-9-]{0,79}$/);
    assert.ok(tool.settings.every((s) => !s.secret));
  }
  const settings = (tool) =>
    tool.settings.map((s) => [s.id, s.type, s.defaultValue]);
  assert.deepEqual(settings(tools[0]), [
    ["worktree", "checkbox", true],
    ["base", "text", "main"],
    ["provider", "text", undefined],
    ["model", "text", undefined],
  ]);
  assert.deepEqual(settings(tools[1]), [
    ["startMode", "select", "background"],
    ["model", "text", undefined],
  ]);
  assert.deepEqual(
    tools[1].settings[0].options.map((option) => option.value),
    ["background", "terminal"],
  );
  assert.deepEqual(settings(tools[2]), [
    ["tools", "select", "ask"],
    ["model", "text", undefined],
  ]);
  assert.deepEqual(
    tools[2].settings[0].options.map((option) => option.value),
    ["ask", "allow"],
  );
  assert.deepEqual(settings(tools[3]), [
    ["open", "select", "app"],
    ["model", "text", undefined],
  ]);
  assert.deepEqual(
    tools[3].settings[0].options.map((option) => option.value),
    ["app", "terminal"],
  );
  // The Codex app opens a thread from its codex://threads/<id> link.
  assert.deepEqual(manifest.processes.openSchemes, ["codex"]);
});

test("the declared commands are four t3, four claude, four copilot and three codex commands", () => {
  assert.deepEqual(executables, {
    t3: { names: ["t3"] },
    claude: { names: ["claude"] },
    copilot: { names: ["copilot"] },
    codex: { names: ["codex"] },
  });
  const shapes = Object.fromEntries(
    commands.map(({ id, ...command }) => [id, command]),
  );
  assert.deepEqual(shapes, {
    "thread-start": {
      executable: "t3",
      args: [
        "thread",
        "start",
        "{folder:folder}",
        "-",
        "--title",
        "{title:text}",
        "--json",
        {
          if: "branch",
          args: ["--worktree", "{base:ref}", "--branch", "{branch:ref}"],
        },
        { if: "provider", args: ["--provider", "{provider:text}"] },
        { if: "model", args: ["--model", "{model:text}"] },
      ],
      stdin: "text",
      mode: "capture",
      timeoutSeconds: 20,
    },
    "thread-list": {
      executable: "t3",
      args: ["thread", "list", "--project", "{folder:folder}", "--json"],
      mode: "capture",
      timeoutSeconds: 10,
    },
    // --messages 0 keeps conversation text out of the plugin.
    "thread-show": {
      executable: "t3",
      args: ["thread", "show", "{thread:id}", "--json", "--messages", "0"],
      mode: "capture",
      timeoutSeconds: 10,
    },
    version: {
      executable: "t3",
      args: ["--version"],
      mode: "capture",
      timeoutSeconds: 10,
    },
    // --bg runs in the folder claude starts in; --add-dir names that folder.
    // A terminal opens in its command's first folder, so attach carries one,
    // which claude ignores.
    "claude-start": {
      executable: "claude",
      args: [
        "--bg",
        "--name",
        "{title:text}",
        { if: "model", args: ["--model", "{model:text}"] },
        "--add-dir",
        "{folder:folder}",
      ],
      stdin: "text",
      mode: "capture",
      timeoutSeconds: 20,
    },
    "claude-agents": {
      executable: "claude",
      args: ["agents", "--json", "--all"],
      mode: "capture",
      timeoutSeconds: 10,
    },
    "claude-attach": {
      executable: "claude",
      args: ["attach", "{job:id}", "{folder:folder}"],
      mode: "terminal",
    },
    "claude-version": {
      executable: "claude",
      args: ["--version"],
      mode: "capture",
      timeoutSeconds: 10,
    },
    // -p runs the task and exits when done, so it starts detached, and a
    // detached command takes no stdin: the prompt is one argument. -C runs
    // copilot in the folder; the plugin chooses the session id.
    "copilot-start": {
      executable: "copilot",
      args: copilotStart([]),
      mode: "detached",
    },
    "copilot-start-allow": {
      executable: "copilot",
      args: copilotStart(["--allow-all-tools"]),
      mode: "detached",
    },
    "copilot-resume": {
      executable: "copilot",
      args: ["-C", "{folder:folder}", "--resume", "{session:id}"],
      mode: "terminal",
    },
    "copilot-version": {
      executable: "copilot",
      args: ["--version"],
      mode: "capture",
      timeoutSeconds: 10,
    },
    // The app-server must outlive the operation that starts a turn, so it is
    // a session. It ignores -C: the folder is there so Ajour starts it in the
    // repository folder, its first folder argument.
    "codex-app-server": {
      executable: "codex",
      args: ["-C", "{folder:folder}", "app-server"],
      mode: "session",
      idleTimeoutSeconds: 1800,
    },
    "codex-resume": {
      executable: "codex",
      args: ["resume", "-C", "{folder:folder}", "{thread:id}"],
      mode: "terminal",
    },
    "codex-version": {
      executable: "codex",
      args: ["--version"],
      mode: "capture",
      timeoutSeconds: 10,
    },
  });
});

test("every command ends well inside the host's 30-second operation", () => {
  // A start runs thread start or claude --bg, then reads what it started
  // until 27 s, so the first command leaves room for the reads and for
  // spawning them. A launch mode returns once started and takes no timeout.
  for (const command of commands)
    if (command.mode === "capture")
      assert.ok(
        command.timeoutSeconds !== undefined && command.timeoutSeconds <= 20,
        command.id,
      );
    else assert.equal(command.timeoutSeconds, undefined, command.id);
  // A session ends after its idle timeout, 1 to 3600 seconds; a refresh
  // every 30 to 120 seconds keeps a running turn's session well inside it.
  for (const command of commands)
    if (command.mode === "session")
      assert.ok(
        command.idleTimeoutSeconds >= 600 && command.idleTimeoutSeconds <= 3600,
        command.id,
      );
    else assert.equal(command.idleTimeoutSeconds, undefined, command.id);
});

test("each command passes the broker's declaration rules", () => {
  const slot =
    /^\{([a-zA-Z][a-zA-Z0-9_-]{0,79}):(text|id|ref|number|https-url|folder)\}$/;
  for (const command of commands) {
    assert.ok(Object.hasOwn(executables, command.executable), command.id);
    const names = [];
    for (const arg of command.args) {
      const group = typeof arg === "string" ? [arg] : arg.args;
      const slots = group.flatMap((a) => {
        if (!/[{}]/.test(a)) return [];
        const match = slot.exec(a);
        assert.ok(match, `${command.id}: ${a} is a whole typed slot`);
        return [match[1]];
      });
      if (typeof arg !== "string")
        assert.ok(
          slots.includes(arg.if),
          `${command.id}: group tests its own slot`,
        );
      names.push(...slots);
    }
    assert.equal(
      new Set(names).size,
      names.length,
      `${command.id}: unique slots`,
    );
    assert.ok(
      new TextEncoder().encode(JSON.stringify(command)).length <= 12 * 1024,
    );
  }
});
