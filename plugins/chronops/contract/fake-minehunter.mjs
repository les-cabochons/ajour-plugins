// A stand-in for MineHunter's Forwarder, for the chronops plugin's tests and
// for trying the plugin against Ajour without MineHunter.
//
//   node contract/fake-minehunter.mjs [--port 8787] [--scope read|read-write] [--expires-at <ISO date>]
//
// It serves these routes, as MineHunter does:
// - GET /integration/me, the token's user, with the scope and expiry chosen
//   above, so the plugin can test its warnings.
// - GET /integration/snapshot, fixture.json as is, with an ETag, and
//   304 when If-None-Match matches.
// - The Time Entry routes, on entries kept in memory: GET, POST
//   /integration/entries, and PATCH, DELETE /integration/entries/{id}, with
//   MineHunter's validation and messages, client references unique per
//   source, `updatedAt`, and hard deletes. See the contract tests.
// Every request needs X-ChronOps-Source, ajour or azure_devops, or gets 400,
// and X-ChronOps-Token, any value, or gets 401, as does one once the chosen
// expiry is past. A read token gets 403 on anything but GET, so an
// integration can test the Forwarder's scope refusal. The real Forwarder
// limits each address to 10 requests a second with a burst of 20; this fake
// does only when its `rateLimit` option asks. It has no running timer route:
// a running entry comes only from the `entries` option.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SCOPES = ["read", "read-write"];
const SOURCES = ["azure_devops", "ajour"];

// MineHunter's bounds, from entries.go.
const MAX_TASK = 200;
const MAX_DESCRIPTION = 1000;
const MAX_CLIENT_REF = 200;
const MAX_MINUTES = 24 * 60;
const MAX_LIST_RANGE = 93 * 24 * 60 * 60_000;
const DEFAULT_LIST_RANGE = 31 * 24 * 60 * 60_000;
const MAX_LISTED = 2000;
const CLOCK_SKEW = 10 * 60_000;

/**
 * A Time Entry as MineHunter answers it, without `minutes`, which the fake
 * computes. Instants are ISO 8601; `endedAt` is null while it runs.
 * @typedef {{
 *   id: string, ownerEmail: string, workdayProject: string, task: string,
 *   description: string, startedAt: string, endedAt: string | null,
 *   source: string, workItem: null | { org: string, project: string, id: number },
 *   clientRef: string | null, updatedAt: string,
 * }} FakeEntry
 */

/** A refusal: the status and MineHunter's message. */
class Refusal extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const refuse = (message) => {
  throw new Refusal(400, message);
};

const isControl = (text) => /[\u0000-\u001f\u007f]/.test(text);
const isInstant = (text) =>
  typeof text === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) &&
  !Number.isNaN(Date.parse(text));
const validCode = (code) =>
  typeof code === "string" && code !== "" && code === code.trim() && code.length <= 1024 && code !== "." && code !== ".." && !isControl(code);
const validReference = (value, max) =>
  value !== "" && value === value.trim() && Buffer.byteLength(value) <= max && !isControl(value);

/** Reads a JSON body with only the fields `allowed`, as Go's DisallowUnknownFields does. */
function strictBody(text, allowed, types) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse("invalid entry payload");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) refuse("invalid entry payload");
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) refuse("invalid entry payload");
    // Go refuses a value of the wrong type, and a null leaves the field unset.
    if (value !== null && !types[key](value)) refuse("invalid entry payload");
  }
  return body;
}

const fieldTypes = {
  workdayProject: (value) => typeof value === "string",
  task: (value) => typeof value === "string",
  description: (value) => typeof value === "string",
  workItem: (value) => typeof value === "object",
  clientRef: (value) => typeof value === "string",
  startedAt: isInstant,
  minutes: (value) => Number.isInteger(value),
};

/** entryFields.validate: trims the task and description, and checks every field. */
function validateFields(fields) {
  const task = (fields.task ?? "").trim();
  const description = (fields.description ?? "").trim();
  if (!validCode(fields.workdayProject)) refuse("invalid Workday Project code");
  if (task === "" || [...task].length > MAX_TASK || isControl(task)) refuse("the task must be 1 to 200 characters");
  if ([...description].length > MAX_DESCRIPTION) refuse("the description must be at most 1000 characters");
  if (fields.clientRef && !validReference(fields.clientRef, MAX_CLIENT_REF)) {
    refuse("clientRef must be 1 to 200 bytes, without surrounding spaces or control characters");
  }
  return { task, description };
}

