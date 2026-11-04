// What MineHunter's ChronOps Forwarder answers, as contract/snapshot.schema.json
// (version 1) and ADR-0030 describe it. This file is the plugin's reading of
// that contract. It holds the types, and a parser that applies the schema's
// rules by hand (required fields, types, enums, minimums, date formats, no
// unknown field) and refuses a body that strays from it, naming the field.
// Ajour never sees these shapes.

/** The snapshot version this plugin reads. A shape change bumps it. */
export const CHRONOPS_SNAPSHOT_VERSION = 1;

/** `GET /integration/me`: the token's owner, scope and expiry. */
export interface ChronopsMe {
  email: string;
  login: string;
  scope: "read" | "read-write";
  /** ISO 8601, null for a token that never expires. */
  expiresAt: string | null;
}

/** `GET /integration/ajour/snapshot`. */
export interface ChronopsSnapshot {
  version: 1;
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
  complete: boolean;
  /** YYYY-MM-DD. */
  contractStart: string | null;
  contractEnd: string | null;
  budget: ChronopsBudget;
  tasks: ChronopsTask[];
}

export type ChronopsBudgetStatus = "Green" | "Yellow" | "Red" | "Unconfigured";

export interface ChronopsBudget {
  mode: "monthly" | "annual";
  capHours: number;
  maxBudget: number | null;
  consumedHours: number;
  spentBudget: number | null;
  /** capHours minus consumedHours, negative when over. */
  remainingHours: number;
  status: ChronopsBudgetStatus;
}

export interface ChronopsTask {
  id: string;
  phase: string;
  name: string;
  closed: boolean;
  billable: boolean;
  estimateHours: number;
  /** False for every task when me.workerLinked is false. */
  assignedToMe: boolean;
  /** Null when not assigned or not linked. */
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
// The schema's "date" and "date-time" formats, as the contract tests read them.
const date: Reader<string> = (value, path) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : fail(path, "a date, YYYY-MM-DD");
const dateTime: Reader<string> = (value, path) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
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

const readTask = object({
  id: nonEmpty,
  phase: string,
  name: nonEmpty,
  closed: boolean,
  billable: boolean,
  estimateHours: nonNegative,
  assignedToMe: boolean,
  myHours: nullable(nonNegative),
});

const readBudget = object({
  mode: oneOf(["monthly", "annual"] as const),
  capHours: nonNegative,
  maxBudget: nullable(nonNegative),
  consumedHours: nonNegative,
  spentBudget: nullable(nonNegative),
  remainingHours: number,
  status: oneOf(["Green", "Yellow", "Red", "Unconfigured"] as const),
});

const readProject = object({
  code: nonEmpty,
  name: nonEmpty,
  client: nullable(string),
  complete: boolean,
  contractStart: nullable(date),
  contractEnd: nullable(date),
  budget: readBudget,
  tasks: array(readTask),
});

const readSnapshot = object({
  version: oneOf([CHRONOPS_SNAPSHOT_VERSION] as const),
  generatedAt: dateTime,
  reportAt: dateTime,
  me: object({ email, workerLinked: boolean }),
  projects: array(readProject),
});

/**
 * Reads a snapshot body, refusing one of another version or a field that
 * strays from the contract. The version check comes first so a MineHunter
 * ahead of the plugin gets a clear message.
 */
export function parseChronopsSnapshot(value: unknown): ChronopsSnapshot {
  const version = record(value, "snapshot").version;
  if (version !== CHRONOPS_SNAPSHOT_VERSION) {
    throw new ChronopsContractError(
      `ChronOps answered snapshot version ${String(version)}, and this plugin reads version ${CHRONOPS_SNAPSHOT_VERSION}. Update the plugin.`,
    );
  }
  return readSnapshot(value, "snapshot");
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
