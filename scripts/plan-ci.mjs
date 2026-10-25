// Chooses the plugins CI tests.
//
// A plugin is tested when a file in its folder changed, and every plugin is
// tested when a shared file changed, such as the lockfile or the workflow. A
// first push, a push whose base is no longer in the history and a manual run
// select every plugin, or the ones named.
//
// In CI the inputs come from the environment and the result goes to
// GITHUB_OUTPUT as plugins=["folder", ...]. Locally:
// node scripts/plan-ci.mjs --base origin/main
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({
  options: {
    base: { type: "string", default: process.env.BASE_SHA ?? "" },
    head: { type: "string", default: process.env.HEAD_SHA || "HEAD" },
    plugins: { type: "string", default: process.env.REQUESTED_PLUGINS ?? "" },
  },
});

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const pluginsRoot = new URL("../plugins/", import.meta.url);

const allSlugs = readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    if (!slugPattern.test(entry.name)) {
      throw new Error(
        `Plugin folder "${entry.name}" must use lowercase letters, digits and single hyphens.`,
      );
    }
    return entry.name;
  })
  .sort((left, right) => left.localeCompare(right));

function requestedSlugs(value) {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.includes("all")) {
    return allSlugs;
  }
  for (const name of names) {
    if (!allSlugs.includes(name)) {
      throw new Error(`Unknown plugin "${name}". Plugins: ${allSlugs.join(", ")}.`);
    }
  }
  return names;
}

// A first push has no base: GitHub sends a base of zeros.
const hasBase = Boolean(options.base) && !/^0+$/.test(options.base);

function changedFiles(base, head) {
  if (!hasBase) {
    return null;
  }
  try {
    const output = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

// Documentation, the license and the source manifest outside plugins/ change
// no plugin. The source job checks ajour.json on every run.
function isShared(file) {
  return (
    !file.startsWith("plugins/") &&
    !/\.md$/i.test(file) &&
    !["LICENSE", "ajour.json", "ajour.json.sig"].includes(file)
  );
}

let tested;
let reason;
const requested = requestedSlugs(options.plugins);
if (requested.length > 0) {
  tested = requested;
  reason = `requested: ${options.plugins}`;
} else {
  const files = changedFiles(options.base, options.head);
  if (files === null) {
    tested = allSlugs;
    reason = hasBase
      ? `${options.base} is not in the history, so every plugin`
      : "no base to compare, so every plugin";
  } else {
    const shared = files.filter(isShared);
    tested =
      shared.length > 0
        ? allSlugs
        : allSlugs.filter((slug) => files.some((file) => file.startsWith(`plugins/${slug}/`)));
    reason =
      shared.length > 0
        ? `shared files changed (${shared.slice(0, 5).join(", ")}${shared.length > 5 ? ", …" : ""})`
        : `${files.length} changed file(s) since ${options.base}`;
  }
}

const plugins = allSlugs.filter((slug) => tested.includes(slug));

process.stdout.write(
  [`Reason: ${reason}`, `Test: ${plugins.join(", ") || "none"}`, ""].join("\n"),
);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `plugins=${JSON.stringify(plugins)}\n`);
}
