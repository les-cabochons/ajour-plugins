import type { TimeSyncChange, TimeSyncEntryValues, TimeSyncRequest } from "@ajour/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeMinehunter } from "../contract/fake-minehunter.mjs";
import { syncTimeEntries } from "../src/plugin.ts";
import { answer, connection, createFakeAjour, forwardTo, requestError, type Responder } from "./fake-ajour.ts";

// Thursday November 12, 2026, 13:00 in Toronto, which is UTC-5 then.
const NOW = "2026-11-12T18:00:00.000Z";
const ZONE = "America/Toronto";
/** The window Ajour sends: the current week and the 4 before it. */
const WINDOW = { from: "2026-10-12", to: "2026-11-12", timeZone: ZONE };
const OWNER = "marie.tremblay@example.com";
const MISSING_ID = "7d3c5bb4-0000-4000-8000-000000000000";

/** A Time Entry as the fake MineHunter takes it, without minutes. */
interface FakeEntry {
  id: string;
  ownerEmail: string;
  workdayProject: string;
  task: string;
  description: string;
  startedAt: string;
  endedAt: string | null;
  source: string;
  workItem: null;
  clientRef: string | null;
  updatedAt: string;
}

/** Ajour's values for an entry, Tuesday's 90 minutes on a support ticket unless overridden. */
function values(overrides: Partial<TimeSyncEntryValues> = {}): TimeSyncEntryValues {
  return {
    localDate: "2026-11-10",
    minutes: 90,
    running: false,
    projectRemoteId: "ACME-SUP",
    taskName: "Billet #101 - Login",
    taskRemoteId: "1001",
    ...overrides,
  };
}

function upsert(syncKey: string, entryValues: TimeSyncEntryValues, extra: Partial<TimeSyncChange> = {}): TimeSyncChange {
  return { kind: "upsert", syncKey, values: entryValues, ...extra } as TimeSyncChange;
}

