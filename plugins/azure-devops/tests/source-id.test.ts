import { afterEach, describe, expect, it, vi } from "vitest";
import {
  syncAzureDevOpsConnection,
  type AzureDevOpsConnectionInput,
} from "../src/azure-devops.ts";
import {
  DEFAULT_PRIORITY_LEVEL_VALUES,
  parsePriorityLevelRanges,
} from "../src/priority-levels.ts";
import { AGILE_TASK_STATES } from "./work-item-type-states.ts";
import { ALL_ACCESS, stubAzureFetch } from "./support/azure-ajour.ts";

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function buildConnection(organizationUrl: string): AzureDevOpsConnectionInput {
  return {
    id: "connection-1",
    label: "Main connection",
    tenantLabel: "Acme",
    organizationUrl,
    access: ALL_ACCESS,
    queryScope: "assigned_to_me",
    priorityLevels: parsePriorityLevelRanges(DEFAULT_PRIORITY_LEVEL_VALUES),
  };
}

/** Task 42 is open under User Story 41, both in project MyProject. */
function fakeAzureDevOps(baseAddress: string, closed: number[] = []) {
  const item = (id: number, type: string, state: string) => ({
    id,
    fields: {
      "System.Title": `Item ${id}`,
      "System.State": state,
      "System.TeamProject": "MyProject",
      "System.WorkItemType": type,
    },
    relations:
      id === 42
        ? [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://x/_apis/wit/workItems/41" }]
        : [],
  });
  const items = new Map([
    [41, item(41, "User Story", closed.includes(41) ? "Closed" : "Active")],
    [42, item(42, "Task", closed.includes(42) ? "Closed" : "Active")],
  ]);
  stubAzureFetch(
    async (input, init) => {
      const url = String(input);
      if (url.includes("/workitemtypes/")) return json({ value: AGILE_TASK_STATES });
      if (url.includes("/_apis/wit/wiql")) return json({ workItems: [{ id: 42 }] });
      if (url.includes("/_apis/wit/fields")) return json({ value: [] });
      if (url.includes("/_apis/wit/workitemsbatch")) {
        const body = JSON.parse(String(init.body)) as { ids: number[] };
        return json({ value: body.ids.flatMap((id) => (items.has(id) ? [items.get(id)] : [])) });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    { baseAddress },
  );
}

const FORMS = [
  {
    name: "dev.azure.com",
    saved: "https://dev.azure.com/acme/MyProject",
    root: "https://dev.azure.com/acme",
  },
  {
    name: "visualstudio.com",
    saved: "https://acme.visualstudio.com/MyProject",
    root: "https://acme.visualstudio.com",
  },
];

describe("work item identity when a project URL is corrected", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const form of FORMS) {
    describe(form.name, () => {
      const doubled = (id: number) => `${form.saved}/MyProject/_workitems/edit/${id}`;
      const corrected = (id: number) => `${form.root}/MyProject/_workitems/edit/${id}`;

      it("keeps the id Ajour has, links to the corrected address, and imports nothing new", async () => {
        fakeAzureDevOps(form.root);

        const result = await syncAzureDevOpsConnection(buildConnection(form.root), [
          { localWorkItemId: "task", sourceId: doubled(42) },
          { localWorkItemId: "story", sourceId: doubled(41) },
        ]);

        expect(result.items.map((item) => item.sourceId)).toEqual([doubled(42)]);
        expect(result.items[0]).toMatchObject({
          externalId: "42",
          sourceUrl: corrected(42),
          parentSourceId: doubled(41),
        });
      });

      it("reports no local item as missing, so none is archived or duplicated", async () => {
        fakeAzureDevOps(form.root);
        const local = [
          { localWorkItemId: "task", sourceId: doubled(42) },
          { localWorkItemId: "story", sourceId: doubled(41) },
        ];

        const result = await syncAzureDevOpsConnection(buildConnection(form.root), local);

        const returned = new Set(result.items.map((item) => item.sourceId));
        expect(result.items.filter((item) => item.stateDone)).toEqual([]);
        expect(returned.has(corrected(42))).toBe(false);
        expect(returned.has(doubled(42))).toBe(true);
      });

      it("keeps the id of an item that reached a done state, linking to the corrected address", async () => {
        fakeAzureDevOps(form.root, [42]);

        const result = await syncAzureDevOpsConnection(buildConnection(form.root), [
          { localWorkItemId: "task", sourceId: doubled(42) },
        ]);

        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({
          sourceId: doubled(42),
          sourceUrl: corrected(42),
          stateDone: true,
        });
      });

      it("keeps a connection saved at the organization root on the same ids", async () => {
        fakeAzureDevOps(form.root);

        const first = await syncAzureDevOpsConnection(buildConnection(form.root));
        const again = await syncAzureDevOpsConnection(
          buildConnection(form.root),
          first.items.map((item) => ({ localWorkItemId: item.externalId, sourceId: item.sourceId })),
        );

        expect(first.items.map((item) => item.sourceId)).toEqual([corrected(42)]);
        expect(again.items.map((item) => item.sourceId)).toEqual([corrected(42)]);
        expect(again.items[0].sourceUrl).toBe(corrected(42));
      });
    });
  }
});
