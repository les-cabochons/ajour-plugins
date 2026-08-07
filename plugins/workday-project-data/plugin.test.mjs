import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { exportProjects, importProjects } from "./src/plugin.mjs";

test("declares the HarDay project data shape API v1 contract", async () => {
  const manifest = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "workday-project-data");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.entrypoint, "dist/plugin.mjs");
  assert.deepEqual(manifest.capabilities.projectDataShape.datasets[0].columns.map(({ key, header }) => [key, header]), [
    ["project", "project"], ["code", "code"], ["color", "color"], ["status", "status"], ["task", "task"], ["taskStatus", "task_status"], ["billable", "billable"], ["budgetHours", "budget_hours"], ["adjustmentHours", "adjustment_hours"],
  ]);
});

test("exports the Workday-compatible row shape", async () => {
  const result = await exportProjects([{ name: "Mercury", code: "MER", color: "#123456", status: "active", tasks: [{ name: "Feature Work", status: "active", billable: true, budgetMs: 7_200_000, adjustmentMs: -1_800_000 }] }]);
  assert.deepEqual(result.datasets[0].rows[0], { project: "Mercury", code: "MER", color: "#123456", status: "active", task: "Feature Work", taskStatus: "active", billable: "billable", budgetHours: 2, adjustmentHours: -0.5 });
});

test("imports Workday rows into canonical projects", async () => {
  const result = await importProjects([{ id: "projects", rows: [{ project: "Mercury", code: "MER", color: "#123456", status: "active", task: "Feature Work", taskStatus: "archived", billable: "non_billable", budgetHours: "2,5", adjustmentHours: -0.5 }] }]);
  assert.deepEqual(result.projects[0], { name: "Mercury", code: "MER", color: "#123456", status: "active", tasks: [{ name: "Feature Work", status: "archived", billable: false, budgetMs: 9_000_000, adjustmentMs: -1_800_000 }] });
});

test("preserves blank-row, nonpositive-budget, and overflow compatibility", async () => {
  const result = await importProjects([{ id: "projects", rows: [
    { project: null },
    { project: "Mercury", task: "Negative", budgetHours: -1 },
    { project: "Mercury", task: "Overflow", budgetHours: 1e308, adjustmentHours: -1e308 },
  ] }]);
  assert.deepEqual(result.projects.map((project) => project.tasks[0]), [{ name: "Negative" }, { name: "Overflow" }]);
});
