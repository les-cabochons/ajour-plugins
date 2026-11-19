import type { TimeSyncAnswer, TimeSyncChange, TimeSyncRequest } from "@ajour/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeMinehunter } from "../contract/fake-minehunter.mjs";
import { syncTimeEntries } from "../src/plugin.ts";
import { connection, createFakeAjour, forwardTo, markerOf, requestError, type PublicResponder } from "./fake-ajour.ts";

/*
 * Check rounds against MineHunter's change marker (ajour-plugins#70,
 * ChronOps ADR-0050). Ajour sends the cursor of the last answer and no
 * changes; while the marker didn't move, the plugin answers unchanged
 * without calling the Forwarder. The fake MineHunter moves the marker on
 * every write and answers its HEAD; only Date is fake, so a test moves the
 * clock with setSystemTime.
 */

const NOW = "2026-11-12T18:00:00.000Z";
const WINDOW = { from: "2026-10-12", to: "2026-11-12", timeZone: "America/Toronto" };
const MINUTE = 60_000;

let fake: Awaited<ReturnType<typeof startFakeMinehunter>> | undefined;

async function withFake(options: Parameters<typeof startFakeMinehunter>[0] = {}, storage?: PublicResponder) {
  fake = await startFakeMinehunter({ port: 0, scope: "read-write", ...options });
  const ajour = createFakeAjour(forwardTo(fake.url), storage ?? markerOf(fake));
  vi.stubGlobal("ajour", ajour);
  return { ajour, fake };
}

function round(changes: TimeSyncChange[] = [], cursor?: string): TimeSyncRequest {
  return { ...WINDOW, changes, ...(cursor === undefined ? {} : { cursor }) };
}

/** The cursor of a full answer; fails on an unchanged one. */
function cursorOf(answer: TimeSyncAnswer) {
  if (!("entries" in answer) || answer.cursor === undefined) throw new Error(`No full answer with a cursor: ${JSON.stringify(answer)}`);
  return answer.cursor;
}

/** What went to the Forwarder, as method and path. */
const forwarderCalls = (ajour: ReturnType<typeof createFakeAjour>) => ajour.requests.map((sent) => `${sent.method} ${sent.path}`);

/** Another tool logs time for the same person in ChronOps, which moves the marker. */
async function logElsewhere() {
  const response = await fetch(`${fake!.url}/integration/entries`, {
    method: "POST",
    headers: { "X-ChronOps-Source": "azure_devops", "X-ChronOps-Token": "personal-token", "Content-Type": "application/json" },
    body: JSON.stringify({ workdayProject: "ACME-SUP", task: "Billet #101 - Login", startedAt: "2026-11-11T14:00:00.000Z", minutes: 45 }),
  });
  expect(response.status).toBe(201);
}

/**
 * The cursor after Ajour's first full round and its first check, which
 * sets the marker up: the plugin asks for the link, reads the marker, and
 * lists.
 */
async function markerSetUp(ajour: ReturnType<typeof createFakeAjour>) {
  const first = cursorOf(await syncTimeEntries(connection, round()));
  const setUp = await syncTimeEntries(connection, round([], first));
  expect(forwarderCalls(ajour)).toEqual(["GET /integration/entries", "GET /integration/change-marker", "GET /integration/entries"]);
  ajour.requests.length = 0;
  ajour.publicRequests.length = 0;
  return cursorOf(setUp);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
});

