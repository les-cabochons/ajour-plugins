// Checks the rules Ajour applies when it installs the plugin, so a broken
// manifest or prompt fails here instead of in the user's Ajour.
import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));
const tasks = manifest.capabilities.agentTask.tasks;

/** Ajour refuses a slot it does not know: weekOf, sessionId and settings.<id>. */
function unknownSlots(text, task) {
  const settingIds = new Set(task.settings.map((setting) => setting.id));
  return [...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)]
    .map(([, slot]) => slot)
    .filter(
      (slot) =>
        slot !== "weekOf" &&
        slot !== "sessionId" &&
        !(slot.startsWith("settings.") && settingIds.has(slot.slice("settings.".length))),
    );
}

test("the manifest is an agent-task plugin with project properties for API 4", () => {
  assert.equal(manifest.apiVersion, 4);
  assert.deepEqual(Object.keys(manifest.capabilities).sort(), ["agentTask", "projectProperties"]);
  // No code, so no entrypoint, and no network or connection for the broker.
  for (const key of ["entrypoint", "network", "connectionFields", "connectionAccess", "runtime"]) {
    assert.equal(manifest[key], undefined, key);
  }
  assert.deepEqual(
    tasks.map((task) => [task.id, task.placement]),
    [
      ["commit-week", "commit-week"],
      ["submit-week", "submit-week"],
    ],
  );
});

for (const task of tasks) {
  test(`${task.id}: the prompt is a regular file under 64 KB`, async () => {
    const stat = await lstat(new URL(task.prompt, root));
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.ok(stat.size <= 64 * 1024);
  });

  test(`${task.id}: the prompt and week link use only slots Ajour fills`, async () => {
    const prompt = await readFile(new URL(task.prompt, root), "utf8");
    assert.deepEqual(unknownSlots(prompt, task), []);
    assert.deepEqual(unknownSlots(task.weekLink, task), []);
  });
}

/** The Ajour MCP tools each task declares: what its prompt tells the agent to call. */
const declaredTools = {
  "commit-week": ["get_week_changes", "list_time_entries", "mark_entries_committed"],
  "submit-week": ["get_week_status", "submit_week"],
};
/** Session tools are always allowed and never declared. */
const sessionTools = new Set(["begin_session", "update_session", "end_session", "ask", "wait_for_answer"]);
/** Tools a prompt names only to forbid. */
const forbiddenTools = { "commit-week": [], "submit-week": ["mark_entries_committed"] };

for (const task of tasks) {
  test(`${task.id}: declares exactly the Ajour MCP tools its prompt uses`, async () => {
    const prompt = await readFile(new URL(task.prompt, root), "utf8");
    assert.deepEqual([...task.tools].sort(), [...declaredTools[task.id]].sort());
    const named = new Set(prompt.match(/\b[a-z]+(?:_[a-z]+)+\b/g));
    const unexpected = [...named].filter(
      (name) =>
        !name.startsWith("browser_") &&
        !sessionTools.has(name) &&
        !task.tools.includes(name) &&
        !forbiddenTools[task.id].includes(name),
    );
    assert.deepEqual(unexpected, [], "the prompt names a tool the task does not declare");
    for (const tool of task.tools) assert.ok(named.has(tool), `${tool} is declared but the prompt never uses it`);
    for (const tool of forbiddenTools[task.id]) assert.ok(!task.tools.includes(tool));
  });
}

/** The text of `text` from `start` to the end of `end`. */
function block(text, start, end) {
  const from = text.indexOf(start);
  const to = from === -1 ? -1 : text.indexOf(end, from);
  assert.ok(to !== -1, `commit-week.md has no block from "${start}"`);
  return text.slice(from, to + end.length);
}

test("the submit prompt repeats the commit prompt's shared rules word for word", async () => {
  const commit = await readFile(new URL("prompts/commit-week.md", root), "utf8");
  const submit = await readFile(new URL("prompts/submit-week.md", root), "utf8");
  for (const [start, end] of [
    ['1. Send update_session: "Opening Workday."', "say what the page shows."],
    ["Ajour gives hours as decimal numbers with a dot", "when you compare Workday's hours with Ajour's."],
    ["A change may have projectFullName and projectProperties.", "it is a short name only Ajour knows."],
    ["Find a change's time type in Workday.", "Match the task by taskName."],
    ["To add an entry, open the entry dialog from the day itself.", "check the entry shows in the day with the right hours."],
  ]) {
    assert.ok(submit.includes(block(commit, start, end)), `submit-week.md differs from commit-week.md from "${start}"`);
  }
});

