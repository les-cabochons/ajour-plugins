// What MineHunter's ChronOps Forwarder answers, as contract/snapshot.schema.json
// (version 3) and ADR-0030 describe it, and its Time Entries since its client
// reference change. Version 2 of the snapshot is still read, so the plugin
// works before and after MineHunter moves to version 3. This file is the
// plugin's reading of that contract. It holds the types, and a parser that
// applies the schema's rules by hand (required fields, types, enums, minimums,
// date formats, no unknown field) and refuses a body that strays from it,
// naming the field. Ajour never sees these shapes.

/** The snapshot versions this plugin reads, oldest first. A shape change bumps MineHunter's. */
export const CHRONOPS_SNAPSHOT_VERSIONS = [2, 3] as const;

/** `GET /integration/me`: the token's owner, scope and expiry. */
export interface ChronopsMe {
  email: string;
  login: string;
  scope: "read" | "read-write";
  /** ISO 8601, null for a token that never expires. */
  expiresAt: string | null;
}

/**
 * The most entries `GET /integration/entries` answers, the newest first
 * (MineHunter's `maxListedEntries`). A listing this long may lack older ones.
 */
export const CHRONOPS_MAX_LISTED_ENTRIES = 2000;

/**
 * A Time Entry as `GET`, `POST` and `PATCH /integration/entries` answer it,
 * with the fields the plugin reads. ChronOps also sends the owner's email,
 * the description and the work item, which the plugin never reads, so they
 * never reach Ajour.
 */
export interface ChronopsTimeEntry {
  id: string;
  /** The Workday Project code, the same code the snapshot gives a project. */
  workdayProject: string;
  task: string;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601, null while the entry runs. */
  endedAt: string | null;
  /** The span rounded to the minute, null while the entry runs. */
  minutes: number | null;
  /** The tool that created it: grafana for My time, azure_devops or ajour. */
  source: string;
  /** The key the integration that created it gave it, or null. Unique per source. */
  clientRef: string | null;
  /** ISO 8601, the entry's last change, a stop included. */
  updatedAt: string;
}

/** `GET /integration/snapshot`. */
export interface ChronopsSnapshot {
  version: (typeof CHRONOPS_SNAPSHOT_VERSIONS)[number];
  generatedAt: string;
  /** The moment the budget figures are computed for. */
  reportAt: string;
  me: { email: string; workerLinked: boolean };
  projects: ChronopsProject[];
}

export interface ChronopsProject {
  /** Stable across renames. */
  code: string;
  name: string;
  client: string | null;
  /** Null when ChronOps cannot tell. */
  complete: boolean | null;
  /** YYYY-MM-DD. */
  contractStart: string | null;
  contractEnd: string | null;
  budget: ChronopsBudget;
  tasks: ChronopsTask[];
}

export type ChronopsBudgetStatus = "Green" | "Yellow" | "Red" | "Unconfigured";

export interface ChronopsBudget {
  mode: "monthly" | "annual";
  /** Null when the project has no cap, or no figures for the current period. Status is then Unconfigured. */
  capHours: number | null;
  maxBudget: number | null;
  consumedHours: number;
  spentBudget: number | null;
  /** capHours minus consumedHours, negative when over. Null when capHours is null. */
  remainingHours: number | null;
  status: ChronopsBudgetStatus;
}

/**
 * A task as version 3 has it. A version 2 task has no budget and no worked
 * hours: the parser gives it null for both and an adjustment of 0, and drops
 * its phase, always empty since MineHunter's ADR-0045.
 */
export interface ChronopsTask {
  id: string;
  name: string;
  closed: boolean;
  billable: boolean;
  /** Workday's estimate, which every import replaces. */
  estimateHours: number;
  /** The budget a lead set in ChronOps (ADR-0047). Null without one. */
  budgetHours: number | null;
  /**
   * Workday's hours on the task, every worker and all time, without the
   * adjustment. Null from a version 2 snapshot, which does not send them.
   */
  workedHours: number | null;
  /** Hours a lead added to the worked hours, negative when removed. */
  workedHoursAdjustment: number;
  /** ChronOps assigns by email, so this is known with or without a worker link. */
  assignedToMe: boolean;
  /** The caller's hours on the task in the current month. Null when not assigned or not linked. */
  myHours: number | null;
}

/** A body that does not follow the contract. The message names the field. */
export class ChronopsContractError extends Error {
  override name = "ChronopsContractError";
}

function fail(path: string, expected: string): never {
  throw new ChronopsContractError(
    `ChronOps answered something this plugin does not understand: ${path} should be ${expected}.`,
  );
}

type Reader<Value> = (value: unknown, path: string) => Value;

const record: Reader<Record<string, unknown>> = (value, path) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(path, "an object");
const string: Reader<string> = (value, path) =>
  typeof value === "string" ? value : fail(path, "a string");
const number: Reader<number> = (value, path) =>
  typeof value === "number" && Number.isFinite(value) ? value : fail(path, "a number");
const boolean: Reader<boolean> = (value, path) =>
  typeof value === "boolean" ? value : fail(path, "a boolean");
const nonEmpty: Reader<string> = (value, path) =>
  typeof value === "string" && value.length > 0 ? value : fail(path, "a non-empty string");
const nonNegative: Reader<number> = (value, path) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail(path, "a number of 0 or more");
const positive: Reader<number> = (value, path) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fail(path, "a number over 0");
const count: Reader<number> = (value, path) =>
  Number.isInteger(value) && (value as number) >= 0 ? (value as number) : fail(path, "a whole number of 0 or more");
/**
 * Whether a string starts with a real calendar day, YYYY-MM-DD. Date.parse
 * alone is not enough, since it rolls 2026-02-30 over to March 2.
 */
