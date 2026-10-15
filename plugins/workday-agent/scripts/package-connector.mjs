// Builds the installable .ajour-connector archive: plugin.json and the
// prompts folder at the archive root. This plugin has no code to compile.
import path from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { create } from "tar";

const pluginRoot = process.cwd();
const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8"));
const packageMetadata = JSON.parse(
  await readFile(path.join(pluginRoot, "package.json"), "utf8"),
);

if (packageMetadata.version !== manifest.version) {
  throw new Error("package.json and plugin.json must declare the same version.");
}

const outputDirectory = path.join(pluginRoot, "package");
const outputPath = path.join(
  outputDirectory,
  `${manifest.id}-${manifest.version}.ajour-connector`,
);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await create(
  { cwd: pluginRoot, file: outputPath, gzip: true, noMtime: true, portable: true },
  ["plugin.json", "prompts"],
);

process.stdout.write(`${outputPath}\n`);
