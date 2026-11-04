// What MineHunter's ChronOps Forwarder answers, as contract/snapshot.schema.json
// (version 1) and ADR-0030 describe it. This file is the plugin's reading of
// that contract: the types, and a parser that refuses a body that strays from
// it, naming the field. Ajour never sees these shapes.

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

/** Reads each key of `shape` from an object, naming the key that fails. */
function object<Shape extends Record<string, Reader<unknown>>>(
  shape: Shape,
): Reader<{ [Key in keyof Shape]: ReturnType<Shape[Key]> }> {
  return (value, path) => {
    const source = record(value, path);
    const result: Record<string, unknown> = {};
    for (const [key, read] of Object.entries(shape)) {
      result[key] = read(source[key], `${path}.${key}`);
    }
    return result as { [Key in keyof Shape]: ReturnType<Shape[Key]> };
  };
}

const readTask = object({
  id: string,
  phase: string,
  name: string,
  closed: boolean,
  billable: boolean,
  estimateHours: number,
  assignedToMe: boolean,
  myHours: nullable(number),
});

const readBudget = object({
  mode: oneOf(["monthly", "annual"] as const),
  capHours: number,
  maxBudget: nullable(number),
  consumedHours: number,
  spentBudget: nullable(number),
  remainingHours: number,
  status: oneOf(["Green", "Yellow", "Red", "Unconfigured"] as const),
});

const readProject = object({
  code: string,
  name: string,
  client: nullable(string),
  complete: boolean,
  contractStart: nullable(string),
  contractEnd: nullable(string),
  budget: readBudget,
  tasks: array(readTask),
});

const readSnapshot = object({
  version: oneOf([CHRONOPS_SNAPSHOT_VERSION] as const),
  generatedAt: string,
  reportAt: string,
  me: object({ email: string, workerLinked: boolean }),
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

const readMe = object({
  email: string,
  login: string,
  scope: oneOf(["read", "read-write"] as const),
  expiresAt: nullable(string),
});

export function parseChronopsMe(value: unknown): ChronopsMe {
  return readMe(value, "me");
}