test("the submit prompt never presses a Workday Submit button", async () => {
  const submit = await readFile(new URL("prompts/submit-week.md", root), "utf8");
  assert.match(submit, /never look for or press a Submit, Review or Soumettre button/);
});

test("the prompt marks changes with their version and never matches an entry by hours", async () => {
  const prompt = await readFile(new URL(tasks[0].prompt, root), "utf8");
  assert.match(prompt, /mark_entries_committed with `changes: \[\{ entryId, version \}\]`/);
  assert.doesNotMatch(prompt, /Exactly one: treat it as that entry/);
});

test("the submit prompt reads the week's status again before a repair and before submit_week, and passes its version", async () => {
  const submit = await readFile(new URL("prompts/submit-week.md", root), "utf8");
  assert.match(submit, /before you change anything in Workday, call get_week_status again/i);
  assert.match(submit, /Right before submit_week, call get_week_status again/);
  assert.match(submit, /Call submit_week with weekOf \{\{weekOf\}\} and the version of that last get_week_status call/);
  assert.match(submit, /The week changed since you read it/);
  assert.match(submit, /Ask with the choices "Leave it" and "Stop"/);
});

test("the submit prompt marks nothing when it repairs Workday back to the committed values", async () => {
  const submit = await readFile(new URL("prompts/submit-week.md", root), "utf8");
  assert.match(submit, /Do not call mark_entries_committed for these repairs/);
});

test("every \"Stop\" ends the session as cancelled", async () => {
  for (const name of ["commit-week.md", "submit-week.md"]) {
    const prompt = await readFile(new URL(`prompts/${name}`, root), "utf8");
    assert.doesNotMatch(prompt, /"Stop"[^.\n]*failed/, name);
  }
});

test("plugin.json and package.json carry the same version", async () => {
  const pack = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pack.version, manifest.version);
});

/** The files and folders the plugin publishes, as the source listing names them. */
async function publishedFiles() {
  const pack = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const found = [];
  for (const name of pack.ajour.files) {
    const stat = await lstat(new URL(name, root));
    if (stat.isDirectory()) {
      for (const child of await readdir(new URL(`${name}/`, root), { recursive: true })) {
        if (!(await lstat(new URL(`${name}/${child}`, root))).isDirectory()) found.push(`${name}/${child}`);
      }
    } else found.push(name);
  }
  return found.map((file) => file.replaceAll("\\", "/")).sort();
}

// This plugin is manifest-only, so there is no source to check for `fetch(`,
// `require(`, `node:`, `process.`, `Buffer` or a credential. What stays true,
// and what the sibling plugins' source-purity tests protect, is that it runs no
// code: Ajour has nothing to start in a sandboxed worker, and the broker holds
// no credential for it.
test("publishes the manifest, the prompts and nothing that runs", async () => {
  assert.deepEqual(await publishedFiles(), [
    "LICENSE",
    "package.json",
    "plugin.json",
    "prompts/commit-week.md",
    "prompts/submit-week.md",
  ]);
  const sourceFolder = await lstat(new URL("src", root)).catch(() => undefined);
  assert.equal(sourceFolder, undefined, "the plugin has no src folder, so nothing to run");
});

test("declares no code, no network and no credential in the manifest", () => {
  for (const key of ["entrypoint", "runtime", "network", "connectionFields", "connectionAccess", "signIn"]) {
    assert.equal(key in manifest, false, `plugin.json must not declare ${key}`);
  }
  // Prose may say "password" ("never types a password"); a field named for a credential may not exist.
  const keys = [];
  JSON.stringify(manifest, (key, value) => (keys.push(key), value));
  assert.deepEqual(keys.filter((key) => /authorization|password|token|secret|credential|apikey/i.test(key)), []);
  assert.doesNotMatch(JSON.stringify(manifest), /fetch\(|require\(|node:|process\.|Buffer|Authorization/);
});