/**
 * Starts the fake on `port` (0 picks a free one) and resolves with its URL,
 * the entries it holds, and a `close` function. `entries` seeds the Time
 * Entries, all the token owner's. `rateLimit` turns on the Forwarder's limit.
 * @param {{
 *   port?: number, scope?: "read" | "read-write", expiresAt?: string | null,
 *   entries?: FakeEntry[], rateLimit?: { perSecond: number, burst: number },
 * }} [options]
 * @returns {Promise<{ url: string, entries: () => FakeEntry[], close: () => Promise<void> }>}
 */
export async function startFakeMinehunter({ port = 0, scope = "read", expiresAt = null, entries: seed = [], rateLimit } = {}) {
  if (!SCOPES.includes(scope)) {
    throw new Error(`scope must be one of ${SCOPES.join(", ")}, not ${JSON.stringify(scope)}.`);
  }
  const snapshot = readFileSync(new URL("./fixture.json", import.meta.url), "utf8");
  // A strong ETag from the fixture's bytes. It changes when the fixture does.
  const etag = `"${createHash("sha256").update(snapshot).digest("hex").slice(0, 32)}"`;
  const email = JSON.parse(snapshot).me.email;
  const me = JSON.stringify({ email, login: email.split("@")[0], scope, expiresAt });

  /** The Time Entries by id, instants as milliseconds. */
  const stored = new Map(
    seed.map((entry) => [
      entry.id,
      {
        ...entry,
        startedAt: Date.parse(entry.startedAt),
        endedAt: entry.endedAt === null ? null : Date.parse(entry.endedAt),
        updatedAt: Date.parse(entry.updatedAt),
      },
    ]),
  );

  /** An entry as MineHunter answers it: minutes is the span rounded to the minute, null while it runs. */
  const answer = (entry) => ({
    id: entry.id,
    ownerEmail: entry.ownerEmail,
    workdayProject: entry.workdayProject,
    task: entry.task,
    description: entry.description,
    startedAt: new Date(entry.startedAt).toISOString(),
    endedAt: entry.endedAt === null ? null : new Date(entry.endedAt).toISOString(),
    minutes: entry.endedAt === null ? null : Math.round((entry.endedAt - entry.startedAt) / 60_000),
    source: entry.source,
    workItem: entry.workItem,
    clientRef: entry.clientRef,
    updatedAt: new Date(entry.updatedAt).toISOString(),
  });

  // The Forwarder's token bucket, per fake rather than per address.
  let tokens = rateLimit?.burst ?? 0;
  let refilledAt = performance.now();
  const limited = () => {
    if (!rateLimit) return false;
    const now = performance.now();
    tokens = Math.min(rateLimit.burst, tokens + ((now - refilledAt) / 1000) * rateLimit.perSecond);
    refilledAt = now;
    if (tokens < 1) return true;
    tokens -= 1;
    return false;
  };

  /** GET /integration/entries: the owner's entries started in [from, to), and the running one wherever it started. */
  function listEntries(query) {
    const now = Date.now();
    let to = now + 24 * 60 * 60_000;
    let from = to - DEFAULT_LIST_RANGE;
    for (const name of ["from", "to"]) {
      const raw = query.get(name);
      if (!raw) continue;
      if (!isInstant(raw)) refuse("from and to must be RFC 3339 instants");
      if (name === "from") from = Date.parse(raw);
      else to = Date.parse(raw);
    }
    if (to <= from || to - from > MAX_LIST_RANGE) refuse("to must be after from, at most 93 days later");
    return [...stored.values()]
      .filter((entry) => (entry.startedAt >= from && entry.startedAt < to) || entry.endedAt === null)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_LISTED)
      .map(answer);
  }

  /** POST /integration/entries: 201 with a new entry, or 200 with the one a repeated client reference made. */
  function addEntry(text, source) {
    const body = strictBody(text, ["workdayProject", "task", "description", "workItem", "clientRef", "startedAt", "minutes"], fieldTypes);
    const { task, description } = validateFields(body);
    if (body.clientRef) {
      const repeat = [...stored.values()].find((entry) => entry.source === source && entry.clientRef === body.clientRef);
      if (repeat) return [200, answer(repeat)];
    }
    const now = Date.now();
    if (body.startedAt == null || Date.parse(body.startedAt) > now + CLOCK_SKEW) refuse("startedAt is required and cannot be in the future");
    if (!Number.isInteger(body.minutes) || body.minutes < 1 || body.minutes > MAX_MINUTES) refuse("minutes must be between 1 and 1440");
    const startedAt = Date.parse(body.startedAt);
    const entry = {
      id: randomUUID(),
      ownerEmail: email,
      workdayProject: body.workdayProject,
      task,
      description,
      startedAt,
      endedAt: startedAt + body.minutes * 60_000,
      source,
      workItem: body.workItem ?? null,
      clientRef: body.clientRef || null,
      updatedAt: now,
    };
    stored.set(entry.id, entry);
    return [201, answer(entry)];
  }

  function ownEntry(id) {
    const entry = stored.get(id);
    if (!entry) throw new Refusal(404, "entry not found");
    return entry;
  }

  /** PATCH /integration/entries/{id}: moving the start keeps the length; minutes replaces it. */
  function updateEntry(id, text) {
    const body = strictBody(text, ["workdayProject", "task", "description", "startedAt", "minutes"], fieldTypes);
    const before = ownEntry(id);
    const after = {
      ...before,
      workdayProject: body.workdayProject ?? before.workdayProject,
      task: body.task ?? before.task,
      description: body.description ?? before.description,
    };
    Object.assign(after, validateFields(after));
    if (body.startedAt != null) {
      after.startedAt = Date.parse(body.startedAt);
      if (after.startedAt > Date.now()) refuse("startedAt must be set and cannot be in the future");
    }
    if (before.endedAt === null && body.minutes != null) refuse("a running timer has no length yet, stop it first");
    if (before.endedAt !== null) {
      let length = before.endedAt - before.startedAt;
      if (body.minutes != null) {
        if (body.minutes < 1 || body.minutes > MAX_MINUTES) refuse("minutes must be between 1 and 1440");
        length = body.minutes * 60_000;
      }
      after.endedAt = after.startedAt + length;
    }
    after.updatedAt = Date.now();
    stored.set(id, after);
    return answer(after);
  }

  /** Answers one request, or throws a Refusal. */
  function route(request, path, query, text) {
    const method = request.method;
    const source = request.headers["x-chronops-source"];
    if (method === "GET" && path === "/integration/me") return [200, me];
    if (method === "GET" && path === "/integration/entries") return [200, listEntries(query)];
    if (method === "POST" && path === "/integration/entries") return addEntry(text, source);
    const id = /^\/integration\/entries\/([^/]+)$/.exec(path)?.[1];
    if (id !== undefined && (method === "PATCH" || method === "DELETE")) {
      // MineHunter's ids are UUIDs: anything else is refused before the lookup.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) && !stored.has(id)) refuse("invalid entry ID");
      if (method === "PATCH") return [200, updateEntry(id, text)];
      ownEntry(id);
      stored.delete(id);
      return [204, undefined];
    }
    throw new Refusal(404, "not found");
  }

  const server = createServer((request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
      response.end(body);
    };
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;

    // The same statuses and bodies as the real Forwarder and ChronOps.
    if (limited()) {
      send(429, JSON.stringify({ error: "too many requests" }));
    } else if (!SOURCES.includes(request.headers["x-chronops-source"])) {
      send(400, JSON.stringify({ error: "X-ChronOps-Source must be azure_devops or ajour" }));
    } else if (request.headers["x-chronops-token"] === undefined) {
      send(401, JSON.stringify({ error: "a personal token is required" }));
    } else if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
      send(401, JSON.stringify({ error: "expired personal token" }));
    } else if (request.method !== "GET" && scope === "read") {
      send(403, JSON.stringify({ error: "this personal token only reads" }));
    } else if (request.method === "GET" && path === "/integration/snapshot") {
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { ETag: etag });
        response.end();
      } else {
        send(200, snapshot, { ETag: etag });
      }
    } else {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        try {
          const [status, body] = route(request, path, url.searchParams, Buffer.concat(chunks).toString("utf8"));
          if (body === undefined) {
            response.writeHead(status);
            response.end();
          } else {
            send(status, typeof body === "string" ? body : JSON.stringify(body));
          }
        } catch (error) {
          if (!(error instanceof Refusal)) throw error;
          send(error.status, JSON.stringify({ error: error.message }));
        }
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const { port: boundPort } = server.address();
  return {
    url: `http://127.0.0.1:${boundPort}`,
    entries: () => [...stored.values()].map(answer),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "8787" },
      scope: { type: "string", default: "read" },
      "expires-at": { type: "string" },
    },
  });
  const fake = await startFakeMinehunter({
    port: Number(values.port),
    scope: values.scope,
    expiresAt: values["expires-at"] ?? null,
  });
  console.log(`Fake MineHunter at ${fake.url} (scope ${values.scope}, expires ${values["expires-at"] ?? "never"}). Ctrl+C stops it.`);
}
