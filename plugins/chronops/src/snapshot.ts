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

/**
 * The project's page in ChronOps, or undefined when the link is longer than
 * Ajour takes. Ajour refuses the whole snapshot for one bad link, and a cut
 * link would lead nowhere, so the project goes without one.
 */
export function projectUrl(code: string) {
  const url = `${CHRONOPS_HOME_URL}/timetracking/projects/${encodeURIComponent(code)}`;
  return url.length <= PROJECT_SOURCE_BOUNDS.url ? url : undefined;
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
 * two sides can disagree. Ajour trims it and links by it, so a blank one
 * stops the sync with the reason.
 */
function remoteId(rawId: string, what: string) {
  const id = rawId.trim();
  if (!id) {
    throw new Error(`ChronOps sent a blank ${what}. Ajour links projects and tasks by it, so the sync stops here.`);
  }
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
/**
 * The first day of the report's month, YYYY-MM-DD, from the report's own
 * date rather than UTC's, as ChronOps counts its month where it runs.
 */
function monthStart(reportAt: string) {
  return `${reportAt.slice(0, 7)}-01`;
}

/**
 * A monthly budget's figures cover the report's month, which `since`
 * tells Ajour. ChronOps gives no start for an annual period, so an annual
 * budget goes without one.
 */
function mapBudget(budget: ChronopsBudget, reportMonth: string): ProjectSourceBudget | undefined {
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
    ...(budget.mode === "monthly" ? { since: reportMonth } : {}),
  };
}

function mapTask(task: ChronopsTask): ProjectSourceTask {
  const group = nonBlank(task.phase);
  const id = remoteId(task.id, "task id");
  return {
    remoteId: id,
    // Ajour refuses a blank name, so a task ChronOps left unnamed goes by its id.
    name: cut(nonBlank(task.name) ?? id, PROJECT_SOURCE_BOUNDS.name),
    ...(group !== undefined ? { group: cut(group, PROJECT_SOURCE_BOUNDS.group) } : {}),
    closed: task.closed,
    billable: task.billable,
    estimateHours: task.estimateHours,
    assigned: task.assignedToMe,
    ...(task.myHours !== null ? { myHours: task.myHours } : {}),
  };
}

function mapProject(project: ChronopsProject, reportMonth: string): ProjectSourceProject {
  const budget = mapBudget(project.budget, reportMonth);
  const client = nonBlank(project.client);
  // The code is the remote id, so the remote id's bound, the tighter of the two, applies.
  const code = remoteId(project.code, "project code");
  const url = projectUrl(code);
  return {
    remoteId: code,
    code,
    // Ajour refuses a blank name, so a project ChronOps left unnamed goes by its code.
    name: cut(nonBlank(project.name) ?? code, PROJECT_SOURCE_BOUNDS.name),
    ...(client !== undefined ? { client: cut(client, PROJECT_SOURCE_BOUNDS.client) } : {}),
    ...(url !== undefined ? { url } : {}),
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
  const reportMonth = monthStart(snapshot.reportAt);
  return {
    source: { label: SOURCE_LABEL, url: CHRONOPS_HOME_URL },
    asOf: snapshot.reportAt,
    // myHours is the current month's only.
    me: { hoursAvailable: snapshot.me.workerLinked, hoursNote: HOURS_NOTE, hoursSince: reportMonth },
    projects: snapshot.projects.map((project) => mapProject(project, reportMonth)),
  };
}