function isCalendarDay(text: string) {
  const [year, month, day] = text.slice(0, 10).split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
// The schema's "date" and "date-time" formats, as the contract tests read them.
const date: Reader<string> = (value, path) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && isCalendarDay(value)
    ? value
    : fail(path, "a date, YYYY-MM-DD");
const dateTime: Reader<string> = (value, path) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  isCalendarDay(value) &&
  !Number.isNaN(Date.parse(value))
    ? value
    : fail(path, "an ISO 8601 date and time");
const email: Reader<string> = (value, path) =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+$/.test(value) ? value : fail(path, "an email address");
const nullable =
  <Value>(read: Reader<Value>): Reader<Value | null> =>
  (value, path) =>
    value === null ? null : read(value, path);
const oneOf =
  <Value extends string | number>(choices: readonly Value[]): Reader<Value> =>
  (value, path) =>
    choices.includes(value as Value) ? (value as Value) : fail(path, `one of ${choices.join(", ")}`);
const array =
  <Value>(read: Reader<Value>): Reader<Value[]> =>
  (value, path) =>
    Array.isArray(value) ? value.map((item, index) => read(item, `${path}[${index}]`)) : fail(path, "an array");

/**
 * Reads each key of `shape` from an object, naming the key that fails. The
 * snapshot schema sets additionalProperties to false, so a key the shape
 * does not know fails too, unless `extraKeys` is "ignore".
 */
function object<Shape extends Record<string, Reader<unknown>>>(
  shape: Shape,
  extraKeys: "refuse" | "ignore" = "refuse",
): Reader<{ [Key in keyof Shape]: ReturnType<Shape[Key]> }> {
  return (value, path) => {
    const source = record(value, path);
    const result: Record<string, unknown> = {};
    for (const [key, read] of Object.entries(shape)) {
      result[key] = read(source[key], `${path}.${key}`);
    }
    if (extraKeys === "refuse") {
      for (const key of Object.keys(source)) {
        if (!(key in shape)) fail(`${path}.${key}`, "left out, since the contract does not define it");
      }
    }
    return result as { [Key in keyof Shape]: ReturnType<Shape[Key]> };
  };
}

const taskFields = {
  id: nonEmpty,
  name: nonEmpty,
  closed: boolean,
  billable: boolean,
  estimateHours: nonNegative,
  assignedToMe: boolean,
  myHours: nullable(nonNegative),
};

const readTask: Reader<ChronopsTask> = object({
  ...taskFields,
  budgetHours: nullable(positive),
  workedHours: number,
  workedHoursAdjustment: number,
});

/** A version 2 task, in version 3's shape. */
const readTaskV2: Reader<ChronopsTask> = (value, path) => {
  const { phase: _phase, ...task } = object({ ...taskFields, phase: string })(value, path);
  return { ...task, budgetHours: null, workedHours: null, workedHoursAdjustment: 0 };
};

const readBudget = object({
  mode: oneOf(["monthly", "annual"] as const),
  capHours: nullable(nonNegative),
  maxBudget: nullable(nonNegative),
  consumedHours: nonNegative,
  spentBudget: nullable(nonNegative),
  remainingHours: nullable(number),
  status: oneOf(["Green", "Yellow", "Red", "Unconfigured"] as const),
});

/** A snapshot reader for one version, which only its tasks tell apart. */
function snapshotReader(version: ChronopsSnapshot["version"], task: Reader<ChronopsTask>): Reader<ChronopsSnapshot> {
  const readProject = object({
    code: nonEmpty,
    name: nonEmpty,
    client: nullable(string),
    complete: nullable(boolean),
    contractStart: nullable(date),
    contractEnd: nullable(date),
    budget: readBudget,
    tasks: array(task),
  });
  return object({
    version: oneOf([version] as const),
    generatedAt: dateTime,
    reportAt: dateTime,
    me: object({ email, workerLinked: boolean }),
    projects: array(readProject),
  });
}

const readSnapshot = { 2: snapshotReader(2, readTaskV2), 3: snapshotReader(3, readTask) };

/**
 * Reads a snapshot body, refusing one of another version or a field that
 * strays from the contract. The version check comes first so a MineHunter
 * ahead of the plugin gets a clear message.
 */
export function parseChronopsSnapshot(value: unknown): ChronopsSnapshot {
  const version = record(value, "snapshot").version;
  if (version !== 2 && version !== 3) {
    throw new ChronopsContractError(
      `ChronOps answered snapshot version ${String(version)}, and this plugin reads versions ${CHRONOPS_SNAPSHOT_VERSIONS.join(" and ")}. Update the plugin.`,
    );
  }
  return readSnapshot[version](value, "snapshot");
}

// /integration/me is not under the versioned schema, so a field MineHunter
// adds later is ignored rather than refused.
const readMe = object(
  {
    email,
    login: string,
    scope: oneOf(["read", "read-write"] as const),
    expiresAt: nullable(string),
  },
  "ignore",
);

export function parseChronopsMe(value: unknown): ChronopsMe {
  return readMe(value, "me");
}

// The Time Entry routes are not under the versioned schema either, so a
// field MineHunter adds later is ignored rather than refused.
const readTimeEntry = object(
  {
    id: nonEmpty,
    workdayProject: string,
    task: string,
    startedAt: dateTime,
    endedAt: nullable(dateTime),
    minutes: nullable(count),
    source: string,
    clientRef: nullable(string),
    updatedAt: dateTime,
  },
  "ignore",
);

export function parseChronopsTimeEntry(value: unknown): ChronopsTimeEntry {
  return readTimeEntry(value, "entry");
}

export function parseChronopsTimeEntries(value: unknown): ChronopsTimeEntry[] {
  return array(readTimeEntry)(value, "entries");
}
