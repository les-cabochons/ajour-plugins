// The values of Ajour's plugin API 4 contract that this plugin needs at run
// time. The types come from `@ajour/plugin-sdk`, imported as types only:
// Ajour installs no dependencies, so the plugin's source imports no runtime
// code from the SDK.
import type {} from "@ajour/plugin-sdk/globals";
import type { AjourRequestError } from "@ajour/plugin-sdk";

/**
 * Ajour's bounds on a project source snapshot, as les-cabochons/ajour#558
 * shipped them. Text bounds are in characters; `projects` and `tasks` count
 * one snapshot's.
 */
export const PROJECT_SOURCE_BOUNDS = {
  label: 80,
  remoteId: 100,
  name: 240,
  code: 120,
  group: 120,
  client: 240,
  hoursNote: 300,
  url: 500,
  projects: 200,
  tasks: 10_000,
  /** The cursor `syncProjects` returns. Ajour refuses an empty or longer one. */
  cursor: 2_000,
} as const;

/**
 * Ajour's bounds on a time sync round's answer, from its
 * packages/shared/time-sync.ts (les-cabochons/ajour#691). Text bounds are in
 * characters, after trimming. Ajour refuses the whole answer for one value
 * past them.
 */
export const TIME_SYNC_BOUNDS = {
  /** A remote entry's id and its project's remote id. */
  remoteId: 100,
  /** The sync key, which a remote entry carries back as its client reference. */
  syncKey: 100,
  taskName: 240,
  /** A refused or failed change's message. */
  message: 300,
} as const;

/** How `ajour.http` rejects when the broker did not send the request. */
export function isAjourRequestError(error: unknown): error is AjourRequestError {
  return error instanceof Error && error.name === "AjourRequestError";
}
