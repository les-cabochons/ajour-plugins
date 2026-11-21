// Checks plugin.json against Ajour's API 4 manifest type, the SDK's
// PluginManifest. The SDK is types only, so TypeScript is the validator: it
// refuses a misspelt key, an unknown settings field type, a process mode Ajour
// does not have and another apiVersion. Ajour's install check is stricter
// still; manifest.test.mjs covers the rules a type cannot say.
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
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
}

/**
 * plugin.json without the keys the vendored SDK 0.2.0 predates: each tool's
 * `closesThreads` (ajour#850), whose values manifest.test.mjs pins. Drop
 * this once the vendored SDK has it.
 */
function withoutNewerKeys(manifest) {
  for (const tool of manifest.capabilities.handoff.tools)
    delete tool.closesThreads;
  return manifest;
}

test("plugin.json is a valid API 4 manifest for the SDK", async () => {
  assert.deepEqual(
    await manifestErrors(withoutNewerKeys(JSON.parse(manifestText)), "valid"),
    [],
  );
});

test("the check refuses a bad field type, a bad mode, a misspelt key and another API version", async () => {
  const textarea = withoutNewerKeys(JSON.parse(manifestText));
  textarea.capabilities.handoff.tools[0].settings[0].type = "textarea";
  assert.notDeepEqual(await manifestErrors(textarea, "bad-field"), []);

  const mode = withoutNewerKeys(JSON.parse(manifestText));
  mode.processes.commands[0].mode = "shell";
  assert.notDeepEqual(await manifestErrors(mode, "bad-mode"), []);

  const misspelt = withoutNewerKeys(JSON.parse(manifestText));
  misspelt.capabilities.handoff.tool = [];
  assert.notDeepEqual(await manifestErrors(misspelt, "bad-key"), []);

  const apiThree = {
    ...withoutNewerKeys(JSON.parse(manifestText)),
    apiVersion: 3,
  };
  assert.notDeepEqual(await manifestErrors(apiThree, "bad-api"), []);
});

test("the SDK knows each tool's features, and refuses one that isn't a boolean", async () => {
  for (const key of ["followsState", "listsThreads", "hooks"]) {
    const manifest = withoutNewerKeys(JSON.parse(manifestText));
    manifest.capabilities.handoff.tools[0][key] = "yes";
    assert.notDeepEqual(await manifestErrors(manifest, `bad-${key}`), [], key);
  }
});
