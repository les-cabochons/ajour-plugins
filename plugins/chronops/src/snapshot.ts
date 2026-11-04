// The mapping from ChronOps' snapshot to Ajour's generic project source
// snapshot. Everything ChronOps-specific that Ajour shows comes from here:
// the source label, the project links and the note on missing hours.
import type { ChronopsBudget, ChronopsProject, ChronopsSnapshot, ChronopsTask } from "./chronops.ts";
import type {
  ProjectSourceBudget,
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

/**
 * A monthly budget is a cap in hours. An annual one is money when ChronOps
 * knows the money spent, hours otherwise, so an over-budget annual project
 * with no money figures still shows its state. A project ChronOps has not
 * configured has no budget to show.
 */
function mapBudget(budget: ChronopsBudget): ProjectSourceBudget | undefined {
  if (budget.status === "Unconfigured") return undefined;
  if (budget.mode === "annual" && budget.spentBudget !== null) {
    return {
      unit: "money",
      ...(budget.maxBudget !== null
        ? { total: budget.maxBudget, remaining: budget.maxBudget - budget.spentBudget }
        : {}),
      consumed: budget.spentBudget,
      status: budget.status,
    };
  }
  return {
    unit: "hours",
    total: budget.capHours,
    consumed: budget.consumedHours,
    remaining: budget.remainingHours,
    status: budget.status,
  };
}

function mapTask(task: ChronopsTask): ProjectSourceTask {
  return {
    remoteId: task.id,
    name: task.name,
    group: task.phase,
    closed: task.closed,
    billable: task.billable,
    estimateHours: task.estimateHours,
    assigned: task.assignedToMe,
    ...(task.myHours !== null ? { myHours: task.myHours } : {}),
  };
}

function mapProject(project: ChronopsProject): ProjectSourceProject {
  const budget = mapBudget(project.budget);
  return {
    remoteId: project.code,
    code: project.code,
    name: project.name,
    ...(project.client !== null ? { client: project.client } : {}),
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
