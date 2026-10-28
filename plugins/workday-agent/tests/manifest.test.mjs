// Checks the rules Ajour applies when it installs the plugin, so a broken
// manifest or prompt fails here instead of in the user's Ajour.
import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
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

test("the manifest is an agent-task plugin with project and task properties for API 3", () => {
  assert.equal(manifest.apiVersion, 3);
  assert.deepEqual(Object.keys(manifest.capabilities).sort(), ["agentTask", "projectProperties", "taskProperties"]);
  assert.equal(manifest.entrypoint, undefined);
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
    ["A change may have taskProperties.", "Workday gets that Workday task."],
    ["Find a change's time type in Workday.", "never fall back to taskName."],
    ["An entry's comment has two lines.", "such a comment matches the same values."],
    ["To add an entry, open the entry dialog from the day itself.", "check the entry shows in the day with the right hours."],
  ]) {
    assert.ok(submit.includes(block(commit, start, end)), `submit-week.md differs from commit-week.md from "${start}"`);
  }
});

test("a task maps to a Workday task by a task property that defaults to its name", () => {
  assert.deepEqual(
    manifest.capabilities.taskProperties.fields.map((field) => [field.id, field.defaultFrom]),
    [["task", "name"]],
  );
});

test("both prompts read the Workday task from that property, and use taskName only without it", async () => {
  for (const name of ["commit-week.md", "submit-week.md"]) {
    const prompt = await readFile(new URL(`prompts/${name}`, root), "utf8");
    assert.match(prompt, /Match the task by taskProperties\["workday-agent"\]\.task\. Match it by taskName only when the change has no taskProperties/, name);
  }
});

test("the commit prompt finds an entry by its ID on a day in any time type, so a remapped task's entry moves", async () => {
  const commit = await readFile(new URL("prompts/commit-week.md", root), "utf8");
  assert.match(commit, /Find an entry by its externalId on a day, in any time type\./);
  assert.match(commit, /\*\*Updated\*\*, moved to another day/);
  assert.doesNotMatch(commit, /the committed day and time type, only when it differs/);
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
