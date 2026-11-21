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
// Claude Code's per-start settings: an http hook for each event whose reply
// can't steer the session. Stop is left out, since its reply can keep Claude
// working (ajour#765), and SessionStart takes only command hooks. Notification
// gives up after 5 seconds instead of http's default 600; SessionEnd hooks share
// a 1.5-second budget, which a longer timeout would raise.
const HOOK_TEMPLATE = JSON.stringify({
  hooks: {
    Notification: [{ hooks: [{ type: "http", url: "{url}", timeout: 5 }] }],
    SessionEnd: [{ hooks: [{ type: "http", url: "{url}" }] }],
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

test("the manifest is a handoff plugin with T3 Code, Claude Code, Claude Code desktop, Copilot CLI, OpenCode, Codex and VS Code tools", () => {
  assert.equal(manifest.apiVersion, 4);
  assert.equal(manifest.entrypoint, "src/plugin.ts");
  assert.deepEqual(Object.keys(manifest.capabilities), ["handoff"]);
  const tools = manifest.capabilities.handoff.tools;
  assert.deepEqual(
    tools.map((tool) => [tool.id, tool.label, tool.connection]),
    [
      ["t3", "T3 Code", undefined],
      ["claude", "Claude Code", undefined],
      ["claude-desktop", "Claude Code desktop", undefined],
      ["copilot", "Copilot CLI", undefined],
      ["opencode", "OpenCode", undefined],
      ["codex", "Codex", undefined],
      ["vscode", "VS Code", undefined],
    ],
  );
  for (const tool of tools) {
    assert.match(tool.id, /^[a-z][a-z0-9-]{0,79}$/);
    assert.ok(tool.settings.every((s) => !s.secret));
  }
  const settings = (tool) =>
    tool.settings.map((s) => [s.id, s.type, s.defaultValue]);
  // T3 Code has no worktree setting: Ajour's Start in decides (ajour#863).
  assert.deepEqual(settings(tools[0]), [
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
  // The desktop tool has no start mode: the Claude app can't open a session
  // until its turn ends.
  assert.deepEqual(settings(tools[2]), [["model", "text", undefined]]);
  assert.deepEqual(settings(tools[3]), [
    ["tools", "select", "ask"],
    ["model", "text", undefined],
  ]);
  assert.deepEqual(
    tools[3].settings[0].options.map((option) => option.value),
    ["ask", "allow"],
  );
  assert.deepEqual(settings(tools[4]), [
    ["model", "text", undefined],
    ["agent", "text", undefined],
  ]);
  assert.deepEqual(settings(tools[5]), [
    ["open", "select", "app"],
    ["model", "text", undefined],
  ]);
  assert.deepEqual(
    tools[5].settings[0].options.map((option) => option.value),
    ["app", "terminal"],
  );
  // code chat has no model option, and handoffs always run in agent mode.
  assert.deepEqual(settings(tools[6]), []);
  // The Claude desktop app opens a session from claude://resume?session=<id>,
  // the Codex app a thread from codex://threads/<id>, and the T3 Code app
  // from t3code://threads/<environment>/<thread>.
  assert.deepEqual(manifest.processes.openSchemes, [
    "claude",
    "codex",
    "t3code",
  ]);
});

test("no tool uses a connection, so the manifest has no connection fields or network", () => {
  // OpenCode 2's CLI finds its background service and signs in to it by
  // itself, so OpenCode no longer goes through a connection (#836).
  assert.equal(manifest.connectionFields, undefined);
  assert.equal(manifest.network, undefined);
  assert.equal(manifest.connectionAccess, undefined);
});

test("every tool declares the features it supports, explicitly", () => {
  // Ajour #759 and #764: `followsState` (true when absent), `listsThreads` and
  // `hooks` (false when absent). Copilot CLI 1.0.112 has no command that
  // reports a session's state and lists sessions only in its interactive
  // picker, so it only starts sessions. VS Code 1.146's code command reports
  // and lists no chat either. Only Claude Code's start posts hooks, for both
  // Claude tools.
  const tools = manifest.capabilities.handoff.tools;
  assert.deepEqual(
    tools.map((tool) => [
      tool.id,
      tool.followsState,
      tool.listsThreads,
      tool.hooks,
    ]),
    [
      ["t3", true, true, false],
      ["claude", true, true, true],
      ["claude-desktop", true, true, true],
      ["copilot", false, false, false],
      ["opencode", true, true, false],
      ["codex", true, true, false],
      ["vscode", false, false, false],
    ],
  );
  for (const tool of tools)
    for (const key of ["followsState", "listsThreads", "hooks"])
      assert.equal(typeof tool[key], "boolean", `${tool.id}: ${key}`);
});

test("only T3 Code makes its own worktree", () => {
  // Ajour #859. T3 Code can't start a thread in a folder outside its
  // registered projects, so it can't run in a worktree Ajour makes: it makes
  // one itself, on the branch Ajour sends. Every other tool starts in the
  // folder it is given.
  assert.deepEqual(
    manifest.capabilities.handoff.tools
      .filter((tool) => tool.ownWorktree !== undefined)
      .map((tool) => [tool.id, tool.ownWorktree]),
    [["t3", true]],
  );
});

test("Claude Code, Claude Code desktop and Codex archive their threads, OpenCode deletes them, the others close none", () => {
  // Ajour #850. T3 Code's t3 command can't close a thread yet
  // (pingdotgg/t3code discussion #27428); Copilot CLI and VS Code have no
  // command that does.
  assert.deepEqual(
    manifest.capabilities.handoff.tools.map((tool) => [
      tool.id,
      tool.closesThreads,
    ]),
    [
      ["t3", undefined],
      ["claude", "archive"],
      ["claude-desktop", "archive"],
      ["copilot", undefined],
      ["opencode", "delete"],
      ["codex", "archive"],
      ["vscode", undefined],
    ],
  );
  // No declared command can discard work or force a removal.
  for (const command of commands)
    for (const arg of command.args.flatMap((a) =>
      typeof a === "string" ? [a] : (a.args ?? []),
    ))
      assert.doesNotMatch(arg, /discard|force/i, `${command.id}: ${arg}`);
});

test("a tool posts hooks only with a hook-url command and while it follows state", () => {
  // Ajour refuses the manifest otherwise (plugin-api-4.ts, #764).
  const usesHook = (command) =>
    command.args
      .flatMap((arg) =>
        typeof arg !== "string" && arg.args ? arg.args : [arg],
      )
      .some((arg) => arg.kind === "hook-url");
  assert.ok(commands.some(usesHook));
  for (const tool of manifest.capabilities.handoff.tools.filter((t) => t.hooks))
    assert.notEqual(tool.followsState, false, `${tool.id}: follows state`);
  // A tool that doesn't follow state gets no hook, so none of its commands
  // can take one: the broker would refuse the start with hook_refused.
  for (const tool of manifest.capabilities.handoff.tools.filter(
    (t) => t.followsState === false,
  )) {
    const own = commands.filter((c) => c.executable === tool.id);
    // A tool whose id isn't its executable would match nothing and check nothing.
    assert.ok(own.length > 0, `${tool.id}: has commands to check`);
    for (const command of own)
      assert.ok(!usesHook(command), `${command.id}: no hook-url argument`);
  }
  assert.deepEqual(
    commands.filter(usesHook).map((c) => c.id),
    ["claude-start-hook"],
  );
});

test("the declared commands are four t3, nine claude, four copilot, eight opencode, three codex and two code commands", () => {
  assert.deepEqual(executables, {
    t3: { names: ["t3"] },
    claude: { names: ["claude"] },
    copilot: { names: ["copilot"] },
    opencode: { names: ["opencode"] },
    codex: { names: ["codex"] },
    // The tool id is the executable id; VS Code's command is code.
    vscode: { names: ["code"] },
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
    // --messages 0 keeps conversation text out of the plugin. t3 thread show
    // takes no folder, but T3 creates the folder it starts in and fails at
    // the system root (#53), so it runs in the repository folder (Ajour #761).
    "thread-show": {
      executable: "t3",
      args: ["thread", "show", "{thread:id}", "--json", "--messages", "0"],
      cwd: "{folder:folder}",
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
    // claude in a terminal in the folder, with nothing on its command line:
    // Claude Code asks whether to trust a folder only in an interactive
    // session, and --bg refuses one it doesn't trust yet.
    "claude-trust": {
      executable: "claude",
      args: [],
      cwd: "{folder:folder}",
      mode: "terminal",
    },
    // The Claude desktop app can't take a turn in a session a background
    // job still runs, so a refresh stops the job once its turn ends.
    "claude-stop": {
      executable: "claude",
      args: ["stop", "{job:id}"],
      mode: "capture",
      timeoutSeconds: 10,
    },
    // A close removes the job from claude agents, keeping its conversation.
    // Never with --discard-unpushed or --force-remove-worktree, which throw
    // away work claude rm refuses to lose.
    "claude-rm": {
      executable: "claude",
      args: ["rm", "{job:id}"],
      mode: "capture",
      timeoutSeconds: 15,
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
    // `opencode run` creates the session under the id the plugin chose, in
    // its working folder, reads the prompt from stdin, runs one turn and
    // exits, so it starts detached.
    "opencode-run": {
      executable: "opencode",
      args: [
        "run",
        "-s",
        "{session:id}",
        "--title",
        "{title:text}",
        { if: "model", args: ["--model", "{model:text}"] },
        { if: "agent", args: ["--agent", "{agent:text}"] },
      ],
      cwd: "{folder:folder}",
      stdin: "text",
      mode: "detached",
    },
    // `opencode api` signs in to the background service. A slot is a whole
    // argument, so the plugin passes `sessionID=<id>` as one text value, to
    // one fixed operation.
    "opencode-session": {
      executable: "opencode",
      args: ["api", "session.get", "--param", "{session:text}"],
      mode: "capture",
      timeoutSeconds: 10,
    },
    "opencode-messages": {
      executable: "opencode",
      args: [
        "api",
        "session.message.list",
        "--param",
        "{session:text}",
        "--param",
        "limit=1",
      ],
      mode: "capture",
      timeoutSeconds: 10,
    },
    // `opencode session list` lists the project of the folder it runs in.
    "opencode-sessions": {
      executable: "opencode",
      args: ["session", "list", "--format", "json", "-n", "{limit:number}"],
      cwd: "{folder:folder}",
      mode: "capture",
      timeoutSeconds: 10,
    },
    // A close interrupts the session's run, a no-op on an idle session,
    // then deletes the session and its child sessions.
    "opencode-interrupt": {
      executable: "opencode",
      args: ["api", "session.interrupt", "--param", "{session:text}"],
      mode: "capture",
      timeoutSeconds: 10,
    },
    "opencode-delete": {
      executable: "opencode",
      args: ["session", "delete", "{session:id}"],
      mode: "capture",
      timeoutSeconds: 10,
    },
    "opencode-open": {
      executable: "opencode",
      args: ["{folder:folder}", "-s", "{session:id}"],
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
    // code chat takes the prompt only from its arguments, where Ajour
    // refuses line breaks, and attaches stdin as a file (-). So the plugin
    // passes one line and the whole prompt on stdin. code chat opens the
    // folder it runs in, which cwd sets.
    "vscode-chat": {
      executable: "vscode",
      args: ["chat", "-m", "agent", "{request:text}", "-"],
      cwd: "{folder:folder}",
      stdin: "text",
      mode: "detached",
    },
    "vscode-version": {
      executable: "vscode",
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
    // A working folder is a whole folder slot that no other kind and no
    // conditional group uses: the command always needs it (Ajour #761).
    if (command.cwd !== undefined) {
      const match = /^\{([a-zA-Z][a-zA-Z0-9_-]{0,79}):folder\}$/.exec(
        command.cwd,
      );
      assert.ok(match, `${command.id}: cwd is a whole folder slot`);
      for (const arg of command.args) {
        const grouped = typeof arg !== "string" && arg.args;
        for (const a of grouped ? arg.args : [arg]) {
          if (typeof a !== "string" || slot.exec(a)?.[1] !== match[1]) continue;
          assert.ok(!grouped, `${command.id}: cwd's slot isn't in a group`);
          assert.equal(a, command.cwd, `${command.id}: cwd's slot is a folder`);
        }
        if (grouped)
          assert.notEqual(arg.if, match[1], `${command.id}: cwd isn't a test`);
      }
    }
    assert.ok(
      new TextEncoder().encode(JSON.stringify(command)).length <= 12 * 1024,
    );
  }
});

test("every tool ships its own logo, drawn in its own colours", () => {
  const icons = manifest.capabilities.handoff.tools.map((tool) => tool.iconSvg);
  // One logo per tool: Ajour tells the tools apart by them.
  assert.equal(new Set(icons).size, icons.length);
  for (const icon of icons) {
    // Ajour draws a tool's icon as an image, where currentColor is black
    // whatever the theme, so a logo names its own colours.
    assert.doesNotMatch(icon, /currentColor/);
    assert.match(icon, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
  }
});
