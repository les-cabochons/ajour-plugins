/**
 * Ajour schema for Workday's Excel exports, in French. It only imports, and
 * reads two files:
 *
 * - The project export ("Afficher un projet"): the project's name and ID in
 *   the Récapitulatif sheet, and its tasks in Ressources des tâches. Ajour
 *   imports it in Settings › Projects.
 * - The project plan export ("View Project Planner Composite View"): the
 *   tasks with their closed, non-billable and estimate columns, but not the
 *   project. Ajour imports it with Import tasks… on the project.
 *
 * Ajour hands over every sheet as rows of cells: row 1 is `rows[0]`.
 */

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The name Workday shows for a task with no name of its own. Such a task
 * takes its phase's name, so "Soutien et optimisation > Regular" becomes
 * "Soutien et optimisation".
 */
const UNNAMED_TASK = "Regular";

const PROJECT_SUMMARY_SHEET = "Récapitulatif";
const PROJECT_TASKS_SHEET = "Ressources des tâches";

const PLAN_COLUMNS = {
  number: "Numéro",
  phase: "Phase/tâche",
  customName: "Nom personnalisé de la tâche",
  estimate: "Heures estimatives",
  nonBillable: "Non facturable",
  closed: "Fermé",
};

/** A cell as trimmed text, with runs of spaces, including no-break ones, as one space. */
function text(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

/** A label or heading to compare: no accents, lower case. */
function key(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function findSheet(sheets, name) {
  return sheets.find((sheet) => key(sheet.name) === key(name));
}

/**
 * Workday's Oui or Non. An empty cell is Non. `where` and `column` name the
 * cell in the error, such as "Row 4" and "Fermé".
 */
function isYes(value, where, column) {
  if (value === true || value === false) return value;
  const answer = key(value);
  if (answer === "oui" || answer === "yes") return true;
  if (answer === "" || answer === "non" || answer === "no") return false;
  throw new Error(`${where} is invalid. "${column}" must be Oui or Non, not "${text(value)}".`);
}

/** Hours from a number or text with a decimal comma. An empty cell is undefined. */
function hours(value, where, column) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const normalized = text(value).replace(",", ".");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${where} is invalid. "${column}" must be a number of hours, not "${text(value)}".`);
  }
  return parsed;
}

/** The index of each heading in `row`, by key. */
function columnIndexes(row) {
  const indexes = new Map();
  for (const [index, cell] of (row ?? []).entries()) {
    const heading = key(cell);
    if (heading && !indexes.has(heading)) indexes.set(heading, index);
  }
  return indexes;
}

/**
 * Adds a task, or keeps one of two tasks of the same name: the open one, or
 * the first when both are open or both closed.
 */
function addTask(tasks, task) {
  const existing = tasks.get(key(task.name));
  if (!existing || (existing.status === "archived" && task.status !== "archived")) {
    tasks.set(key(task.name), task);
  }
}

function readProjectExport(sheets, summary) {
  const values = new Map();
  for (const row of summary.rows) {
    const label = key(row[0]);
    if (label && !values.has(label)) values.set(label, row[1]);
  }

  const id = text(values.get(key("Identifiant du projet")));
  let name = text(values.get(key("Nom du projet")));
  if (!name) {
    throw new Error(`The ${PROJECT_SUMMARY_SHEET} sheet has no "Nom du projet".`);
  }
  // Ajour keeps the ID in the code. Workday may also put it in the name.
  if (id && name.startsWith(`${id} `)) name = name.slice(id.length + 1).trim();
  const inactive = isYes(values.get(key("Inactif")), `The ${PROJECT_SUMMARY_SHEET} sheet`, "Inactif");

  const tasksSheet = findSheet(sheets, PROJECT_TASKS_SHEET);
  if (!tasksSheet) {
    throw new Error(`The workbook has no ${PROJECT_TASKS_SHEET} sheet, where Workday lists the project's tasks.`);
  }
  const headerIndex = tasksSheet.rows.findIndex((row) => {
    const columns = columnIndexes(row);
    return columns.has(key("Phase de projet")) && columns.has(key("Tâche de projet"));
  });
  if (headerIndex < 0) {
    throw new Error(`The ${PROJECT_TASKS_SHEET} sheet has no "Phase de projet" and "Tâche de projet" columns.`);
  }
  const columns = columnIndexes(tasksSheet.rows[headerIndex]);
  const phaseColumn = columns.get(key("Phase de projet"));
  const taskColumn = columns.get(key("Tâche de projet"));

  const tasks = new Map();
  for (const row of tasksSheet.rows.slice(headerIndex + 1)) {
    const phase = text(row[phaseColumn]);
    const task = text(row[taskColumn]);
    if (!task) continue;
    addTask(tasks, { name: task === UNNAMED_TASK && phase ? phase : task });
  }

  return {
    name,
    ...(id ? { code: id } : {}),
    status: inactive ? "archived" : "active",
    tasks: [...tasks.values()],
  };
}

