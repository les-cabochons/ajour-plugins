// Checks plugin.json against Ajour's API 4 manifest type, the SDK's
// PluginManifest. The SDK is types only, so TypeScript is the validator: it
// refuses a misspelt key, a wrong apiVersion and an MCP tool Ajour does not
// have. Ajour's own install check is stricter still; the tests in
// manifest.test.mjs cover the rules a type cannot say.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const manifestText = await readFile(new URL("plugin.json", root), "utf8");
const scratch = new URL("node_modules/.cache/manifest-check/", root);
await mkdir(scratch, { recursive: true });

/** The TypeScript errors of `manifest` used as a PluginManifest. */
async function manifestErrors(manifest, name) {
  const file = new URL(`${name}.ts`, scratch);
  await writeFile(
    file,
    `import type { PluginManifest } from "@ajour/plugin-sdk";\n` +
      `export const manifest = ${JSON.stringify(manifest)} satisfies PluginManifest;\n`,
  );
  const program = ts.createProgram([fileURLToPath(file)], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

test("plugin.json is a valid API 4 manifest for the SDK", async () => {
  assert.deepEqual(await manifestErrors(JSON.parse(manifestText), "valid"), []);
});

test("the check refuses an undeclared MCP tool, a misspelt key and another API version", async () => {
  const withTool = JSON.parse(manifestText);
  withTool.capabilities.agentTask.tasks[0].tools.push("delete_everything");
  assert.notDeepEqual(await manifestErrors(withTool, "bad-tool"), []);

  const misspelt = JSON.parse(manifestText);
  misspelt.capabilities.agentTask.tasks[0].tool = [];
  assert.notDeepEqual(await manifestErrors(misspelt, "bad-key"), []);

  const apiThree = { ...JSON.parse(manifestText), apiVersion: 3 };
  assert.notDeepEqual(await manifestErrors(apiThree, "bad-api"), []);
});
