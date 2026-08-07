import { cp, mkdir, rm } from "node:fs/promises";

const source = new URL("../src/plugin.mjs", import.meta.url);
const outputDirectory = new URL("../dist/", import.meta.url);
const output = new URL("plugin.mjs", outputDirectory);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(source, output);
