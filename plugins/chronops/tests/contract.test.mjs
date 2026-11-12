import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { startFakeMinehunter } from "../contract/fake-minehunter.mjs";

// The contract between the chronops plugin and MineHunter's
// GET /integration/snapshot route. Ajour never sees it.

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
  assert.equal(fixture.version, 3);
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
  // A lead's budget and none, and an adjustment each way.
  assert.ok(tasks.some((task) => task.budgetHours !== null) && tasks.some((task) => task.budgetHours === null));
  assert.ok(tasks.some((task) => task.workedHoursAdjustment > 0) && tasks.some((task) => task.workedHoursAdjustment < 0));
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
  for (const path of ["/integration/me", "/integration/snapshot"]) {
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
  const response = await fetch(`${fake.url}/integration/snapshot`, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  const etag = response.headers.get("etag");
  assert.match(etag, /^"[^"]+"$/);
  assert.deepEqual(await response.json(), await readJson("fixture.json"));
});

test("the fake answers 304 to a matching If-None-Match", async (t) => {
  const fake = await withFake(t);
  const first = await fetch(`${fake.url}/integration/snapshot`, { headers });
  const etag = first.headers.get("etag");

  const unchanged = await fetch(`${fake.url}/integration/snapshot`, { headers: { ...headers, "If-None-Match": etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get("etag"), etag);
  assert.equal(await unchanged.text(), "");

  const stale = await fetch(`${fake.url}/integration/snapshot`, { headers: { ...headers, "If-None-Match": '"stale"' } });
  assert.equal(stale.status, 200);
});

test("the fake refuses an expired token with 401, as the Forwarder does", async (t) => {
  const expired = await withFake(t, { expiresAt: "2026-01-01T00:00:00.000Z" });
  for (const path of ["/integration/me", "/integration/snapshot"]) {
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

  // Past the scope check, the timer start refuses the missing body.
  const readWrite = await withFake(t, { scope: "read-write" });
  const allowed = await fetch(`${readWrite.url}/integration/entries/timer/start`, { method: "POST", headers });
  assert.equal(allowed.status, 400);
  assert.deepEqual(await allowed.json(), { error: "invalid timer payload" });
});

// The fake's Time Entry routes follow MineHunter's rules from its branch
// feat/chronops-time-entry-client-ref (plugins/chronops/pkg/timetracking/
// entries.go and integration.go), so the plugin's tests meet the same answers.

/** Sends a JSON request to the fake with the read-write headers. */
async function call(fake, method, path, body, extraHeaders = {}) {
  const response = await fetch(`${fake.url}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

test("the fake refuses a request without X-ChronOps-Source with 400, as the Forwarder does", async (t) => {
  const fake = await withFake(t);
  const response = await fetch(`${fake.url}/integration/me`, { headers: { "X-ChronOps-Token": "fake-token" } });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "X-ChronOps-Source must be azure_devops or ajour" });
});

test("the fake adds an entry once per client reference and source, and answers a repeat with 200 unchanged", async (t) => {
  const fake = await withFake(t, { scope: "read-write" });
  const startedAt = minutesAgo(120);
  const added = await call(fake, "POST", "/integration/entries", { workdayProject: "ACME-SUP", task: " Login ", startedAt, minutes: 90, clientRef: "key-1" });
  assert.equal(added.status, 201);
  assert.equal(added.body.task, "Login");
  assert.equal(added.body.minutes, 90);
  assert.equal(added.body.clientRef, "key-1");
  assert.equal(added.body.source, "ajour");
  assert.equal(added.body.endedAt, new Date(Date.parse(startedAt) + 90 * 60_000).toISOString());
  assert.match(added.body.updatedAt, /Z$/);

  // The repeat ignores its body, even a start too far in the future.
  const repeat = await call(fake, "POST", "/integration/entries", { workdayProject: "OTHER", task: "Other", startedAt: minutesAgo(-60), minutes: 5, clientRef: "key-1" });
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.body, added.body);

  // Another source keeps its own references.
  const devops = await call(fake, "POST", "/integration/entries", { workdayProject: "ACME-SUP", task: "Login", startedAt, minutes: 90, clientRef: "key-1" }, { "X-ChronOps-Source": "azure_devops" });
  assert.equal(devops.status, 201);
  assert.equal(fake.entries().length, 2);
});

test("the fake refuses an invalid entry with 400 and MineHunter's message", async (t) => {
  const fake = await withFake(t, { scope: "read-write" });
  const valid = { workdayProject: "ACME-SUP", task: "Login", startedAt: minutesAgo(60), minutes: 30 };
  for (const [body, error] of [
    [{ ...valid, minutes: 1441 }, "minutes must be between 1 and 1440"],
    [{ ...valid, minutes: 0 }, "minutes must be between 1 and 1440"],
    [{ ...valid, task: "x".repeat(201) }, "the task must be 1 to 200 characters"],
    [{ ...valid, workdayProject: " ACME" }, "invalid Workday Project code"],
    [{ ...valid, startedAt: minutesAgo(-11) }, "startedAt is required and cannot be in the future"],
    [{ ...valid, note: "private" }, "invalid entry payload"],
  ]) {
    assert.deepEqual(await call(fake, "POST", "/integration/entries", body), { status: 400, body: { error } }, error);
  }
});

test("the fake edits an entry: moving the start keeps the length, minutes changes it", async (t) => {
  const fake = await withFake(t, { scope: "read-write" });
  const { body: entry } = await call(fake, "POST", "/integration/entries", { workdayProject: "ACME-SUP", task: "Login", startedAt: minutesAgo(600), minutes: 60 });

  const moved = await call(fake, "PATCH", `/integration/entries/${entry.id}`, { startedAt: minutesAgo(300) });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.minutes, 60);
  assert.ok(Date.parse(moved.body.updatedAt) >= Date.parse(entry.updatedAt));

  const longer = await call(fake, "PATCH", `/integration/entries/${entry.id}`, { minutes: 75, task: "Export", workdayProject: "GLOBEX-INT" });
  assert.deepEqual([longer.body.minutes, longer.body.task, longer.body.workdayProject, longer.body.startedAt], [75, "Export", "GLOBEX-INT", moved.body.startedAt]);

  assert.deepEqual(await call(fake, "PATCH", `/integration/entries/${entry.id}`, { startedAt: minutesAgo(-1) }), {
    status: 400,
    body: { error: "startedAt must be set and cannot be in the future" },
  });
  assert.deepEqual(await call(fake, "PATCH", `/integration/entries/${entry.id}`, { clientRef: "new" }), { status: 400, body: { error: "invalid entry payload" } });
  assert.deepEqual(await call(fake, "PATCH", "/integration/entries/7d3c5bb4-0000-4000-8000-000000000000", { minutes: 5 }), {
    status: 404,
    body: { error: "entry not found" },
  });
});

test("the fake deletes an entry for good, which frees its client reference", async (t) => {
  const fake = await withFake(t, { scope: "read-write" });
  const body = { workdayProject: "ACME-SUP", task: "Login", startedAt: minutesAgo(60), minutes: 30, clientRef: "key-1" };
  const { body: entry } = await call(fake, "POST", "/integration/entries", body);

  assert.deepEqual(await call(fake, "DELETE", `/integration/entries/${entry.id}`), { status: 204, body: undefined });
  assert.deepEqual(await call(fake, "DELETE", `/integration/entries/${entry.id}`), { status: 404, body: { error: "entry not found" } });
  assert.equal((await call(fake, "POST", "/integration/entries", body)).status, 201);
});

test("the fake lists entries started in [from, to), newest first, and the running timer wherever it started", async (t) => {
  const day = (date, time) => `${date}T${time}:00.000Z`;
  const entry = (id, startedAt, endedAt) => ({
    id, ownerEmail: "marie.tremblay@example.com", workdayProject: "ACME-SUP", task: "Login", description: "",
    startedAt, endedAt, source: "grafana", workItem: null, clientRef: null, updatedAt: startedAt,
  });
  const fake = await withFake(t, {
    entries: [
      entry("a", day("2026-11-02", "13:00"), day("2026-11-02", "14:00")),
      entry("b", day("2026-11-03", "13:00"), day("2026-11-03", "13:30")),
      entry("c", day("2026-11-09", "13:00"), day("2026-11-09", "14:00")),
      entry("running", day("2026-10-01", "13:00"), null),
    ],
  });
  const listed = await call(fake, "GET", `/integration/entries?from=${day("2026-11-02", "05:00")}&to=${day("2026-11-09", "05:00")}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map((item) => [item.id, item.minutes]), [["b", 30], ["a", 60], ["running", null]]);

  const tooLong = await call(fake, "GET", `/integration/entries?from=${day("2026-01-01", "05:00")}&to=${day("2026-04-05", "05:00")}`);
  assert.deepEqual(tooLong, { status: 400, body: { error: "to must be after from, at most 93 days later" } });
});

test("the fake starts a timer, stops the one that runs at that instant, and answers a repeated client reference without stopping anything", async (t) => {
  const fake = await withFake(t, { scope: "read-write" });
  const devopsStart = minutesAgo(9);
  const devops = await call(fake, "POST", "/integration/entries/timer/start", { workdayProject: "ACME-SUP", task: "Export", startedAt: devopsStart }, { "X-ChronOps-Source": "azure_devops" });
  assert.equal(devops.status, 200);
  assert.equal(devops.body.stopped, null);
  assert.deepEqual([devops.body.timer.startedAt, devops.body.timer.endedAt, devops.body.timer.minutes], [devopsStart, null, null]);

  // One timer per person: Ajour's start stops the extension's at the instant it starts.
  const startedAt = minutesAgo(4);
  const mine = await call(fake, "POST", "/integration/entries/timer/start", { workdayProject: "ACME-SUP", task: "Login", startedAt, clientRef: "key-1" });
  assert.equal(mine.status, 200);
  assert.deepEqual([mine.body.timer.clientRef, mine.body.timer.startedAt, mine.body.timer.endedAt], ["key-1", startedAt, null]);
  assert.deepEqual([mine.body.stopped.id, mine.body.stopped.endedAt, mine.body.stopped.minutes], [devops.body.timer.id, startedAt, 5]);

  // A repeat answers the entry the key made, as it is now, and stops nothing,
  // not even the timer another start made since. It ignores its body.
  const other = await call(fake, "POST", "/integration/entries/timer/start", { workdayProject: "ACME-SUP", task: "Export" }, { "X-ChronOps-Source": "azure_devops" });
  const repeat = await call(fake, "POST", "/integration/entries/timer/start", { workdayProject: "OTHER", task: "Other", startedAt: minutesAgo(60), clientRef: "key-1" });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.stopped, null);
  assert.deepEqual([repeat.body.timer.id, repeat.body.timer.task, repeat.body.timer.minutes], [mine.body.timer.id, "Login", 4]);
  assert.equal(fake.entries().find((entry) => entry.id === other.body.timer.id).endedAt, null);

  for (const [body, error] of [
    [{ workdayProject: "ACME-SUP", task: "Login", startedAt: minutesAgo(11) }, "the start or stop instant must be within 10 minutes of now"],
    [{ workdayProject: "ACME-SUP", task: "Login", minutes: 5 }, "invalid timer payload"],
    [{ workdayProject: "ACME-SUP", task: "" }, "the task must be 1 to 200 characters"],
  ]) {
    assert.deepEqual(await call(fake, "POST", "/integration/entries/timer/start", body), { status: 400, body: { error } }, error);
  }
});

test("the fake stops one entry by id: 409 once it no longer runs, 404 once it is gone", async (t) => {
  const fake = await withFake(t, { scope: "read-write" });
  const { body: started } = await call(fake, "POST", "/integration/entries/timer/start", { workdayProject: "ACME-SUP", task: "Login", startedAt: minutesAgo(9), clientRef: "key-1" });
  const path = `/integration/entries/${started.timer.id}/stop`;

  assert.deepEqual(await call(fake, "POST", path, { endedAt: minutesAgo(11) }), {
    status: 400,
    body: { error: "the start or stop instant must be within 10 minutes of now" },
  });
  const endedAt = minutesAgo(2);
  const stopped = await call(fake, "POST", path, { endedAt });
  assert.equal(stopped.status, 200);
  assert.deepEqual([stopped.body.endedAt, stopped.body.minutes, stopped.body.clientRef], [endedAt, 7, "key-1"]);

  assert.deepEqual(await call(fake, "POST", path), { status: 409, body: { error: "this entry is not running" } });
  await call(fake, "DELETE", `/integration/entries/${started.timer.id}`);
  assert.deepEqual(await call(fake, "POST", path), { status: 404, body: { error: "entry not found" } });
  assert.deepEqual(await call(fake, "POST", "/integration/entries/not-an-id/stop"), { status: 400, body: { error: "invalid entry ID" } });
});

test("the fake limits requests like the Forwarder when asked, with 429", async (t) => {
  const fake = await withFake(t, { rateLimit: { perSecond: 10, burst: 3 } });
  const statuses = [];
  for (let index = 0; index < 4; index += 1) statuses.push((await call(fake, "GET", "/integration/me")).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});