let lastId = 0;
/** A Time Entry ChronOps already holds, finished, made by Ajour unless overridden. */
function held(overrides: Partial<FakeEntry> & { startedAt: string; minutes?: number }): FakeEntry {
  const { minutes = 90, ...entry } = overrides;
  lastId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(lastId).padStart(12, "0")}`,
    ownerEmail: OWNER,
    workdayProject: "ACME-SUP",
    task: "Billet #101 - Login",
    description: "Private words",
    endedAt: new Date(Date.parse(entry.startedAt) + minutes * 60_000).toISOString(),
    source: "ajour",
    workItem: null,
    clientRef: null,
    updatedAt: "2026-11-10T20:00:00.000Z",
    ...entry,
  };
}

let fake: Awaited<ReturnType<typeof startFakeMinehunter>> | undefined;

/** Starts a fake MineHunter with a read-write token and installs a test `ajour` that forwards to it. */
async function withFake(options: Parameters<typeof startFakeMinehunter>[0] = {}, wrap?: (forward: Responder) => Responder) {
  fake = await startFakeMinehunter({ port: 0, scope: "read-write", ...options });
  const forward = forwardTo(fake.url);
  const ajour = createFakeAjour(wrap ? wrap(forward) : forward);
  vi.stubGlobal("ajour", ajour);
  return { ajour, fake };
}

function request(changes: TimeSyncChange[]): TimeSyncRequest {
  return { ...WINDOW, changes };
}

beforeEach(() => {
  // Only Date is fake, so the fake server, fetch and the pacer's waits keep real timers.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
});

afterEach(async () => {
  await fake?.close();
  fake = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const JSON_HEADERS = { "x-chronops-source": "ajour", "content-type": "application/json" };

describe("syncTimeEntries creates", () => {
  it("an entry with the sync key as its client reference, at 09:00 on its day where the user is", async () => {
    const { ajour, fake } = await withFake();
    const result = await syncTimeEntries(connection, request([upsert("key-1", values())]));

    const [stored] = fake.entries();
    const entry = {
      remoteId: stored!.id,
      clientRef: "key-1",
      localDate: "2026-11-10",
      minutes: 90,
      running: false,
      projectRemoteId: "ACME-SUP",
      taskName: "Billet #101 - Login",
      updatedAt: NOW,
    };
    expect(result).toEqual({ results: [{ syncKey: "key-1", status: "synced", entry }], entries: [entry] });
    expect(ajour.requests).toEqual([
      {
        method: "POST",
        path: "/integration/entries",
        headers: JSON_HEADERS,
        body: { workdayProject: "ACME-SUP", task: "Billet #101 - Login", startedAt: "2026-11-10T14:00:00.000Z", minutes: 90, clientRef: "key-1" },
      },
      {
        method: "GET",
        path: "/integration/entries",
        // Midnight in Toronto on the first day, EDT, to midnight after the last, EST.
        query: { from: "2026-10-12T04:00:00.000Z", to: "2026-11-13T05:00:00.000Z" },
        headers: { "x-chronops-source": "ajour" },
      },
    ]);
  });

  it("an entry that starts now, less a minute, when 09:00 on its day is still to come", async () => {
    vi.setSystemTime(new Date("2026-11-12T12:30:00.000Z")); // 07:30 in Toronto
    const { ajour } = await withFake();
    const result = await syncTimeEntries(connection, request([upsert("key-1", values({ localDate: "2026-11-12", minutes: 20 }))]));

    expect(ajour.requests[0]?.body).toMatchObject({ startedAt: "2026-11-12T12:29:00.000Z", minutes: 20 });
    expect(result.results[0]).toMatchObject({ status: "synced", entry: { localDate: "2026-11-12", minutes: 20 } });
  });

  it("nothing twice: a retry with the same client reference adopts the entry the lost answer created", async () => {
    const { ajour, fake } = await withFake();
    const first = await syncTimeEntries(connection, request([upsert("key-1", values())]));
    const retry = await syncTimeEntries(connection, request([upsert("key-1", values())]));

    expect(fake.entries()).toHaveLength(1);
    expect(retry.results).toEqual(first.results);
    // The retry's POST finds the entry as Ajour wants it, so no edit follows.
    expect(ajour.requests.slice(2).map((sent) => sent.method)).toEqual(["POST", "GET"]);
  });

  it("brings the entry ChronOps already holds under the key to Ajour's values, on the first round after the switch goes on", async () => {
    const earlier = held({
      clientRef: "key-1",
      workdayProject: "GLOBEX-INT",
      task: "Old name",
      startedAt: "2026-11-09T15:12:00.000Z",
      minutes: 45,
    });
    const { ajour, fake } = await withFake({ entries: [earlier] });
    const result = await syncTimeEntries(connection, request([upsert("key-1", values())]));

    expect(ajour.requests[1]).toEqual({
      method: "PATCH",
      path: `/integration/entries/${earlier.id}`,
      headers: JSON_HEADERS,
      body: { workdayProject: "ACME-SUP", task: "Billet #101 - Login", minutes: 90, startedAt: "2026-11-10T14:00:00.000Z" },
    });
    expect(result.results[0]).toEqual({
      syncKey: "key-1",
      status: "synced",
      entry: {
        remoteId: earlier.id,
        clientRef: "key-1",
        localDate: "2026-11-10",
        minutes: 90,
        running: false,
        projectRemoteId: "ACME-SUP",
        taskName: "Billet #101 - Login",
        updatedAt: NOW,
      },
    });
    expect(fake.entries()).toHaveLength(1);
  });
});

describe("syncTimeEntries edits", () => {
  // Tuesday 10:17 in Toronto: the real start a timer gave the entry.
  const realStart = "2026-11-10T15:17:00.000Z";

  it("only what changed since the values both sides agreed on, and keeps the real start", async () => {
    const entry = held({ clientRef: "key-1", startedAt: realStart });
    const { ajour, fake } = await withFake({ entries: [entry] });
    const change = upsert("key-1", values({ minutes: 120, taskName: "Billet #102 - Export CSV", taskRemoteId: "1002" }), {
      remoteId: entry.id,
      agreed: values(),
    });
    const result = await syncTimeEntries(connection, request([change]));

    expect(ajour.requests[0]).toEqual({
      method: "PATCH",
      path: `/integration/entries/${entry.id}`,
      headers: JSON_HEADERS,
      body: { task: "Billet #102 - Export CSV", minutes: 120 },
    });
    expect(fake.entries()[0]).toMatchObject({ startedAt: realStart, minutes: 120, task: "Billet #102 - Export CSV" });
    expect(result.results[0]).toMatchObject({ status: "synced", entry: { remoteId: entry.id, localDate: "2026-11-10", minutes: 120 } });
  });

  it("the start to 09:00 on the new day when the day changed, and keeps the length", async () => {
    const entry = held({ clientRef: "key-1", startedAt: realStart });
    const { ajour, fake } = await withFake({ entries: [entry] });
    const change = upsert("key-1", values({ localDate: "2026-11-11" }), { remoteId: entry.id, agreed: values() });
    await syncTimeEntries(connection, request([change]));

    expect(ajour.requests[0]?.body).toEqual({ startedAt: "2026-11-11T14:00:00.000Z" });
    expect(fake.entries()[0]).toMatchObject({ startedAt: "2026-11-11T14:00:00.000Z", minutes: 90 });
  });

  it("by creating the entry again when ChronOps answers 404", async () => {
    const { ajour, fake } = await withFake();
    const change = upsert("key-1", values({ minutes: 60 }), { remoteId: MISSING_ID, agreed: values() });
    const result = await syncTimeEntries(connection, request([change]));

    expect(ajour.requests.map((sent) => [sent.method, sent.path])).toEqual([
      ["PATCH", `/integration/entries/${MISSING_ID}`],
      ["POST", "/integration/entries"],
      ["GET", "/integration/entries"],
    ]);
    expect(ajour.requests[1]?.body).toEqual({
      workdayProject: "ACME-SUP",
      task: "Billet #101 - Login",
      startedAt: "2026-11-10T14:00:00.000Z",
      minutes: 60,
      clientRef: "key-1",
    });
    const [stored] = fake.entries();
    expect(result.results[0]).toMatchObject({ status: "synced", entry: { remoteId: stored!.id, clientRef: "key-1", minutes: 60 } });
  });
});

describe("syncTimeEntries deletes", () => {
  it("an entry by its id, and counts one ChronOps no longer has as synced", async () => {
    const entry = held({ clientRef: "key-1", startedAt: "2026-11-10T15:17:00.000Z" });
    const { ajour, fake } = await withFake({ entries: [entry] });
    const result = await syncTimeEntries(
      connection,
      request([
        { kind: "delete", syncKey: "key-1", remoteId: entry.id, agreed: values() },
        { kind: "delete", syncKey: "key-2", remoteId: MISSING_ID, agreed: values() },
      ]),
    );

    expect(result).toEqual({
      results: [
        { syncKey: "key-1", status: "synced" },
        { syncKey: "key-2", status: "synced" },
      ],
      entries: [],
    });
    expect(ajour.requests.map((sent) => [sent.method, sent.path])).toEqual([
      ["DELETE", `/integration/entries/${entry.id}`],
      ["DELETE", `/integration/entries/${MISSING_ID}`],
      ["GET", "/integration/entries"],
    ]);
    expect(fake.entries()).toEqual([]);
  });

  it("an entry Ajour has no id for, found by the client reference Ajour gave it", async () => {
    const mine = held({ clientRef: "key-1", startedAt: "2026-11-10T15:17:00.000Z" });
    // Another integration's reference may be the same text. It is not Ajour's.
    const devops = held({ clientRef: "key-1", source: "azure_devops", startedAt: "2026-11-11T15:00:00.000Z" });
    const { ajour, fake } = await withFake({ entries: [mine, devops] });
    const result = await syncTimeEntries(connection, request([{ kind: "delete", syncKey: "key-1" }]));

    expect(result.results).toEqual([{ syncKey: "key-1", status: "synced" }]);
    expect(ajour.requests.map((sent) => [sent.method, sent.path])).toEqual([
      ["GET", "/integration/entries"],
      ["DELETE", `/integration/entries/${mine.id}`],
      ["GET", "/integration/entries"],
    ]);
    expect(fake.entries().map((entry) => entry.id)).toEqual([devops.id]);
  });
});

describe("syncTimeEntries answers a change it could not apply", () => {
  it("as refused, with ChronOps' message, when ChronOps refuses the values", async () => {
    await withFake();
    const result = await syncTimeEntries(
      connection,
      request([upsert("key-1", values({ minutes: 1441 })), upsert("key-2", values({ taskName: "x".repeat(201) }))]),
    );
    expect(result.results).toEqual([
      { syncKey: "key-1", status: "refused", message: "ChronOps refused this entry: minutes must be between 1 and 1440." },
      { syncKey: "key-2", status: "refused", message: "ChronOps refused this entry: the task must be 1 to 200 characters." },
    ]);
  });

  it("as failed on a 409 from a concurrent request with the same key, and synced on the retry", async () => {
    let raced = false;
    const { fake } = await withFake({}, (forward) => async (sent) => {
      if (sent.method !== "POST" || raced) return forward(sent);
      // The concurrent request wins: ChronOps stores its entry and answers this one 409.
      raced = true;
      await forward(sent);
      return { status: 409, body: JSON.stringify({ error: "the entry was added at the same time, try again" }) };
    });
    const first = await syncTimeEntries(connection, request([upsert("key-1", values())]));
    const retry = await syncTimeEntries(connection, request([upsert("key-1", values())]));

    expect(first.results).toEqual([
      { syncKey: "key-1", status: "failed", message: "ChronOps was saving this entry from another request. Ajour tries again." },
    ]);
    expect(retry.results[0]).toMatchObject({ status: "synced", entry: { remoteId: fake.entries()[0]!.id } });
    expect(fake.entries()).toHaveLength(1);
  });

  it("as failed on a 429, a 5xx or a network error, and sends nothing more once ChronOps can't be reached", async () => {
    const { ajour } = await withFake({}, (forward) => (sent) => {
      const key = (sent.body as { clientRef?: string } | undefined)?.clientRef;
      if (key === "key-1") return answer(429)(sent);
      if (key === "key-2") return answer(503, { error: "unavailable" })(sent);
      if (key === "key-3") throw requestError("network");
      return forward(sent);
    });
    const result = await syncTimeEntries(
      connection,
      request(["key-1", "key-2", "key-3", "key-4"].map((key) => upsert(key, values()))),
    );

    expect(result.results).toEqual([
      { syncKey: "key-1", status: "failed", message: "ChronOps rate limited Ajour. Ajour tries again." },
      { syncKey: "key-2", status: "failed", message: "ChronOps answered HTTP 503. Ajour tries again." },
      { syncKey: "key-3", status: "failed", message: "ChronOps could not be reached. Ajour tries again." },
      { syncKey: "key-4", status: "failed", message: "ChronOps could not be reached. Ajour tries again." },
    ]);
    expect(ajour.requests.map((sent) => sent.method)).toEqual(["POST", "POST", "POST", "GET"]);
  });

  it("as failed, without a request, for a running entry and for a day after today", async () => {
    const { ajour } = await withFake();
    const result = await syncTimeEntries(
      connection,
      request([
        upsert("key-1", values({ localDate: "2026-11-12", running: true, countingSince: "2026-11-12T16:00:00.000Z" })),
        upsert("key-2", values({ localDate: "2026-11-12" }), { remoteId: MISSING_ID, agreed: values({ running: true, countingSince: "2026-11-12T16:00:00.000Z" }) }),
        upsert("key-3", values({ localDate: "2026-11-13" })),
      ]),
    );

    expect(result.results).toEqual([
      { syncKey: "key-1", status: "failed", message: "This version of the ChronOps plugin doesn't send running entries yet." },
      { syncKey: "key-2", status: "failed", message: "This version of the ChronOps plugin doesn't send running entries yet." },
      { syncKey: "key-3", status: "failed", message: "ChronOps takes no entry on a day after today. Ajour sends it on its day." },
    ]);
    expect(ajour.requests.map((sent) => sent.method)).toEqual(["GET"]);
  });
});

describe("syncTimeEntries lists the window", () => {
  it("with every source's entries, on the user's local day, the running one with the minute it started", async () => {
    const mine = held({ clientRef: "key-1", startedAt: "2026-11-10T15:17:00.000Z", updatedAt: "2026-11-10T20:00:00.000Z" });
    // Logged on My time at 22:30 on Monday in Toronto, which is Tuesday in UTC.
    const myTime = held({ source: "grafana", workdayProject: "GLOBEX-INT", task: "Réunion d'équipe", startedAt: "2026-11-10T03:30:00.000Z", minutes: 45 });
    // A timer the Azure DevOps extension started at 09:05 and still runs. Its own reference is not Ajour's.
    const timer = held({
      source: "azure_devops",
      clientRef: "devops-77",
      task: "Billet #102 - Export CSV",
      startedAt: "2026-11-12T14:05:00.000Z",
      endedAt: null,
      updatedAt: "2026-11-12T14:05:00.000Z",
    });
    const beforeWindow = held({ source: "grafana", startedAt: "2026-10-12T03:00:00.000Z" });
    // Ajour refuses a project remote id over 100 characters, so this one can't be a project it manages.
    const longCode = held({ source: "grafana", workdayProject: "X".repeat(101), startedAt: "2026-11-11T15:00:00.000Z" });
    await withFake({ entries: [mine, myTime, timer, beforeWindow, longCode] });

    const result = await syncTimeEntries(connection, request([]));

    expect(result).toEqual({
      results: [],
      entries: [
        {
          remoteId: timer.id,
          localDate: "2026-11-12",
          minutes: 235,
          running: true,
          countingSince: "2026-11-12T14:05:00.000Z",
          projectRemoteId: "ACME-SUP",
          taskName: "Billet #102 - Export CSV",
          updatedAt: "2026-11-12T14:05:00.000Z",
        },
        {
          remoteId: mine.id,
          clientRef: "key-1",
          localDate: "2026-11-10",
          minutes: 90,
          running: false,
          projectRemoteId: "ACME-SUP",
          taskName: "Billet #101 - Login",
          updatedAt: "2026-11-10T20:00:00.000Z",
        },
        {
          remoteId: myTime.id,
          localDate: "2026-11-09",
          minutes: 45,
          running: false,
          projectRemoteId: "GLOBEX-INT",
          taskName: "Réunion d'équipe",
          updatedAt: "2026-11-10T20:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Private words|marie/);
  });

  it("fails the whole round when the token is refused or the listing fails", async () => {
    vi.stubGlobal("ajour", createFakeAjour(answer(401, { error: "unknown or revoked personal token" })));
    await expect(syncTimeEntries(connection, request([]))).rejects.toThrow(/revoked or expired/);

    vi.stubGlobal("ajour", createFakeAjour(answer(400, { error: "to must be after from, at most 93 days later" })));
    await expect(syncTimeEntries(connection, request([]))).rejects.toThrow(
      'ChronOps answered HTTP 400: "to must be after from, at most 93 days later".',
    );
  });

  it("fails the whole round when ChronOps lists as many entries as it can, so the oldest never look deleted", async () => {
    // GET /integration/entries answers the newest 2,000 only.
    const entries = Array.from({ length: 2000 }, (_, index) =>
      held({ clientRef: `key-${index}`, startedAt: new Date(Date.parse("2026-10-13T13:00:00.000Z") + index * 15 * 60_000).toISOString(), minutes: 10 }),
    );
    await withFake({ entries });

    await expect(syncTimeEntries(connection, request([]))).rejects.toThrow(/2,000 time entries/);
  });
});

describe("syncTimeEntries paces and reports", () => {
  it(
    "keeps a full round under the Forwarder's limit of 10 requests a second with a burst of 20",
    async () => {
      // 20 entries ChronOps holds under Ajour's keys with another task name:
      // each change takes a POST and a PATCH, 41 requests with the listing.
      const entries = Array.from({ length: 20 }, (_, index) =>
        held({ clientRef: `key-${index}`, task: "Old name", startedAt: "2026-11-10T14:00:00.000Z" }),
      );
      const { ajour } = await withFake({ entries, rateLimit: { perSecond: 10, burst: 20 } });
      const result = await syncTimeEntries(
        connection,
        request(entries.map((_, index) => upsert(`key-${index}`, values()))),
      );

      expect(ajour.requests).toHaveLength(41);
      expect(result.results.map((change) => change.status)).toEqual(Array(20).fill("synced"));
    },
    20_000,
  );

  it("logs one wide event per round with counts and no names", async () => {
    const entry = held({ clientRef: "key-2", startedAt: "2026-11-10T15:17:00.000Z" });
    const { ajour } = await withFake({ entries: [entry] });
    await syncTimeEntries(
      connection,
      request([
        upsert("key-1", values()),
        upsert("key-2", values({ minutes: 30 }), { remoteId: entry.id, agreed: values() }),
        upsert("key-3", values({ minutes: 1441 })),
      ]),
    );

    expect(ajour.logs).toEqual([
      {
        level: "info",
        message: "ChronOps time entries synced",
        fields: {
          connectionId: "c1",
          outcome: "synced",
          changes: 3,
          created: 1,
          adopted: 0,
          updated: 1,
          recreated: 0,
          deleted: 0,
          refused: 1,
          failed: 0,
          listed: 2,
          skipped: 0,
          requests: 4,
          durationMs: expect.any(Number),
        },
      },
    ]);
    expect(JSON.stringify(ajour.logs)).not.toMatch(/ACME|Billet|marie/);
  });
});
