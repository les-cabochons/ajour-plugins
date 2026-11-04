// The mapping from ChronOps' snapshot to Ajour's generic project source
// snapshot. Everything ChronOps-specific that Ajour shows comes from here:
// the source label, the project links and the note on missing hours.
import type {
  ChronopsBudget,
  ChronopsBudgetStatus,
  ChronopsProject,
  ChronopsSnapshot,
  ChronopsTask,
} from "./chronops.ts";
import {
  PROJECT_SOURCE_BOUNDS,
  type ProjectSourceBudget,
  type ProjectSourceBudgetStatus,
  type ProjectSourceProject,
  type ProjectSourceSnapshot,
  type ProjectSourceTask,
} from "./contract.ts";

export const SOURCE_LABEL = "ChronOps";

/** The ChronOps Grafana app, where "Open in ChronOps" leads. */
export const CHRONOPS_HOME_URL = "https://minehunter.az.nventive.com/a/wepoint-chronops-app";

/** Shown by Ajour when ChronOps cannot give the user's hours. */
export const HOURS_NOTE = "Link your Workday name in ChronOps to compare your hours";

export function projectUrl(code: string) {
  return `${CHRONOPS_HOME_URL}/timetracking/projects/${encodeURIComponent(code)}`;
}

/** ChronOps' health colours in Ajour's words. */
const BUDGET_STATUS: Record<Exclude<ChronopsBudgetStatus, "Unconfigured">, ProjectSourceBudgetStatus> = {
  Green: "ok",
  Yellow: "warning",
  Red: "over",
};

/** Ajour refuses an empty text where it expects none, so blank becomes absent. */
function nonBlank(text: string | null): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

/** A text Ajour would refuse for its length is cut, with an ellipsis to say so. */
function cut(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

/**
 * An id is never cut, since a cut one would name something else next time.
 * The contract puts no bound on ChronOps ids, so this is the one place the
 * two sides can disagree.
 */
function remoteId(id: string, what: string) {
  if (id.length > PROJECT_SOURCE_BOUNDS.remoteId) {
    throw new Error(`ChronOps ${what} "${id.slice(0, 20)}\u2026" is longer than ${PROJECT_SOURCE_BOUNDS.remoteId} characters, the most Ajour accepts.`);
  }
  return id;
}

/**
 * A monthly budget is a cap in hours. An annual one is money when ChronOps
 * knows the money spent, hours otherwise, so an over-budget annual project
 * with no money figures still shows its state. A project without a cap, or
 * without figures for the period, has no budget to show. ChronOps marks it
 * Unconfigured and leaves capHours null, and either is enough here.
 */
function mapBudget(budget: ChronopsBudget): ProjectSourceBudget | undefined {
  if (budget.status === "Unconfigured" || budget.capHours === null) return undefined;
  const status = BUDGET_STATUS[budget.status];
  if (budget.mode === "annual" && budget.spentBudget !== null) {
    return {
      unit: "money",
      ...(budget.maxBudget !== null
        ? { total: budget.maxBudget, remaining: budget.maxBudget - budget.spentBudget }
        : {}),
      consumed: budget.spentBudget,
      status,
    };
  }
  return {
    unit: "hours",
    total: budget.capHours,
    consumed: budget.consumedHours,
    ...(budget.remainingHours !== null ? { remaining: budget.remainingHours } : {}),
    status,
  };
}

function mapTask(task: ChronopsTask): ProjectSourceTask {
  const group = nonBlank(task.phase);
  return {
    remoteId: remoteId(task.id, "task id"),
    name: cut(task.name, PROJECT_SOURCE_BOUNDS.name),
    ...(group !== undefined ? { group: cut(group, PROJECT_SOURCE_BOUNDS.group) } : {}),
    closed: task.closed,
    billable: task.billable,
    estimateHours: task.estimateHours,
    assigned: task.assignedToMe,
    ...(task.myHours !== null ? { myHours: task.myHours } : {}),
  };
}

function mapProject(project: ChronopsProject): ProjectSourceProject {
  const budget = mapBudget(project.budget);
  const client = nonBlank(project.client);
  // The code is the remote id, so the remote id's bound, the tighter of the two, applies.
  return {
    remoteId: remoteId(project.code, "project code"),
    code: project.code,
    name: cut(project.name, PROJECT_SOURCE_BOUNDS.name),
    ...(client !== undefined ? { client: cut(client, PROJECT_SOURCE_BOUNDS.client) } : {}),
    url: projectUrl(project.code),
    // ChronOps may not know. Ajour archives a complete project, so unknown stays open.
    complete: project.complete ?? false,
    ...(project.contractStart !== null ? { startsOn: project.contractStart } : {}),
    ...(project.contractEnd !== null ? { endsOn: project.contractEnd } : {}),
    ...(budget ? { budget } : {}),
    tasks: project.tasks.map(mapTask),
  };
}

/** Ajour refuses a snapshot past its counts, so the sync fails with the reason rather than silently. */
function checkCounts(snapshot: ChronopsSnapshot) {
  const tasks = snapshot.projects.reduce((count, project) => count + project.tasks.length, 0);
  if (snapshot.projects.length > PROJECT_SOURCE_BOUNDS.projects) {
    throw new Error(`ChronOps lists ${snapshot.projects.length} projects, and Ajour accepts at most ${PROJECT_SOURCE_BOUNDS.projects} in one snapshot.`);
  }
  if (tasks > PROJECT_SOURCE_BOUNDS.tasks) {
    throw new Error(`ChronOps lists ${tasks} tasks, and Ajour accepts at most ${PROJECT_SOURCE_BOUNDS.tasks} in one snapshot.`);
  }
}

export function mapChronopsSnapshot(snapshot: ChronopsSnapshot): ProjectSourceSnapshot {
  checkCounts(snapshot);
  return {
    source: { label: SOURCE_LABEL, url: CHRONOPS_HOME_URL },
    asOf: snapshot.reportAt,
    me: { hoursAvailable: snapshot.me.workerLinked, hoursNote: HOURS_NOTE },
    projects: snapshot.projects.map(mapProject),
  };
}
