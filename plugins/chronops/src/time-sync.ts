// The time sync capability (les-cabochons/ajour#685): one round of
// `syncTimeEntries` applies Ajour's changes to ChronOps Time Entries, in
// order, then lists the window back. Ajour keeps an entry as a day and whole
// minutes, and ChronOps as a start and an end, so this file maps between the
// two. Running entries come with ajour-plugins#37.
import type {
  PluginConnection,
  TimeSyncChange,
  TimeSyncChangeResult,
  TimeSyncEntryValues,
  TimeSyncRemoteEntry,
  TimeSyncRequest,
  TimeSyncResult,
  AjourResponse,
} from "@ajour/plugin-sdk";
import {
  CHRONOPS_MAX_LISTED_ENTRIES,
  parseChronopsTimeEntries,
  parseChronopsTimeEntry,
  type ChronopsTimeEntry,
} from "./chronops.ts";
import { TIME_SYNC_BOUNDS } from "./contract.ts";
import {
  ChronopsError,
  ChronopsUnavailable,
  forwarderGet,
  forwarderRequest,
  jsonBody,
  refusalReason,
  type ForwarderRequest,
} from "./forwarder.ts";
import { dayAfter, instantAt, localDateIn } from "./local-time.ts";
import { createPacer } from "./pacer.ts";

const ENTRIES = "/integration/entries";

/** The source ChronOps records on the entries Ajour creates. Client references are unique per source. */
const AJOUR_SOURCE = "ajour";

/**
 * The pace of a round's requests. The Forwarder allows 10 a second with a
 * burst of 20 per address. A round holds at most 20 changes of up to three
 * requests each, and one or two listings. Half the burst, then 8 a second,
 * leaves room for a project sync and other tools behind the same address.
 * A full round of 62 requests then takes about 7 seconds, inside Ajour's
 * 30-second operation timeout.
 */
const PACE = { burst: 10, perSecond: 8 } as const;

/** Ajour keeps no start time, so a new entry starts at this hour on its day. */
const STAND_IN_HOUR = 9;

/**
 * How far before now a stand-in start set to "now" goes. ChronOps refuses an
 * edited start after its own clock, so this leaves a minute for a computer
 * clock that runs ahead.
 */
const CLOCK_MARGIN_MS = 60_000;

/** What the user reads for a change that failed or waits. Ajour sends it again next round. */
const MESSAGES = {
  running: "This version of the ChronOps plugin doesn't send running entries yet.",
  future: "ChronOps takes no entry on a day after today. Ajour sends it on its day.",
  unreachable: "ChronOps could not be reached. Ajour tries again.",
  brokerLimit: "Ajour sent ChronOps too many requests at once. Ajour tries again.",
  rateLimited: "ChronOps rate limited Ajour. Ajour tries again.",
  concurrent: "ChronOps was saving this entry from another request. Ajour tries again.",
  tooMany:
    "ChronOps listed 2,000 time entries for these weeks, the most it lists, so some may be missing. Ajour syncs time entries again once there are fewer.",
} as const;

type Upsert = Extract<TimeSyncChange, { kind: "upsert" }>;
type Delete = Extract<TimeSyncChange, { kind: "delete" }>;

/** The values ChronOps holds of an entry, which a PATCH can change. */
type Compared = Pick<TimeSyncEntryValues, "localDate" | "minutes" | "projectRemoteId" | "taskName">;

/** What one round did, for its wide event. Counts only, never names. */
interface Counts {
  /** Entries a POST created (201). */
  created: number;
  /** Entries a POST found under the change's client reference (200). */
  adopted: number;
  /** PATCHes ChronOps took. */
  updated: number;
  /** Edits answered 404, so the entry was created again. */
  recreated: number;
  deleted: number;
  refused: number;
  failed: number;
  requests: number;
}

interface Round {
  connection: PluginConnection;
  timeZone: string;
  /** An instant's local date in the user's time zone. */
  localDate: (instant: number) => string;
  /** The window as ChronOps lists it: instants, `from` included, `to` excluded. */
  window: { from: string; to: string };
  pace: () => Promise<void>;
  /** Set once ChronOps did not answer at all. The round's other changes then fail without a request. */
  unreachable: boolean;
  /** The window's entries, read once, to find an entry by its client reference for a delete that has no remote id. */
  lookup?: ChronopsTimeEntry[];
  counts: Counts;
}

