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
// Claude Code's per-start settings: an http hook for each event that takes
// one. SessionStart takes only command hooks, so it is left out.
const httpHook = { hooks: [{ type: "http", url: "{url}" }] };
const HOOK_TEMPLATE = JSON.stringify({
  hooks: {
    Stop: [httpHook],
    Notification: [httpHook],
    SessionEnd: [httpHook],
  },
});
const copilotStart = (extra) => [
  "-C",
  "{folder:folder}",
  "--session-id",
  "{session:id}",
  "-n",
  "{title:text}",
  { if: "model", args: ["--model", "{model:text}"] },
  ...extra,
];

test("the manifest is a handoff plugin with T3 Code, Claude Code, Copilot CLI, OpenCode and Codex tools", () => {
  assert.equal(manifest.apiVersion, 4);
  assert.equal(manifest.entrypoint, "src/plugin.ts");
  assert.deepEqual(Object.keys(manifest.capabilities), ["handoff"]);
  const tools = manifest.capabilities.handoff.tools;
  assert.deepEqual(
    tools.map((tool) => [tool.id, tool.label, tool.connection]),
    [
      ["t3", "T3 Code", undefined],
      ["claude", "Claude Code", undefined],
      ["copilot", "Copilot CLI", undefined],
      ["opencode", "OpenCode", "required"],
      ["codex", "Codex", undefined],
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
    ["model", "text", undefined],
    ["agent", "text", undefined],
  ]);
  assert.deepEqual(settings(tools[4]), [
    ["open", "select", "app"],
    ["model", "text", undefined],
  ]);
  assert.deepEqual(
    tools[4].settings[0].options.map((option) => option.value),
    ["app", "terminal"],
  );
  // The Codex app opens a thread from its codex://threads/<id> link.
  assert.deepEqual(manifest.processes.openSchemes, ["codex"]);
});

test("OpenCode's connection is its loopback server, reached on-premises through the broker", () => {
  // packages/shared/plugin-api-4.ts: a tool that uses a connection needs
  // connection fields and a network, and the base address field is a url
  // that isn't secret. Ajour's form needs label and tenantLabel.
  assert.deepEqual(
    manifest.connectionFields.map((f) => [
      f.id,
      f.type,
      f.required,
      f.secret,
      f.defaultValue,
    ]),
    [
      ["label", "text", true, undefined, "OpenCode"],
      ["tenantLabel", "text", true, undefined, "This computer"],
      ["serverUrl", "url", true, undefined, "http://127.0.0.1:4096"],
    ],
  );
  // No credential: the server runs without a password, on 127.0.0.1, so the
  // connection must be on-premises to reach a private address over http.
  assert.deepEqual(manifest.network, {
    baseAddress: { field: "serverUrl", allowOnPremises: true },
    endpoints: [
      { method: "GET", path: "/global/health" },
      // A listing asks the server its folder, then lists its sessions.
      { method: "GET", path: "/path" },
      { method: "GET", path: "/session" },
      { method: "POST", path: "/session" },
      { method: "GET", path: "/session/status" },
      { method: "GET", path: "/session/*" },
      { method: "DELETE", path: "/session/*" },
      { method: "GET", path: "/session/*/message" },
      { method: "POST", path: "/session/*/prompt_async" },
      { method: "GET", path: "/permission" },
      { method: "GET", path: "/question" },
    ],
    requestHeaders: ["Content-Type"],
  });
  assert.equal(manifest.connectionAccess, undefined);
});

test("the tools that can list their threads per folder say so; Copilot CLI can't", () => {
  // Copilot CLI 1.0.112 lists sessions only in its interactive picker.
  assert.deepEqual(
    manifest.capabilities.handoff.tools.map((tool) => [
      tool.id,
      tool.listsThreads,
    ]),
    [
      ["t3", true],
      ["claude", true],
      ["copilot", undefined],
      ["opencode", true],
      ["codex", true],
    ],
  );
});

