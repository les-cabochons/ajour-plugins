// Tests for plan-ci.mjs, run against this repository's plugin folders.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./plan-ci.mjs", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));
const allPlugins = readdirSync(join(root, "plugins"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));
const scratch = mkdtempSync(join(tmpdir(), "plan-ci-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function plan(args, extraEnv = {}) {
  const output = join(scratch, `output-${Math.random().toString(16).slice(2)}`);
  const env = { ...process.env, BASE_SHA: "", HEAD_SHA: "", REQUESTED_PLUGINS: "", GITHUB_OUTPUT: output, ...extraEnv };
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: "utf8" });
  let plugins;
  try {
    plugins = JSON.parse(/^plugins=(.*)$/m.exec(readFileSync(output, "utf8"))[1]);
  } catch {
    plugins = undefined;
  }
  return { ...result, plugins };
}

test("a manual run tests the plugins it names, or all of them", () => {
  assert.deepEqual(plan(["--plugins", "jira, ics"]).plugins, ["ics", "jira"]);
  assert.deepEqual(plan([], { REQUESTED_PLUGINS: "all" }).plugins, allPlugins);
});

test("a first push, with a base of zeros, tests every plugin", () => {
  const result = plan(["--base", "0000000000000000000000000000000000000000"]);
  assert.deepEqual(result.plugins, allPlugins);
  assert.match(result.stdout, /no base to compare/);
});

test("a range with no changes tests nothing", () => {
  const result = plan(["--base", "HEAD", "--head", "HEAD"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.plugins, []);
  assert.match(result.stdout, /Test: none/);
});

test("an unknown plugin is refused", () => {
  const result = plan(["--plugins", "nope"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown plugin "nope"/);
});