function isPlanSheet(sheet) {
  const columns = columnIndexes(sheet.rows[0]);
  return columns.has(key(PLAN_COLUMNS.number)) && columns.has(key(PLAN_COLUMNS.customName));
}

/**
 * Reads a project plan: a numbered row starts a phase, and each `T` row
 * under it is a task. The plan doesn't name its project, so the project has
 * no name.
 */
function readPlan(sheet) {
  const columns = columnIndexes(sheet.rows[0]);
  const column = (name) => columns.get(key(name));
  if (column(PLAN_COLUMNS.phase) === undefined) {
    throw new Error(`The ${sheet.name} sheet has no "${PLAN_COLUMNS.phase}" column.`);
  }

  const tasks = new Map();
  let phase = "";
  for (const [index, row] of sheet.rows.entries()) {
    if (index === 0 || row.every((cell) => text(cell) === "")) continue;
    const where = `Row ${index + 1}`;
    const number = text(row[column(PLAN_COLUMNS.number)]);

    if (/^\d+$/.test(number)) {
      phase = text(row[column(PLAN_COLUMNS.phase)]);
      continue;
    }
    if (number.toUpperCase() !== "T") {
      throw new Error(`${where} is invalid. "${PLAN_COLUMNS.number}" must be a phase number or T, not "${number}".`);
    }

    const name = text(row[column(PLAN_COLUMNS.customName)]) || phase;
    if (!name) {
      throw new Error(`${where} is invalid. A task without "${PLAN_COLUMNS.customName}" needs a phase above it.`);
    }
    const cell = (name) => (column(name) === undefined ? undefined : row[column(name)]);
    const task = { name };
    if (isYes(cell(PLAN_COLUMNS.closed), where, PLAN_COLUMNS.closed)) {
      // Only a closed task changes its status: one the user archived in Ajour stays archived.
      task.status = "archived";
    }
    if (column(PLAN_COLUMNS.nonBillable) !== undefined) {
      task.billable = !isYes(cell(PLAN_COLUMNS.nonBillable), where, PLAN_COLUMNS.nonBillable);
    }
    const estimate = hours(cell(PLAN_COLUMNS.estimate), where, PLAN_COLUMNS.estimate);
    if (estimate !== undefined && estimate > 0) {
      task.budgetMs = Math.round(estimate * MS_PER_HOUR);
    }
    addTask(tasks, task);
  }

  return { status: "active", tasks: [...tasks.values()] };
}

export async function importProjects(sheets) {
  const summary = findSheet(sheets, PROJECT_SUMMARY_SHEET);
  if (summary) {
    return { projects: [readProjectExport(sheets, summary)] };
  }
  const plan = sheets.find(isPlanSheet);
  if (plan) {
    return { projects: [readPlan(plan)] };
  }
  throw new Error(
    "This file is not a Workday project export or project plan. The Workday schema reads Workday's Excel exports in French: the project export, with a Récapitulatif sheet, and the project plan.",
  );
}