test("the declared commands are four t3, six claude, four copilot, two opencode and three codex commands", () => {
  assert.deepEqual(executables, {
    t3: { names: ["t3"] },
    claude: { names: ["claude"] },
    copilot: { names: ["copilot"] },
    opencode: { names: ["opencode"] },
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
    // A start Ajour gives a hook passes Claude Code per-start settings, which
    // never touch the user's settings files: Ajour writes the start's hook
    // URL at each {url} of this fixed template, whose HTTP hooks post when
    // the session stops, needs the user or ends.
    "claude-start-hook": {
      executable: "claude",
      args: [
        "--bg",
        "--name",
        "{title:text}",
        { if: "model", args: ["--model", "{model:text}"] },
        "--settings",
        { kind: "hook-url", name: "hook", template: HOOK_TEMPLATE },
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
    // A listing asks for the sessions started under one folder; Ajour gives
    // claude the folder's path, never the plugin.
    "claude-agents-folder": {
      executable: "claude",
      args: ["agents", "--json", "--all", "--cwd", "{folder:folder}"],
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
    // Without a terminal, copilot reads the prompt from stdin, runs the task
    // and exits when done, so it starts detached with the prompt on stdin,
    // never on the command line. -C runs copilot in the folder; the plugin
    // chooses the session id.
    "copilot-start": {
      executable: "copilot",
      args: copilotStart([]),
      stdin: "text",
      mode: "detached",
    },
    "copilot-start-allow": {
      executable: "copilot",
      args: copilotStart(["--allow-all-tools"]),
      stdin: "text",
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
    // Ajour fills {server:connection-url} from the handoff's connection; the
    // plugin passes only the session. A terminal opens in its first folder,
    // and --dir names the same folder to OpenCode.
    "opencode-attach": {
      executable: "opencode",
      args: [
        "attach",
        "{server:connection-url}",
        "-s",
        "{session:id}",
        "--dir",
        "{folder:folder}",
      ],
      mode: "terminal",
    },
    "opencode-version": {
      executable: "opencode",
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
    /^\{([a-zA-Z][a-zA-Z0-9_-]{0,79}):(text|id|ref|number|https-url|folder|connection-url)\}$/;
  const connected = manifest.capabilities.handoff.tools.some(
    (tool) => tool.connection === "required",
  );
  for (const command of commands) {
    assert.ok(Object.hasOwn(executables, command.executable), command.id);
    const names = [];
    for (const arg of command.args) {
      const group = typeof arg === "string" || !arg.args ? [arg] : arg.args;
      const slots = group.flatMap((a) => {
        if (typeof a !== "string") {
          // The object form: a hook-url slot whose template is a literal
          // under 1000 characters, holding {url}, without CR, LF or NUL.
          assert.equal(a.kind, "hook-url", `${command.id}: object argument`);
          assert.match(a.name, /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
          assert.ok(a.template.includes("{url}"), `${command.id}: {url}`);
          assert.ok(a.template.length <= 1000, `${command.id}: template`);
          assert.doesNotMatch(a.template, /[\0\r\n]/);
          // Only a handoff plugin has a start to fill it in.
          assert.ok(manifest.capabilities.handoff, `${command.id}: handoff`);
          return [a.name];
        }
        if (!/[{}]/.test(a)) return [];
        const match = slot.exec(a);
        assert.ok(match, `${command.id}: ${a} is a whole typed slot`);
        return [match[1]];
      });
      if (typeof arg !== "string" && arg.args) {
        assert.ok(
          slots.includes(arg.if),
          `${command.id}: group tests its own slot`,
        );
        // Ajour fills a connection-url slot, so the plugin can't pass it.
        assert.ok(
          !group.includes(`{${arg.if}:connection-url}`),
          `${command.id}: a group can't test a connection-url slot`,
        );
        // Nor a hook-url slot, which Ajour fills too.
        assert.ok(
          !group.some(
            (a) => a.kind === "hook-url" || a.endsWith?.(":hook-url}"),
          ),
          `${command.id}: a group can't hold a hook-url slot`,
        );
      }
      // A connection-url slot is filled from the base address, only in an
      // operation of a tool that uses a connection.
      if (group.some((a) => a.endsWith?.(":connection-url}"))) {
        assert.ok(manifest.network?.baseAddress, `${command.id}: base address`);
        assert.ok(connected, `${command.id}: a tool that uses a connection`);
      }
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
