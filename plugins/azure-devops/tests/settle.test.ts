import { afterEach, describe, expect, it, vi } from "vitest";
import {
  syncAzureDevOpsConnection,
  type AzureDevOpsConnectionInput,
} from "../src/azure-devops.ts";
import { listAzureSettleStates, writeAzureSettle } from "../src/settle.ts";
import {
  DEFAULT_PRIORITY_LEVEL_VALUES,
  parsePriorityLevelRanges,
} from "../src/priority-levels.ts";
import { AGILE_TASK_STATES } from "./work-item-type-states.ts";

const ORG = "https://dev.azure.com/contoso";

function sourceId(id: number) {
  return `${ORG}/Mercury/_workitems/edit/${id}`;
}

function buildConnection(
  overrides: Partial<AzureDevOpsConnectionInput> = {},
): AzureDevOpsConnectionInput {
  return {
    id: "connection-1",
    label: "Main connection",
    tenantLabel: "Contoso",
    organizationUrl: ORG,
    personalAccessToken: "secret",
    queryScope: "assigned_to_me",
    priorityLevels: parsePriorityLevelRanges(DEFAULT_PRIORITY_LEVEL_VALUES),
    ...overrides,
  };
}

/** A custom "MS Priority" field that runs from 1 to 100. */
const MS_PRIORITY_LEVELS = parsePriorityLevelRanges({
  urgent: "1-25",
  high: "26-50",
  medium: "51-75",
  low: "76-100",
});

function task(title: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    "System.Title": title,
    "System.State": state,
    "System.TeamProject": "Mercury",
    "System.WorkItemType": "Task",
    ...extra,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A small Azure DevOps: the WIQL query returns `queryIds`, work items come
 * from `items`, and PATCH applies its operations unless `rejectPatch` is set.
 */
function fakeAzureDevOps({
  items,
  queryIds = Object.keys(items).map(Number),
  states = AGILE_TASK_STATES,
  fields = [],
  rejectPatch,
  workflowFields,
}: {
  items: Record<number, Record<string, unknown>>;
  queryIds?: number[];
  states?: unknown[] | "fail";
  fields?: unknown[];
  rejectPatch?: string;
  workflowFields?: Record<string, unknown>;
}) {
  const patches: Array<{ id: number; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/workitemtypes/")) {
      return states === "fail" ? json({ message: "Not found" }, 404) : json({ value: states });
    }
    if (url.includes("/_apis/wit/wiql")) {
      return json({ workItems: queryIds.map((id) => ({ id })) });
    }
    if (url.includes("/_apis/wit/fields")) {
      return json({ value: fields });
    }
    if (url.includes("/_apis/wit/workitemsbatch")) {
      const body = JSON.parse(String(init?.body)) as { ids: number[] };
      return json({
        value: body.ids
          .filter((id) => items[id])
          .map((id) => ({ id, fields: items[id], relations: [] })),
      });
    }
    const single = /\/_apis\/wit\/workitems\/(\d+)/.exec(url);
    if (single) {
      const id = Number(single[1]);
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Array<{ path: string; value: unknown }>;
        patches.push({ id, body });
        if (rejectPatch) {
          return json({ message: rejectPatch }, 400);
        }
        for (const operation of body) {
          items[id] = { ...items[id], [operation.path.replace("/fields/", "")]: operation.value };
        }
        items[id] = { ...items[id], ...workflowFields };
      }
      return json({ id, fields: items[id] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { patches };
}

describe("Azure DevOps state categories in sync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("imports Resolved items and reports each item's category", async () => {
    fakeAzureDevOps({
      items: {
        1: task("Build the form", "Active"),
        2: task("Waiting on QA", "Resolved"),
        3: task("Shipped", "Closed"),
      },
    });

    const result = await syncAzureDevOpsConnection(buildConnection());

    expect(
      result.items.map((item) => [item.title, item.stateCategory, item.stateDone]),
    ).toEqual([
      ["Build the form", "In Progress", false],
      ["Waiting on QA", "Resolved", false],
    ]);
  });

  it("reports Ajour's items that reached a done category, fetching those the query no longer returns", async () => {
    fakeAzureDevOps({
      items: {
        1: task("Still open", "Active"),
        2: task("Closed in the query", "Closed"),
        3: task("Removed outside the query", "Removed"),
        4: task("Closed but never imported", "Closed"),
      },
      queryIds: [1, 2, 4],
    });

    const result = await syncAzureDevOpsConnection(buildConnection(), [
      { localWorkItemId: "a", sourceId: sourceId(1) },
      { localWorkItemId: "b", sourceId: sourceId(2) },
      { localWorkItemId: "c", sourceId: sourceId(3) },
    ]);

    expect(
      result.items
        .filter((item) => item.stateDone)
        .map((item) => [item.sourceId, item.state, item.stateCategory]),
    ).toEqual([
      [sourceId(2), "Closed", "Completed"],
      [sourceId(3), "Removed", "Removed"],
    ]);
  });

  it("falls back to state names when the work item type's states can't be loaded", async () => {
    fakeAzureDevOps({
      items: {
        1: task("Open", "Active"),
        2: task("Waiting on QA", "Resolved"),
        3: task("Done", "Closed"),
      },
      states: "fail",
    });

    const result = await syncAzureDevOpsConnection(buildConnection());

    expect(result.items.map((item) => [item.title, item.stateCategory])).toEqual([
      ["Open", undefined],
      ["Waiting on QA", undefined],
    ]);
  });
});

