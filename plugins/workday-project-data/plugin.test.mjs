import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importProjects } from "./src/plugin.mjs";

/**
 * The source with its comments, strings, template text and regular
 * expressions blanked, so a purity check sees code only: a comment saying
 * "no fetch" must not fail it, and a string holding "fetch" must not hide it.
 * Template `${...}` expressions stay, since they run.
 */
function withoutCommentsAndStrings(source) {
  let out = "";
  const templates = []; // brace depth at each open `${`
  let depth = 0;
  let previous = ""; // the last code character that is not whitespace
  let i = 0;
  const blank = (text) => text.replace(/[^\n]/g, " ");
  function skipTemplateText() {
    const start = i;
    while (i < source.length && source[i] !== "`" && !(source[i] === "$" && source[i + 1] === "{")) {
      i += source[i] === "\\" ? 2 : 1;
    }
    out += blank(source.slice(start, i));
    if (source[i] === "`") {
      out += " ";
      i += 1;
    } else if (i < source.length) {
      out += "  ";
      i += 2;
      templates.push(depth);
      depth += 1;
    }
  }
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (char === '"' || char === "'") {
      const start = i;
      i += 1;
      while (i < source.length && source[i] !== char && source[i] !== "\n") {
        i += source[i] === "\\" ? 2 : 1;
      }
      i += 1;
      out += blank(source.slice(start, i));
      previous = char;
    } else if (char === "`") {
      out += " ";
      i += 1;
      skipTemplateText();
      previous = "`";
    } else if (char === "}" && templates.length > 0 && templates.at(-1) === depth - 1) {
      templates.pop();
      depth -= 1;
      out += " ";
      i += 1;
      skipTemplateText();
    } else if (char === "/" && (previous === "" || "(,=:[!&|?{};".includes(previous))) {
      const start = i;
      i += 1;
      let inClass = false;
      while (i < source.length && source[i] !== "\n" && (inClass || source[i] !== "/")) {
        if (source[i] === "\\") i += 1;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        i += 1;
      }
      i += 1;
      while (/[a-z]/.test(source[i] ?? "")) i += 1;
      out += blank(source.slice(start, i));
      previous = "/";
    } else {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      out += char;
      if (!/\s/.test(char)) previous = char;
      i += 1;
    }
  }
  return out;
}

test("the purity check reads code only", () => {
  const code = [
    "// fetch(url) in a comment",
    "/* import x from 'y'; process */",
    "const a = 'fetch';",
    'const b = "require(x)";',
    "const c = `process ${a} Buffer`;",
    "const d = /[\"']fetch/g;",
    "const e = `${fetch(a)}`;",
  ].join("\n");
  const stripped = withoutCommentsAndStrings(code);
  assert.equal(stripped.match(/\bfetch\b/g)?.length, 1, stripped);
  assert.doesNotMatch(stripped, /\b(?:process|Buffer|require|import)\b/);
  assert.equal(stripped.split("\n").length, code.split("\n").length);
});

// Laid out like Workday's French exports, with made-up projects and people.

/** The project export ("Afficher un projet"), as Ajour reads its sheets. */
function projectExport() {
  return [
    { name: "Sheet1", rows: [["Afficher un projet: 100200 Acme - Support [Q-1]"]] },
    {
      name: "Récapitulatif",
      rows: [
        ["Récapitulatif d'un projet - Vue composite"],
        ["Récapitulatif du projet"],
        ["Nom du projet", "Acme - Support [Q-1]"],
        ["Date de début", "2026-06-01T00:00:00.000Z"],
        ["Identifiant du projet", "100200"],
        ["Inactif", "Non"],
      ],
    },
    { name: "Affectation de rôle", rows: [["Rôle affectable", "Affecté à"], ["Project Manager", "Jane Doe"]] },
    {
      name: "Ressources des tâches",
      rows: [
        ["View Task Resources (Composite View): 100200 Acme - Support [Q-1]"],
        ["Mass Update Task Resource", "Mettre à jour en masse"],
        [],
        ["Tâches du plan de projet"],
        ["Phase de projet - Tâche de projet", "Phase de projet", "Tâche de projet", "Date de début de la tâche de projet"],
        ["Optimisation > Regular", "Optimisation", "Regular", "2026-10-01T00:00:00.000Z"],
        ["Support > Billet #101 - Login", "Support", "Billet #101 - Login"],
        ["Support > Optimisation", "Support", "Optimisation"],
        ["Support > Project Management", "Support", "Project Management"],
      ],
    },
  ];
}

const PLAN_HEADER = ["Numéro", "Phase/tâche", "Nom personnalisé de la tâche", "Date de début", "Date de fin", "Heures estimatives", "Heures travaillées", "Heures restantes", "% d'achèvement", "Non facturable", "Jalon", "Fermé", "Utilisation", "Note"];

/** The project plan export ("View Project Planner Composite View"). */
function projectPlan(rows) {
  return [{ name: "View_Project_Planner_Composite_", rows: [PLAN_HEADER, ...rows] }];
}

async function readManifest() {
  return JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));
}