/** Every request of a round waits its turn, so the round stays under the Forwarder's limit. */
async function send(round: Round, request: ForwarderRequest) {
  await round.pace();
  round.counts.requests += 1;
  return forwarderRequest(round.connection, request);
}

const entryPath = (id: string) => `${ENTRIES}/${encodeURIComponent(id)}`;

/** Whether a text fits one of Ajour's bounds, as Ajour checks it: trimmed, 1 to `max` characters. */
function fits(text: string, max: number) {
  const length = text.trim().length;
  return length >= 1 && length <= max;
}

/** A message within Ajour's bound, cut with an ellipsis. */
function cut(message: string) {
  return message.length > TIME_SYNC_BOUNDS.message ? `${message.slice(0, TIME_SYNC_BOUNDS.message - 1)}…` : message;
}

/**
 * A ChronOps entry in Ajour's words: its day where the user is, whole
 * minutes, and the running state. A running entry's minutes are those
 * elapsed since its start, which is also when its count began. The client
 * reference goes back only on Ajour's own entries: another integration's
 * reference is not a sync key.
 */
function remoteEntry(entry: ChronopsTimeEntry, round: Round): TimeSyncRemoteEntry {
  const started = Date.parse(entry.startedAt);
  const ended = entry.endedAt === null ? null : Date.parse(entry.endedAt);
  const minutes =
    ended === null
      ? Math.max(0, Math.floor((Date.now() - started) / 60_000))
      : (entry.minutes ?? Math.round((ended - started) / 60_000));
  const clientRef =
    entry.source === AJOUR_SOURCE && entry.clientRef !== null && fits(entry.clientRef, TIME_SYNC_BOUNDS.syncKey)
      ? entry.clientRef
      : undefined;
  return {
    remoteId: entry.id,
    ...(clientRef === undefined ? {} : { clientRef }),
    localDate: round.localDate(started),
    minutes,
    running: ended === null,
    ...(ended === null ? { countingSince: new Date(started).toISOString() } : {}),
    projectRemoteId: entry.workdayProject,
    taskName: entry.task,
    updatedAt: new Date(Date.parse(entry.updatedAt)).toISOString(),
  };
}

/**
 * Whether Ajour can take a listed entry. It refuses the whole answer for one
 * project code or task past its bounds, and such a project can't be one the
 * connection manages, since the project sync fails on it too.
 */
function takes(entry: ChronopsTimeEntry) {
  return (
    fits(entry.id, TIME_SYNC_BOUNDS.remoteId) &&
    fits(entry.workdayProject, TIME_SYNC_BOUNDS.remoteId) &&
    fits(entry.task, TIME_SYNC_BOUNDS.taskName)
  );
}

/**
 * Where a new entry starts: 09:00 on its day in the user's time zone, or
 * now, less a minute, when that is earlier, since ChronOps refuses a start
 * in the future. Never before the day's midnight, so the entry stays on its
 * day.
 */
function standInStart(localDate: string, round: Round) {
  const nine = instantAt(localDate, STAND_IN_HOUR, round.timeZone);
  const midnight = instantAt(localDate, 0, round.timeZone);
  return new Date(Math.min(nine, Math.max(Date.now() - CLOCK_MARGIN_MS, midnight))).toISOString();
}

/**
 * The PATCH body that brings ChronOps from `from` to Ajour's `values`: the
 * project, task and minutes that differ, and a stand-in start only when the
 * day differs, so ChronOps keeps the real start it has. Without `from`,
 * every field.
 */
function patchBody(values: TimeSyncEntryValues, from: Compared | undefined, round: Round) {
  const body: Record<string, string | number> = {};
  if (from?.projectRemoteId !== values.projectRemoteId) body["workdayProject"] = values.projectRemoteId;
  if (from?.taskName !== values.taskName) body["task"] = values.taskName;
  if (from?.minutes !== values.minutes) body["minutes"] = values.minutes;
  if (from?.localDate !== values.localDate) body["startedAt"] = standInStart(values.localDate, round);
  return body;
}

