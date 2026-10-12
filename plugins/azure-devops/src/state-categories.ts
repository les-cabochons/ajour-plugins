import type { AzureDevOpsConnectionInput } from "./azure-devops.js";

/** Azure DevOps state categories, in workflow order. */
const CATEGORY_ORDER = ["Proposed", "InProgress", "Resolved", "Completed", "Removed"];

/**
 * Completed and Removed are done, so Ajour archives the item. Resolved is not
 * done: it usually means the item waits on QA.
 */
const DONE_CATEGORIES = new Set(["Completed", "Removed"]);

/** Used only when Azure DevOps doesn't return the work item type's states. */
const DONE_STATE_NAMES = new Set([
  "closed",
  "done",
  "completed",
  "removed",
  "cut",
  "cancelled",
  "canceled",
]);

export interface AzureWorkItemTypeState {
  name: string;
  /** The raw category, such as "InProgress". */
  category: string;
}

export interface AzureStateInfo {
  /** The category for people, such as "In Progress". */
  category?: string;
  done: boolean;
}

interface AzureWorkItemTypeStatesResponse {
  value?: Array<{ name?: unknown; category?: unknown }>;
}

export function formatStateCategory(category: string) {
  return category === "InProgress" ? "In Progress" : category;
}

export function isDoneStateCategory(category: string) {
  return DONE_CATEGORIES.has(category);
}

/** Orders states by category, keeping Azure DevOps' order inside each one. */
export function sortStatesByCategory(states: AzureWorkItemTypeState[]) {
  const rank = (category: string) => {
    const index = CATEGORY_ORDER.indexOf(category);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };
  return states
    .map((state, index) => ({ state, index }))
    .sort(
      (left, right) =>
        rank(left.state.category) - rank(right.state.category) ||
        left.index - right.index,
    )
    .map(({ state }) => state);
}

type RequestAzureDevOps = <T>(
  config: AzureDevOpsConnectionInput,
  pathname: string,
  init?: RequestInit,
) => Promise<T>;

/**
 * Loads each work item type's states once per sync or write, and tells the
 * category of an item's state.
 */
export function createStateCategoryResolver(
  config: AzureDevOpsConnectionInput,
  request: RequestAzureDevOps,
) {
  const cache = new Map<string, Promise<AzureWorkItemTypeState[]>>();

  function loadStates(projectName: string, workItemType: string) {
    const key = `${projectName}\n${workItemType}`;
    let states = cache.get(key);
    if (!states) {
      states = request<AzureWorkItemTypeStatesResponse>(
        config,
        `/${encodeURIComponent(projectName)}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}/states?api-version=7.1`,
      ).then((response) =>
        (response.value ?? []).flatMap((state) =>
          typeof state.name === "string" && typeof state.category === "string"
            ? [{ name: state.name, category: state.category }]
            : [],
        ),
      );
      cache.set(key, states);
    }
    return states;
  }

  /**
   * The category of `state`. When the states can't be loaded, the state's
   * name decides whether it is done.
   */
  async function describeState(
    projectName: string | undefined,
    workItemType: string | undefined,
    state: string | undefined,
  ): Promise<AzureStateInfo> {
    if (!state) {
      return { done: false };
    }

    if (projectName && workItemType) {
      try {
        const match = (await loadStates(projectName, workItemType)).find(
          (candidate) =>
            candidate.name.trim().toLowerCase() === state.trim().toLowerCase(),
        );
        if (match) {
          return {
            category: formatStateCategory(match.category),
            done: isDoneStateCategory(match.category),
          };
        }
      } catch {
        // Fall back to the state's name below.
      }
    }

    return { done: DONE_STATE_NAMES.has(state.trim().toLowerCase()) };
  }

  return { loadStates, describeState };
}