test("declares an import-only schema on plugin API 4", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.id, "workday-project-data");
  assert.equal(manifest.version, "2.1.0");
  assert.equal(manifest.apiVersion, 4);
  assert.equal(manifest.entrypoint, "src/plugin.mjs");
  assert.deepEqual(manifest.capabilities, { projectDataShape: { apiVersion: 1 } });
  assert.equal(manifest.capabilities.projectDataShape.datasets, undefined);
});

test("asks for no network and no connection, and loads when needed", async () => {
  const manifest = await readManifest();
  assert.deepEqual(manifest.runtime, { start: "whenNeeded" });
  for (const key of ["network", "connectionFields", "connectionAccess", "signIn"]) {
    assert.equal(key in manifest, false, `plugin.json must not declare ${key}`);
  }
  assert.deepEqual(Object.keys(manifest).sort(), [
    "apiVersion",
    "capabilities",
    "description",
    "displayName",
    "entrypoint",
    "iconSvg",
    "id",
    "runtime",
    "version",
  ]);
});

test("keeps the version of plugin.json and package.json together", async () => {
  const pack = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(pack.version, (await readManifest()).version);
});

test("runs in a sandboxed browser worker: no import, no Node global, no network", async () => {
  const source = withoutCommentsAndStrings(
    await readFile(new URL("./src/plugin.mjs", import.meta.url), "utf8"),
  );
  assert.doesNotMatch(source, /^\s*import\s/m, "an import would load a module the sandbox does not serve");
  assert.doesNotMatch(source, /\bimport\s*\(/, "a dynamic import would load a module the sandbox does not serve");
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /\b(?:node:|Buffer\b|process\b|__dirname|__filename|globalThis\.process)/);
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|ajour)\b/);
});

test("imports the project export as a project with its tasks", async () => {
  assert.deepEqual(await importProjects(projectExport()), {
    projects: [
      {
        name: "Acme - Support [Q-1]",
        code: "100200",
        status: "active",
        tasks: [{ name: "Optimisation" }, { name: "Billet #101 - Login" }, { name: "Project Management" }],
      },
    ],
  });
});

test("keeps the project ID out of the name, and archives an inactive project", async () => {
  const sheets = projectExport();
  sheets[1].rows[2] = ["Nom du projet", "100200 Acme - Support [Q-1]"];
  sheets[1].rows[5] = ["Inactif", "Oui"];

  const [project] = (await importProjects(sheets)).projects;

  assert.equal(project.name, "Acme - Support [Q-1]");
  assert.equal(project.status, "archived");
});

test("refuses a project export without its tasks sheet", async () => {
  const sheets = projectExport().filter((sheet) => sheet.name !== "Ressources des tâches");

  await assert.rejects(importProjects(sheets), /no Ressources des tâches sheet/);
});

test("imports a project plan's tasks, without a project name", async () => {
  const result = await importProjects(projectPlan([
    ["1", "Optimisation", null, null, null, 0, null, null, 0, null, null, null, "Non"],
    ["T", "Regular", null, "2026-10-01T00:00:00.000Z", null, 0, null, 0, 0, "Oui", null, null, "Non"],
    ["2", "Off hours", null, null, null, 0],
    ["3", "Support", null, null, null, 0],
    ["T", "Regular", " Billet #101 -  Login ", null, null, 2.5],
    ["T", "Regular", "Billet #102 - Old", null, null, "1,5", null, null, 0, null, null, "Oui"],
    ["T", "Regular", "Optimisation", null, null, 0, 5.75, -5.75, 0, "Oui", null, "Oui"],
    [],
  ]));

  assert.deepEqual(result, {
    projects: [
      {
        status: "active",
        tasks: [
          { name: "Optimisation", billable: false },
          { name: "Billet #101 - Login", billable: true, budgetMs: 9_000_000 },
          { name: "Billet #102 - Old", status: "archived", billable: true, budgetMs: 5_400_000 },
        ],
      },
    ],
  });
});

test("keeps the open task when a closed one has the same name", async () => {
  const result = await importProjects(projectPlan([
    ["1", "Support"],
    ["T", "Regular", "Optimisation", null, null, 0, null, null, 0, null, null, "Oui"],
    ["T", "Regular", "optimisation", null, null, 3],
  ]));

  assert.deepEqual(result.projects[0].tasks, [{ name: "optimisation", billable: true, budgetMs: 10_800_000 }]);
});

test("names the row and column of a value it can't read, but not the value", async () => {
  await assert.rejects(
    importProjects(projectPlan([["1", "Support"], ["T", "Regular", "Billet", null, null, 0, null, null, 0, "Client secret"]])),
    { message: 'Row 3 is invalid. "Non facturable" must be Oui or Non.' },
  );
  await assert.rejects(
    importProjects(projectPlan([["1", "Support"], ["T", "Regular", "Billet", null, null, "Client secret"]])),
    { message: 'Row 3 is invalid. "Heures estimatives" must be a number of hours.' },
  );
  await assert.rejects(
    importProjects(projectPlan([["Client secret", "Support"]])),
    { message: 'Row 2 is invalid. "Numéro" must be a phase number or T.' },
  );
});

test("refuses a file that is not a Workday export", async () => {
  await assert.rejects(
    importProjects([{ name: "Projects", rows: [["project", "task"], ["Acme", "Build"]] }]),
    /not a Workday project export or project plan/,
  );
});