afterEach(async () => {
  await fake?.close();
  fake = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("syncTimeEntries checks the change marker", () => {
  it("answers a check unchanged without calling the Forwarder while the marker didn't move", async () => {
    const { ajour } = await withFake();
    const cursor = await markerSetUp(ajour);

    expect(await syncTimeEntries(connection, round([], cursor))).toEqual({ unchanged: true, cursor });
    expect(forwarderCalls(ajour)).toEqual([]);
    expect(ajour.publicRequests).toEqual([
      { method: "HEAD", url: expect.stringMatching(/^https:\/\/stchronopsmarkers\.blob\.core\.windows\.net\/markers\//), headers: {} },
    ]);
    // A check that found nothing writes no line in Ajour's log.
    expect(ajour.logs.filter((line) => line.fields?.["outcome"] === "synced")).toHaveLength(2);
  });

  it("lists when another tool moved the marker, and the next check is unchanged", async () => {
    const { ajour } = await withFake();
    const cursor = await markerSetUp(ajour);
    await logElsewhere();

    const moved = await syncTimeEntries(connection, round([], cursor));
    expect(forwarderCalls(ajour)).toEqual(["GET /integration/entries"]);
    expect("entries" in moved && moved.entries).toEqual([expect.objectContaining({ minutes: 45, localDate: "2026-11-11" })]);

    ajour.requests.length = 0;
    const next = cursorOf(moved);
    expect(await syncTimeEntries(connection, round([], next))).toEqual({ unchanged: true, cursor: next });
    expect(ajour.publicRequests.at(-1)?.headers).toEqual({ "if-none-match": '"0x8DE0001"' });
    expect(forwarderCalls(ajour)).toEqual([]);
  });

  it("reads the marker after sending Ajour's changes, so its own write needs no second listing", async () => {
    const { ajour } = await withFake();
    const cursor = await markerSetUp(ajour);
    const change: TimeSyncChange = {
      kind: "upsert",
      syncKey: "key-1",
      values: { localDate: "2026-11-10", minutes: 90, running: false, projectRemoteId: "ACME-SUP", taskName: "Billet #101 - Login" },
    };

    const sent = cursorOf(await syncTimeEntries(connection, round([change], cursor)));
    // The link from the cursor is reused: no second GET of the change marker.
    expect(forwarderCalls(ajour)).toEqual(["POST /integration/entries", "GET /integration/entries"]);

    ajour.requests.length = 0;
    expect(await syncTimeEntries(connection, round([], sent))).toEqual({ unchanged: true, cursor: sent });
    expect(forwarderCalls(ajour)).toEqual([]);
  });

  it("gives an Ajour that sends no cursor a full answer every round, and never asks for the marker", async () => {
    const { ajour } = await withFake();
    await syncTimeEntries(connection, round());
    await syncTimeEntries(connection, round());

    expect(forwarderCalls(ajour)).toEqual(["GET /integration/entries", "GET /integration/entries"]);
    expect(ajour.publicRequests).toEqual([]);
  });

  it("lists anyway once an hour, and when the window moved", async () => {
    const { ajour } = await withFake();
    const cursor = await markerSetUp(ajour);

    vi.setSystemTime(Date.parse(NOW) + 60 * MINUTE);
    expect("entries" in (await syncTimeEntries(connection, round([], cursor)))).toBe(true);
    ajour.requests.length = 0;
    vi.setSystemTime(Date.parse(NOW));
    const nextWeek = await syncTimeEntries(connection, { ...round([], cursor), to: "2026-11-13" });
    expect("entries" in nextWeek).toBe(true);
    expect(forwarderCalls(ajour)).toEqual(["GET /integration/entries"]);
  });

  it("fetches a new link before the old one expires", async () => {
    const { ajour } = await withFake();
    const cursor = await markerSetUp(ajour);

    // The link lasts 24 hours; with under an hour left, the plugin replaces it.
    vi.setSystemTime(Date.parse(NOW) + 23.5 * 60 * MINUTE);
    const decoded = JSON.parse(cursor) as { listedAt: number };
    const renewed = await syncTimeEntries(connection, round([], JSON.stringify({ ...decoded, listedAt: Date.now() - MINUTE })));
    expect("entries" in renewed).toBe(true);
    expect(forwarderCalls(ajour)).toEqual(["GET /integration/change-marker", "GET /integration/entries"]);
  });
});

describe("syncTimeEntries without a working change marker", () => {
  it("lists at most once a minute when MineHunter has the marker off, and asks for a link again after 15 minutes", async () => {
    const { ajour, fake } = await withFake({ changeMarker: false });
    const first = cursorOf(await syncTimeEntries(connection, round()));
    const noMarker = cursorOf(await syncTimeEntries(connection, round([], first)));
    expect(fake.marker.linkRequests).toBe(1);
    ajour.requests.length = 0;

    expect(await syncTimeEntries(connection, round([], noMarker))).toEqual({ unchanged: true, cursor: noMarker });
    expect(forwarderCalls(ajour)).toEqual([]);

    vi.setSystemTime(Date.parse(NOW) + MINUTE);
    const listed = cursorOf(await syncTimeEntries(connection, round([], noMarker)));
    expect(forwarderCalls(ajour)).toEqual(["GET /integration/entries"]);
    expect(fake.marker.linkRequests).toBe(1);

    vi.setSystemTime(Date.parse(NOW) + 15 * MINUTE);
    await syncTimeEntries(connection, round([], listed));
    expect(fake.marker.linkRequests).toBe(2);
    expect(ajour.publicRequests).toEqual([]);
  });

  it("lists at most once a minute while storage can't be read, and never fails the round", async () => {
    let storageDown = false;
    const { ajour, fake } = await withFake({}, (request) => {
      if (storageDown) throw requestError("network");
      return fake!.marker.head(request.headers["if-none-match"]);
    });
    const cursor = await markerSetUp(ajour);
    storageDown = true;

    expect(await syncTimeEntries(connection, round([], cursor))).toEqual({ unchanged: true, cursor });
    expect(forwarderCalls(ajour)).toEqual([]);
    vi.setSystemTime(Date.parse(NOW) + MINUTE);
    expect("entries" in (await syncTimeEntries(connection, round([], cursor)))).toBe(true);
    expect(forwarderCalls(ajour)).toEqual(["GET /integration/entries"]);
  });

  it("uses no link on a host plugin.json doesn't declare, such as another MineHunter's storage", async () => {
    const { ajour } = await withFake({}, () => {
      throw new Error("The plugin must not read a marker it can't trust.");
    });
    const first = cursorOf(await syncTimeEntries(connection, round()));
    const answer = JSON.parse(cursorOf(await syncTimeEntries(connection, round([], first)))) as Record<string, unknown>;

    // The fake's link is on the declared host: a cursor from a forged link on another one is ignored.
    const forged = JSON.stringify({ ...answer, link: "https://attacker.example/markers/x" });
    vi.setSystemTime(Date.parse(NOW) + 2 * MINUTE);
    ajour.requests.length = 0;
    const result = await syncTimeEntries(connection, round([], forged));
    expect("entries" in result).toBe(true);
    expect(ajour.publicRequests.every((sent) => sent.url.startsWith("https://stchronopsmarkers.blob.core.windows.net/"))).toBe(true);
  });
});
