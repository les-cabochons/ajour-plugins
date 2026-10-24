const MS_PER_HOUR = 60 * 60 * 1000;

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeStatus(value, options = {}) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return options.allowBlank ? undefined : (options.fallback ?? "active");
  }
  if (normalized === "active" || normalized === "archived") {
    return normalized;
  }
  throw new Error(`Invalid status "${normalized}". Expected active or archived.`);
}

function normalizeBillable(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/\s+/g, "_");
  if (!normalized) return undefined;
  if (normalized === "billable" || normalized === "true" || normalized === "yes") return true;
  if (["non_billable", "non-billable", "false", "no"].includes(normalized)) return false;
  throw new Error(`Invalid billable value "${normalized}". Expected billable or non_billable.`);
}

function normalizeHours(value) {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Duration hours must be a finite number.");
    return value;
  }
  const normalized = normalizeText(value).replace(",", ".");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid duration hours "${normalized}".`);
  return parsed;
}

function hoursToMs(value) {
  if (value === undefined) return undefined;
  const durationMs = Math.round(value * MS_PER_HOUR);
  return Number.isFinite(durationMs) ? durationMs : undefined;
}

function msToHours(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return Math.round((value / MS_PER_HOUR) * 10_000) / 10_000;
}

export async function exportProjects(projects) {
  const rows = projects.flatMap((project) => {
    if (project.tasks.length === 0) {
      return [{ project: project.name, code: project.code ?? "", color: project.color, status: project.status, task: "", taskStatus: "", billable: "", budgetHours: "", adjustmentHours: "" }];
    }
    return project.tasks.map((task) => ({
      project: project.name,
      code: project.code ?? "",
      color: project.color,
      status: project.status,
      task: task.name,
      taskStatus: task.status,
      billable: task.billable ? "billable" : "non_billable",
      budgetHours: msToHours(task.budgetMs),
      adjustmentHours: msToHours(task.adjustmentMs),
    }));
  });
  return { datasets: [{ id: "projects", rows }] };
}

export async function importProjects(datasets) {
  const dataset = datasets.find((candidate) => candidate.id === "projects");
  if (!dataset) throw new Error('Workday project data requires the "projects" dataset.');

  const projects = [];
  for (const [rowIndex, row] of dataset.rows.entries()) {
    const rowNumber = rowIndex + 2;
    const project = normalizeText(row.project);
    const code = normalizeText(row.code);
    const color = normalizeText(row.color);
    const task = normalizeText(row.task);
    const isBlankRow = !project && !code && !color && !normalizeText(row.status) && !task && !normalizeText(row.taskStatus) && !normalizeText(row.billable) && (row.budgetHours === null || row.budgetHours === undefined || row.budgetHours === "") && (row.adjustmentHours === null || row.adjustmentHours === undefined || row.adjustmentHours === "");
    if (isBlankRow) continue;

    const status = normalizeStatus(row.status, { fallback: "active" });
    const taskStatus = normalizeStatus(row.taskStatus, { allowBlank: true });
    const billable = normalizeBillable(row.billable);
    const budgetHours = normalizeHours(row.budgetHours);
    const adjustmentHours = normalizeHours(row.adjustmentHours);
    const budgetMs = hoursToMs(budgetHours);
    const adjustmentMs = hoursToMs(adjustmentHours);

    if (!project) throw new Error(`Row ${rowNumber} is invalid. A project name is required.`);
    if (!task && taskStatus) throw new Error(`Row ${rowNumber} is invalid. Task status requires a task name.`);
    if (!task && (billable !== undefined || budgetHours !== undefined || adjustmentHours !== undefined)) {
      throw new Error(`Row ${rowNumber} is invalid. Billable, budget, or adjustment requires a task name.`);
    }

    projects.push({
      name: project,
      ...(code ? { code } : {}),
      ...(color ? { color } : {}),
      status,
      tasks: task ? [{
        name: task,
        ...(taskStatus ? { status: taskStatus } : {}),
        ...(billable === undefined ? {} : { billable }),
        ...(budgetMs === undefined || budgetMs <= 0 ? {} : { budgetMs }),
        ...(adjustmentMs === undefined ? {} : { adjustmentMs }),
      }] : [],
    });
  }
  return { projects };
}