function synced(change: TimeSyncChange, entry?: TimeSyncRemoteEntry): TimeSyncChangeResult {
  return entry === undefined ? { syncKey: change.syncKey, status: "synced" } : { syncKey: change.syncKey, status: "synced", entry };
}

function refused(round: Round, change: TimeSyncChange, message: string): TimeSyncChangeResult {
  round.counts.refused += 1;
  return { syncKey: change.syncKey, status: "refused", message: cut(message) };
}

function failed(round: Round, change: TimeSyncChange, message: string): TimeSyncChangeResult {
  round.counts.failed += 1;
  return { syncKey: change.syncKey, status: "failed", message: cut(message) };
}

/**
 * What an answer that is not a success means for a change. A validation
 * answer is final until the entry changes, with ChronOps' reason. A 409 is a
 * concurrent request with the same client reference, whose retry gets 200.
 * Anything else may work next round.
 */
async function unsuccessful(round: Round, change: TimeSyncChange, response: AjourResponse) {
  switch (response.status) {
    case 400:
    case 422: {
      const reason = (await refusalReason(response))?.trim().replace(/\.$/, "");
      return refused(round, change, reason ? `ChronOps refused this entry: ${reason}.` : `ChronOps refused this entry with HTTP ${response.status}.`);
    }
    case 409:
      return failed(round, change, MESSAGES.concurrent);
    case 429:
      return failed(round, change, MESSAGES.rateLimited);
    default:
      return failed(round, change, `ChronOps answered HTTP ${response.status}. Ajour tries again.`);
  }
}

async function answeredEntry(response: AjourResponse, round: Round) {
  return remoteEntry(parseChronopsTimeEntry(await jsonBody(response)), round);
}

/**
 * Creates the entry with the sync key as its client reference. A 200 means
 * ChronOps already holds the entry this key created, such as when the
 * answer to an earlier create was lost: Ajour's values win, so it is brought
 * to them.
 */
async function create(round: Round, change: Upsert): Promise<TimeSyncChangeResult> {
  const { values } = change;
  const response = await send(round, {
    method: "POST",
    path: ENTRIES,
    json: {
      workdayProject: values.projectRemoteId,
      task: values.taskName,
      startedAt: standInStart(values.localDate, round),
      minutes: values.minutes,
      clientRef: change.syncKey,
    },
  });
  if (response.status === 201) {
    round.counts.created += 1;
    return synced(change, await answeredEntry(response, round));
  }
  if (response.status !== 200) return unsuccessful(round, change, response);
  round.counts.adopted += 1;
  const stored = parseChronopsTimeEntry(await jsonBody(response));
  const held = remoteEntry(stored, round);
  const body = patchBody(values, held, round);
  return Object.keys(body).length === 0 ? synced(change, held) : patch(round, change, stored.id, body, "fail");
}

/**
 * Sends a PATCH and answers the entry as ChronOps stored it. An edit of an
 * entry ChronOps no longer has creates it again; a PATCH that follows a
 * create does not, so the two never loop.
 */
async function patch(
  round: Round,
  change: Upsert,
  id: string,
  body: Record<string, string | number>,
  whenMissing: "create" | "fail",
): Promise<TimeSyncChangeResult> {
  const response = await send(round, { method: "PATCH", path: entryPath(id), json: body });
  if (response.ok) {
    round.counts.updated += 1;
    return synced(change, await answeredEntry(response, round));
  }
  if (response.status === 404 && whenMissing === "create") {
    round.counts.recreated += 1;
    return create(round, change);
  }
  return unsuccessful(round, change, response);
}

/**
 * Edits only what changed since the values both sides agreed on. When
 * nothing ChronOps holds changed, such as only the task's remote id, the
 * PATCH is empty: it still answers the entry as stored, and a 404 still
 * creates the entry again.
 */
async function update(round: Round, change: Upsert, remoteId: string) {
  return patch(round, change, remoteId, patchBody(change.values, change.agreed, round), "create");
}

/**
 * Deletes the entry. ChronOps deletes for good, so a 404 means it is
 * already gone. Without a remote id, the entry is found by the client
 * reference Ajour gave it, in case the create's answer was lost; with none,
 * there is nothing to delete.
 */
