// Imports every plugin's entrypoint in plain Node, the way Ajour runs it: from
// a copy of only the files the plugin publishes, with no build, no test
// runner, no loader and no node_modules. Vitest compiles TypeScript itself, so
// only this shows that Node can run the source as it is.
//
//   node scripts/smoke-import.mjs [folder...]
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SourceError,
  pluginPathFor,
  repositoryRoot,
  workingPlugin,
  workingPluginPaths,
} from "./ajour-source.mjs";

let root;
let pluginPaths;
try {
  root = repositoryRoot(fileURLToPath(new URL(".", import.meta.url)));
  const requested = process.argv.slice(2).filter(Boolean);
  pluginPaths = requested.length > 0
    ? requested.map((folder) => pluginPathFor(root, folder))
    : workingPluginPaths(root);
} catch (error) {
  if (!(error instanceof SourceError)) throw error;
  console.error(error.message);
  process.exit(1);
}

let failures = 0;
for (const pluginPath of pluginPaths) {
  let plugin;
  try {
    plugin = workingPlugin(root, pluginPath);
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    failures += 1;
    console.error(`✗ ${pluginPath}: ${error.message}`);
    continue;
  }
  const { entrypoint } = plugin.manifest;
  if (entrypoint === undefined) {
    console.log(`- ${pluginPath}: no entrypoint, nothing to import`);
    continue;
  }
  const directory = mkdtempSync(join(tmpdir(), "ajour-smoke-"));
  try {
    for (const file of plugin.files) {
      const target = join(directory, file.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file.absolute, target);
    }
    const module = await import(pathToFileURL(join(directory, entrypoint)).href);
    const exports = Object.keys(module);
    if (exports.length === 0) throw new Error("it exports nothing");
    console.log(`✓ ${pluginPath}: Node imported ${entrypoint} from its ${plugin.files.length} published files (exports ${exports.join(", ")})`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${pluginPath}: Node could not import ${entrypoint} from the published files: ${error?.message ?? error}`);
    console.error("  Ajour runs plugin source with Node's type stripping: erasable TypeScript only, relative imports with their file extension, and nothing outside the files in \"ajour.files\".");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`${failures} plugin(s) failed the smoke import.`);
  process.exitCode = 1;
}
