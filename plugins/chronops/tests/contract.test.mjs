import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { startFakeMinehunter } from "../contract/fake-minehunter.mjs";

// The contract between the chronops plugin and MineHunter's
// GET /integration/ajour/snapshot route. Ajour never sees it.

const contract = new URL("../contract/", import.meta.url);

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, contract), "utf8"));
}

test("the fixture validates against the snapshot schema", async () => {
  const schema = await readJson("snapshot.schema.json");
  const fixture = await readJson("fixture.json");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  assert.equal(validate(fixture), true, ajv.errorsText(validate.errors, { separator: "\n" }));
  assert.equal(fixture.version, 2);
  assert.equal(fixture.me.workerLinked, true);
  // Both budget modes, a project without a cap, assigned and unassigned
  // tasks, a closed task, and a project whose completion is unknown.
  const modes = new Set(fixture.projects.map((project) => project.budget.mode));
  assert.deepEqual([...modes].sort(), ["annual", "monthly"]);
  const uncapped = fixture.projects.find((project) => project.budget.capHours === null);
  assert.equal(uncapped?.budget.status, "Unconfigured");
  assert.equal(uncapped?.budget.remainingHours, null);
  assert.ok(fixture.projects.some((project) => project.complete === null));
  const tasks = fixture.projects.flatMap((project) => project.tasks);
  assert.ok(tasks.some((task) => task.assignedToMe) && tasks.some((task) => !task.assignedToMe));
  assert.ok(tasks.some((task) => task.closed));
});

test("the schema rejects a snapshot of another version or with an unknown field", async () => {
  const schema = await readJson("snapshot.schema.json");
  const fixture = await readJson("fixture.json");
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  assert.equal(validate({ ...fixture, version: 1 }), false);
  assert.equal(validate({ ...fixture, extra: true }), false);
  const [project] = fixture.projects;
  assert.equal(validate({ ...fixture, projects: [{ ...project, budget: { ...project.budget, status: "Blue" } }] }), false);
});

/** Starts the fake on a free port and stops it when the test ends. */
async function withFake(t, options) {
  const fake = await startFakeMinehunter({ port: 0, ...options });
  t.after(() => fake.close());
  return fake;
}

const headers = { "X-ChronOps-Token": "fake-token", "X-ChronOps-Source": "ajour" };

test("the fake refuses a request without X-ChronOps-Token with 401", async (t) => {
  const fake = await withFake(t);
  for (const path of ["/integration/me", "/integration/ajour/snapshot"]) {
    const response = await fetch(`${fake.url}${path}`, { headers: { "X-ChronOps-Source": "ajour" } });
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: "a personal token is required" });
  }
});

test("the fake serves /integration/me with the chosen scope and expiry", async (t) => {
  const byDefault = await withFake(t);
  const defaults = await (await fetch(`${byDefault.url}/integration/me`, { headers })).json();
  assert.deepEqual(defaults, { email: "marie.tremblay@example.com", login: "marie.tremblay", scope: "read", expiresAt: null });

  // The fake refuses an expired token, so the expiry is a month from now, not a fixed date.
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const chosen = await withFake(t, { scope: "read-write", expiresAt });
  const me = await (await fetch(`${chosen.url}/integration/me`, { headers })).json();
  assert.equal(me.scope, "read-write");
  assert.equal(me.expiresAt, expiresAt);
});

test("the fake serves the fixture as the snapshot, with an ETag", async (t) => {
  const fake = await withFake(t);
  const response = await fetch(`${fake.url}/integration/ajour/snapshot`, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  const etag = response.headers.get("etag");
  assert.match(etag, /^"[^"]+"$/);
  assert.deepEqual(await response.json(), await readJson("fixture.json"));
});

test("the fake answers 304 to a matching If-None-Match", async (t) => {
  const fake = await withFake(t);
  const first = await fetch(`${fake.url}/integration/ajour/snapshot`, { headers });
  const etag = first.headers.get("etag");

  const unchanged = await fetch(`${fake.url}/integration/ajour/snapshot`, { headers: { ...headers, "If-None-Match": etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get("etag"), etag);
  assert.equal(await unchanged.text(), "");

  const stale = await fetch(`${fake.url}/integration/ajour/snapshot`, { headers: { ...headers, "If-None-Match": '"stale"' } });
  assert.equal(stale.status, 200);
});

test("the fake refuses an expired token with 401, as the Forwarder does", async (t) => {
  const expired = await withFake(t, { expiresAt: "2026-01-01T00:00:00.000Z" });
  for (const path of ["/integration/me", "/integration/ajour/snapshot"]) {
    const response = await fetch(`${expired.url}${path}`, { headers });
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: "expired personal token" });
  }

  const alive = await withFake(t, { expiresAt: "2999-01-01T00:00:00.000Z" });
  assert.equal((await fetch(`${alive.url}/integration/me`, { headers })).status, 200);
});

test("the fake refuses a write with a read token with 403, and passes the scope check with a read-write token", async (t) => {
  const read = await withFake(t);
  const refused = await fetch(`${read.url}/integration/entries/timer/start`, { method: "POST", headers });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "this personal token only reads" });

  const readWrite = await withFake(t, { scope: "read-write" });
  const allowed = await fetch(`${readWrite.url}/integration/entries/timer/start`, { method: "POST", headers });
  assert.equal(allowed.status, 404);
});
