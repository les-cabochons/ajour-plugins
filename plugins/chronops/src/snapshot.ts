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
import type {
  ProjectSourceBudget,
  ProjectSourceBudgetStatus,
  ProjectSourceProject,
  ProjectSourceSnapshot,
  ProjectSourceTask,
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

/**
 * A monthly budget is a cap in hours. An annual one is money when ChronOps
 * knows the money spent, hours otherwise, so an over-budget annual project
 * with no money figures still shows its state. A project ChronOps has not
 * configured has no budget to show.
 */
function mapBudget(budget: ChronopsBudget): ProjectSourceBudget | undefined {
  if (budget.status === "Unconfigured") return undefined;
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
    remaining: budget.remainingHours,
    status,
  };
}

function mapTask(task: ChronopsTask): ProjectSourceTask {
  const group = nonBlank(task.phase);
  return {
    remoteId: task.id,
    name: task.name,
    ...(group !== undefined ? { group } : {}),
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
  return {
    remoteId: project.code,
    code: project.code,
    name: project.name,
    ...(client !== undefined ? { client } : {}),
    url: projectUrl(project.code),
    complete: project.complete,
    ...(project.contractStart !== null ? { startsOn: project.contractStart } : {}),
    ...(project.contractEnd !== null ? { endsOn: project.contractEnd } : {}),
    ...(budget ? { budget } : {}),
    tasks: project.tasks.map(mapTask),
  };
}

export function mapChronopsSnapshot(snapshot: ChronopsSnapshot): ProjectSourceSnapshot {
  return {
    source: { label: SOURCE_LABEL, url: CHRONOPS_HOME_URL },
    asOf: snapshot.reportAt,
    me: { hoursAvailable: snapshot.me.workerLinked, hoursNote: HOURS_NOTE },
    projects: snapshot.projects.map(mapProject),
  };
}
