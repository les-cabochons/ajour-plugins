// Checks the rules Ajour applies when it installs the plugin, so a broken
// manifest or prompt fails here instead of in the user's Ajour.
import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));
const [task] = manifest.capabilities.agentTask.tasks;
const settingIds = new Set(task.settings.map((setting) => setting.id));

/** Ajour refuses a slot it does not know: weekOf, sessionId and settings.<id>. */
function unknownSlots(text) {
  return [...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)]
    .map(([, slot]) => slot)
    .filter(
      (slot) =>
        slot !== "weekOf" &&
        slot !== "sessionId" &&
        !(slot.startsWith("settings.") && settingIds.has(slot.slice("settings.".length))),
    );
}

test("the manifest is an agent-task plugin with project properties for API 3", () => {
  assert.equal(manifest.apiVersion, 3);
  assert.deepEqual(Object.keys(manifest.capabilities).sort(), ["agentTask", "projectProperties"]);
  assert.equal(manifest.entrypoint, undefined);
  assert.equal(task.placement, "commit-week");
});

test("the prompt is a regular file under 64 KB", async () => {
  const stat = await lstat(new URL(task.prompt, root));
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.ok(stat.size <= 64 * 1024);
});

test("the prompt and week link use only slots Ajour fills", async () => {
  const prompt = await readFile(new URL(task.prompt, root), "utf8");
  assert.deepEqual(unknownSlots(prompt), []);
  assert.deepEqual(unknownSlots(task.weekLink), []);
});

test("the prompt marks changes with their version and never matches an entry by hours", async () => {
  const prompt = await readFile(new URL(task.prompt, root), "utf8");
  assert.match(prompt, /mark_entries_committed with `changes: \[\{ entryId, version \}\]`/);
  assert.doesNotMatch(prompt, /Exactly one: treat it as that entry/);
});