describe("Azure DevOps settle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists the work item type's states by category, with the done ones marked", async () => {
    fakeAzureDevOps({
      items: { 7: task("Fix login", "Active") },
      states: [
        { name: "Closed", category: "Completed" },
        { name: "Active", category: "InProgress" },
        { name: "Waiting for client", category: "InProgress" },
        { name: "New", category: "Proposed" },
        { name: "Removed", category: "Removed" },
      ],
    });

    await expect(listAzureSettleStates(buildConnection(), sourceId(7))).resolves.toEqual({
      states: [
        { name: "New", category: "Proposed", done: false },
        { name: "Active", category: "In Progress", done: false },
        { name: "Waiting for client", category: "In Progress", done: false },
        { name: "Closed", category: "Completed", done: true },
        { name: "Removed", category: "Removed", done: true },
      ],
    });
  });

  it("writes the state and the lowest value of the priority level's range in one update", async () => {
    const azure = fakeAzureDevOps({
      items: { 7: task("Fix login", "Active", { "Custom.MSPriority": "50" }) },
      fields: [{ name: "MS Priority", referenceName: "Custom.MSPriority", type: "string" }],
    });

    const result = await writeAzureSettle(
      buildConnection({ priorityFieldName: "MS Priority", priorityLevels: MS_PRIORITY_LEVELS }),
      { sourceId: sourceId(7), state: "Closed", priority: "medium" },
    );

    expect(azure.patches).toEqual([
      {
        id: 7,
        body: [
          { op: "add", path: "/fields/System.State", value: "Closed" },
          { op: "add", path: "/fields/Custom.MSPriority", value: "51" },
        ],
      },
    ]);
    expect(result).toEqual({
      state: "Closed",
      stateCategory: "Completed",
      stateDone: true,
      priority: "medium",
    });
  });

  it("writes a number to a numeric priority field, and only the state when asked", async () => {
    const azure = fakeAzureDevOps({
      items: { 7: task("Fix login", "Active", { "Microsoft.VSTS.Common.Priority": 2 }) },
      fields: [
        { name: "Priority", referenceName: "Microsoft.VSTS.Common.Priority", type: "integer" },
      ],
    });
    const connection = buildConnection({ priorityFieldName: "Priority" });

    await writeAzureSettle(connection, { sourceId: sourceId(7), priority: "high" });
    await writeAzureSettle(connection, { sourceId: sourceId(7), state: "Resolved" });

    expect(azure.patches.map((patch) => patch.body)).toEqual([
      [{ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 2 }],
      [{ op: "add", path: "/fields/System.State", value: "Resolved" }],
    ]);
  });

  it("returns the priority level after a state-only write applies a workflow rule", async () => {
    const azure = fakeAzureDevOps({
      items: { 7: task("Fix login", "Active", { "Custom.MSPriority": "50" }) },
      fields: [{ name: "MS Priority", referenceName: "Custom.MSPriority", type: "string" }],
      workflowFields: { "Custom.MSPriority": "80" },
    });

    const result = await writeAzureSettle(
      buildConnection({ priorityFieldName: "MS Priority", priorityLevels: MS_PRIORITY_LEVELS }),
      { sourceId: sourceId(7), state: "Resolved" },
    );

    expect(azure.patches[0]?.body).toEqual([
      { op: "add", path: "/fields/System.State", value: "Resolved" },
    ]);
    expect(result.priority).toBe("low");
  });

  it("refuses a priority level without values and returns no level for a value outside every range", async () => {
    const azure = fakeAzureDevOps({
      items: { 7: task("Fix login", "Active", { "Custom.MSPriority": "500" }) },
      fields: [{ name: "MS Priority", referenceName: "Custom.MSPriority", type: "string" }],
    });
    const connection = buildConnection({
      priorityFieldName: "MS Priority",
      priorityLevels: parsePriorityLevelRanges({ high: "1-10" }),
    });

    await expect(
      writeAzureSettle(connection, { sourceId: sourceId(7), priority: "urgent" }),
    ).rejects.toThrow("Set the Urgent priority values on the Azure DevOps connection");
    expect(azure.patches).toEqual([]);

    const result = await writeAzureSettle(connection, { sourceId: sourceId(7), state: "Resolved" });
    expect(result.priority).toBeUndefined();
  });

  it.each([
    "ticket-123",
    "https://dev.azure.com/contoso/Mercury/tickets/123",
    "https://dev.azure.com/another-org/Mercury/_workitems/edit/123",
    "https://dev.azure.com/contoso-other/Mercury/_workitems/edit/123",
    "https://example.com/contoso/Mercury/_workitems/edit/123",
    "https://dev.azure.com/contoso/Mercury/_workitems/edit/0",
    "https://dev.azure.com/contoso/Mercury/_workitems/edit/9007199254740992",
  ])("refuses to read or write an unrelated work item: %s", async (invalidSourceId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAzureSettleStates(buildConnection(), invalidSourceId)).rejects.toThrow(
      "is not an Azure DevOps work item",
    );
    await expect(
      writeAzureSettle(buildConnection(), { sourceId: invalidSourceId, state: "Closed" }),
    ).rejects.toThrow("is not an Azure DevOps work item");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch a tracked item from another organization during done sync", async () => {
    fakeAzureDevOps({ items: { 7: task("Done", "Closed") }, queryIds: [] });

    const result = await syncAzureDevOpsConnection(buildConnection(), [
      {
        localWorkItemId: "other-organization",
        sourceId: "https://dev.azure.com/another-org/Mercury/_workitems/edit/7",
      },
    ]);

    expect(result.items).toEqual([]);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("workitemsbatch"))).toBe(false);
  });

  it("refuses a priority without a priority field and passes on Azure DevOps' refusal", async () => {
    fakeAzureDevOps({
      items: { 7: task("Fix login", "Active") },
      rejectPatch: "The field 'State' contains the value 'Done' that is not in the list of supported values",
    });

    await expect(
      writeAzureSettle(buildConnection(), { sourceId: sourceId(7), priority: "urgent" }),
    ).rejects.toThrow("Set a priority field on the Azure DevOps connection");
    await expect(
      writeAzureSettle(buildConnection(), { sourceId: sourceId(7), state: "Done" }),
    ).rejects.toThrow("not in the list of supported values");
    await expect(
      writeAzureSettle(buildConnection(), { sourceId: "not-a-work-item", state: "Closed" }),
    ).rejects.toThrow("is not an Azure DevOps work item");
  });
});
