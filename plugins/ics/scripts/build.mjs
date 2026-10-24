// Bundles the plugin and ical.js into dist/plugin.js. Ajour installs only
// plugin.json and dist/, so runtime dependencies must be inside the bundle.
import { rm } from "node:fs/promises";
import { build, context } from "esbuild";

const options = {
  entryPoints: ["src/plugin.ts"],
  outfile: "dist/plugin.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "eof",
  // ical.js is MPL-2.0: name it and its source in the bundle.
  banner: {
    js: "/*! ajc-ics, MIT, https://github.com/les-cabochons/ajc-ics. Bundles ical.js 2.2.1, MPL-2.0 (https://mozilla.org/MPL/2.0/), source at https://github.com/kewisch/ical.js. */",
  },
  logLevel: "info",
};

await rm("dist", { recursive: true, force: true });

if (process.argv.includes("--watch")) {
  const watcher = await context(options);
  await watcher.watch();
} else {
  await build(options);
}