async function remove(round: Round, change: Delete) {
  const id = change.remoteId ?? (await ajourEntryWithKey(round, change.syncKey))?.id;
  if (id !== undefined) {
    const response = await send(round, { method: "DELETE", path: entryPath(id) });
    if (!response.ok && response.status !== 404) return unsuccessful(round, change, response);
  }
  round.counts.deleted += 1;
  return synced(change);
}

async function ajourEntryWithKey(round: Round, syncKey: string) {
  round.lookup ??= await listWindow(round);
  return round.lookup.find((entry) => entry.source === AJOUR_SOURCE && entry.clientRef === syncKey);
}

/**
 * Every source's entries started in the window, and the running one
 * wherever it started, as ChronOps lists them. A failure here fails the
 * whole round: Ajour must not read a missing listing as deleted entries.
 * So does a listing at ChronOps' cap, which leaves out the oldest entries.
 */
async function listWindow(round: Round) {
  await round.pace();
  round.counts.requests += 1;
  const listed = parseChronopsTimeEntries(await jsonBody(await forwarderGet(round.connection, ENTRIES, {}, round.window)));
  if (listed.length >= CHRONOPS_MAX_LISTED_ENTRIES) throw new ChronopsError(MESSAGES.tooMany);
  return listed;
}

async function apply(round: Round, change: TimeSyncChange, today: string): Promise<TimeSyncChangeResult> {
  if (round.unreachable) return failed(round, change, MESSAGES.unreachable);
  try {
    if (change.kind === "delete") return await remove(round, change);
    // Starting, stopping and continuing a ChronOps timer come with #37.
    if (change.values.running || change.agreed?.running) return failed(round, change, MESSAGES.running);
    // Ajour waits for the day, so this only guards a stand-in start ChronOps would put on today.
    if (change.values.localDate > today) return failed(round, change, MESSAGES.future);
    return change.remoteId === undefined ? await create(round, change) : await update(round, change, change.remoteId);
  } catch (error) {
    if (!(error instanceof ChronopsUnavailable)) throw error;
    if (error.unreachable) round.unreachable = true;
    return failed(round, change, error.unreachable ? MESSAGES.unreachable : MESSAGES.brokerLimit);
  }
}

/**
 * One round: applies `request.changes` in order, then lists the window,
 * from midnight on `from` to midnight after `to` in the user's time zone. A
 * refused token, a forbidden request or a listing that fails throws, and
 * Ajour applies nothing from the round. Every change Ajour sends again is
 * safe to repeat: a create finds its entry by client reference, an edit
 * sets the same values, and a delete of a gone entry is synced.
 */
export async function syncTimeEntries(connection: PluginConnection, request: TimeSyncRequest): Promise<TimeSyncResult> {
  const startedAt = performance.now();
  const { timeZone } = request;
  const round: Round = {
    connection,
    timeZone,
    localDate: localDateIn(timeZone),
    window: {
      from: new Date(instantAt(request.from, 0, timeZone)).toISOString(),
      to: new Date(instantAt(dayAfter(request.to), 0, timeZone)).toISOString(),
    },
    pace: createPacer(PACE),
    unreachable: false,
    counts: { created: 0, adopted: 0, updated: 0, recreated: 0, deleted: 0, refused: 0, failed: 0, requests: 0 },
  };
  const event = (outcome: string) => ({
    connectionId: connection.id,
    outcome,
    changes: request.changes.length,
    ...round.counts,
    durationMs: Math.round(performance.now() - startedAt),
  });
  try {
    const today = round.localDate(Date.now());
    const results: TimeSyncChangeResult[] = [];
    for (const change of request.changes) results.push(await apply(round, change, today));
    const listed = await listWindow(round);
    const entries = listed.filter(takes).map((entry) => remoteEntry(entry, round));
    ajour.log("info", "ChronOps time entries synced", { ...event("synced"), listed: entries.length, skipped: listed.length - entries.length });
    return { results, entries };
  } catch (error) {
    ajour.log("warn", "ChronOps time entries synced", { ...event("failed"), error: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}
