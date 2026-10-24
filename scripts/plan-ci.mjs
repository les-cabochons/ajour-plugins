// Chooses the plugins CI builds and the plugins it publishes.
//
// A plugin is built when a file in its folder changed, and every plugin is
// built when a shared file changed, such as the lockfile or the workflow. Only
// a plugin whose own folder changed is published, so a lockfile refresh does
// not release every plugin again. A first push, a push whose base is no longer
// in the history and a manual run select every plugin, or the ones named.
//
// In CI the inputs come from the environment and the result goes to
// GITHUB_OUTPUT. Locally: node scripts/plan-ci.mjs --base origin/main
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({
  options: {
    base: { type: "string", default: process.env.BASE_SHA ?? "" },
    head: { type: "string", default: process.env.HEAD_SHA || "HEAD" },
    plugins: { type: "string", default: process.env.REQUESTED_PLUGINS ?? "" },
    publish: { type: "boolean", default: process.env.PUBLISH === "true" },
  },
});

// The slug becomes a prerelease identifier in the release tag, which Ajour
// parses as a semantic version, so it is limited to what semver allows.
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const pluginsRoot = new URL("../plugins/", import.meta.url);

const plugins = readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    if (!slugPattern.test(entry.name)) {
      throw new Error(
        `Plugin folder "${entry.name}" must use lowercase letters, digits and single hyphens.`,
      );
    }
    const metadata = JSON.parse(
      readFileSync(new URL(`${entry.name}/package.json`, pluginsRoot), "utf8"),
    );
    const packaged = typeof metadata.scripts?.package === "string";
    const releaseTitle = metadata.ajourRelease?.title;
    return {
      slug: entry.name,
      packaged,
      publishable: packaged && typeof releaseTitle === "string",
    };
  })
  .sort((left, right) => left.slug.localeCompare(right.slug));

const allSlugs = plugins.map((plugin) => plugin.slug);

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

// Documentation and the license outside plugins/ change no build.
function isShared(file) {
  return !file.startsWith("plugins/") && !/\.md$/i.test(file) && file !== "LICENSE";
}

let built;
let changed;
let reason;
const requested = requestedSlugs(options.plugins);
if (requested.length > 0) {
  built = requested;
  changed = requested;
  reason = `requested: ${options.plugins}`;
} else {
  const files = changedFiles(options.base, options.head);
  if (files === null) {
    built = allSlugs;
    changed = allSlugs;
    reason = hasBase
      ? `${options.base} is not in the history, so every plugin`
      : "no base to compare, so every plugin";
  } else {
    changed = allSlugs.filter((slug) =>
      files.some((file) => file.startsWith(`plugins/${slug}/`)),
    );
    const shared = files.filter(isShared);
    built = shared.length > 0 ? allSlugs : changed;
    reason =
      shared.length > 0
        ? `shared files changed (${shared.slice(0, 5).join(", ")}${shared.length > 5 ? ", …" : ""})`
        : `${files.length} changed file(s) since ${options.base}`;
  }
}

const matrix = plugins
  .filter((plugin) => built.includes(plugin.slug))
  .map((plugin) => ({
    slug: plugin.slug,
    packaged: plugin.packaged,
    publish: options.publish && plugin.publishable && changed.includes(plugin.slug),
  }));
const publish = matrix.filter((entry) => entry.publish).map((entry) => entry.slug);
const wouldPublish = plugins
  .filter((plugin) => plugin.publishable && changed.includes(plugin.slug) && built.includes(plugin.slug))
  .map((plugin) => plugin.slug);

process.stdout.write(
  [
    `Reason: ${reason}`,
    `Build: ${matrix.map((entry) => entry.slug).join(", ") || "none"}`,
    `Publish: ${publish.join(", ") || "none"}`,
    ...(options.publish ? [] : [`Would publish on main: ${wouldPublish.join(", ") || "none"}`]),
    "",
  ].join("\n"),
);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `build=${JSON.stringify(matrix)}\npublish=${JSON.stringify(publish)}\n`,
  );
}
