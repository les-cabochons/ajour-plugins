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

test("the manifest is a handoff plugin with one T3 Code tool and no network", () => {
  assert.equal(manifest.apiVersion, 4);
  assert.equal(manifest.entrypoint, "src/plugin.ts");
  assert.deepEqual(Object.keys(manifest.capabilities), ["handoff"]);
  assert.equal(manifest.network, undefined);
  const [tool] = manifest.capabilities.handoff.tools;
  assert.equal(manifest.capabilities.handoff.tools.length, 1);
  assert.match(tool.id, /^[a-z][a-z0-9-]{0,79}$/);
  assert.equal(tool.id, "t3");
  assert.deepEqual(
    tool.settings.map((s) => [s.id, s.type, s.defaultValue]),
    [
      ["worktree", "checkbox", true],
      ["base", "text", "main"],
      ["provider", "text", undefined],
      ["model", "text", undefined],
    ],
  );
  assert.ok(tool.settings.every((s) => !s.secret));
});

test("the declared commands are the four t3 commands, with prompts on stdin", () => {
  assert.deepEqual(executables, { t3: { names: ["t3"] } });
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
        {
          if: "provider",
          args: ["--provider", "{provider:id}", "--model", "{model:id}"],
        },
      ],
      stdin: "text",
      mode: "capture",
      timeoutSeconds: 60,
    },
    "thread-list": {
      executable: "t3",
      args: ["thread", "list", "--project", "{folder:folder}", "--json"],
      mode: "capture",
    },
    "thread-show": {
      executable: "t3",
      args: ["thread", "show", "{thread:id}", "--json"],
      mode: "capture",
    },
    version: { executable: "t3", args: ["--version"], mode: "capture" },
  });
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
