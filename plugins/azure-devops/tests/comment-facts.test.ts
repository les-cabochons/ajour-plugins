import { afterEach, describe, expect, it, vi } from "vitest";
import type { AzureDevOpsConnectionInput } from "../src/azure-devops.ts";
import { commentFactsOrder, findAzureCommentFacts } from "../src/comments.ts";
import {
  DEFAULT_PRIORITY_LEVEL_VALUES,
  parsePriorityLevelRanges,
} from "../src/priority-levels.ts";
import { ALL_ACCESS, stubAzureFetch } from "./support/azure-ajour.ts";

const ORG = "https://dev.azure.com/contoso";
const ANA = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const ME = "11111111-2222-3333-4444-555555555555";

function config(): AzureDevOpsConnectionInput {
  return {
    id: "connection-1",
    label: "Main connection",
    tenantLabel: "Contoso",
    organizationUrl: ORG,
    access: ALL_ACCESS,
    queryScope: "assigned_to_me",
    priorityLevels: parsePriorityLevelRanges(DEFAULT_PRIORITY_LEVEL_VALUES),
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sourceId = (id: number) => `${ORG}/Contoso%20Portal/_workitems/edit/${id}`;

/**
 * `comments` maps a work item id to its newest comments, to a status that
 * fails, or to "stall" for a request that only ends when it is aborted.
 * `changed` maps a work item id to its System.ChangedDate.
 */
function fakeAzure(
  comments: Record<number, unknown[] | number | "stall">,
  changed: Record<number, string> = {},
) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/_apis/connectionData")) {
      return json({ authenticatedUser: { id: ME.toUpperCase(), providerDisplayName: "Alex" } });
    }
    if (url.includes("/_apis/wit/workitemsbatch")) {
      const { ids } = JSON.parse(String(init?.body)) as { ids: number[] };
      return json({
        value: ids.map((id) => ({
          id,
          fields: {
            "System.TeamProject": "Contoso Portal",
            ...(changed[id] ? { "System.ChangedDate": changed[id] } : {}),
          },
        })),
      });
    }
    const match = /\/_apis\/wit\/workItems\/(\d+)\/comments\?/.exec(url);
    const found = match ? comments[Number(match[1])] : undefined;
    if (found === "stall") {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    if (typeof found === "number") return json({ message: "Nope" }, found);
    if (found) return json({ comments: found });
    throw new Error(`Unexpected request: ${url}`);
  });
  stubAzureFetch(fetchMock);
  return { requests };
}

describe("Azure DevOps comment facts for settled items", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports the comments posted since each settle, without their text", async () => {
    const { requests } = fakeAzure({
      4821: [
        {
          id: 9,
          text: `Can you look? @<${ME.toUpperCase()}>`,
          format: "markdown",
          createdBy: { id: ANA, displayName: "Ana Silva" },
          createdDate: "2026-10-18T11:00:00Z",
        },
        {
          id: 8,
          text: "Deleted",
          isDeleted: true,
          createdBy: { id: ANA, displayName: "Ana Silva" },
          createdDate: "2026-10-18T10:30:00Z",
        },
        {
          id: 7,
          text: "<p>Before the settle</p>",
          createdBy: { id: ANA, displayName: "Ana Silva" },
          createdDate: "2026-10-18T09:00:00Z",
        },
      ],
      4822: [],
    });

    const result = await findAzureCommentFacts(config(), [
      {
        localWorkItemId: "settled",
        sourceId: sourceId(4821),
        commentsSince: "2026-10-18T10:00:00.000Z",
      },
      {
        localWorkItemId: "quiet",
        sourceId: sourceId(4822),
        commentsSince: "2026-10-18T10:00:00.000Z",
      },
      { localWorkItemId: "active", sourceId: sourceId(4823) },
    ]);

    expect(result).toEqual({
      viewer: { id: ME, displayName: "Alex" },
      commentFacts: [
        {
          localWorkItemId: "settled",
          comments: [
            {
              id: "9",
              author: { id: ANA, displayName: "Ana Silva" },
              createdAt: "2026-10-18T11:00:00Z",
              mentionsViewer: true,
            },
          ],
        },
      ],
    });
    const commentRequests = requests.filter((url) => url.includes("/comments?"));
    expect(commentRequests).toHaveLength(2);
    expect(new URL(commentRequests[0]!).searchParams.get("$top")).toBe("20");
    expect(new URL(commentRequests[0]!).searchParams.get("order")).toBe("desc");
  });

  it("skips an item whose comments fail and keeps the others", async () => {
    fakeAzure({
      4821: 403,
      4822: [
        {
          id: 3,
          text: "<p>Done on my side</p>",
          createdBy: { id: ANA, displayName: "Ana Silva" },
          createdDate: "2026-10-18T11:00:00Z",
        },
      ],
    });

    const result = await findAzureCommentFacts(config(), [
      { localWorkItemId: "denied", sourceId: sourceId(4821), commentsSince: "2026-10-18T10:00:00Z" },
      { localWorkItemId: "open", sourceId: sourceId(4822), commentsSince: "2026-10-18T10:00:00Z" },
    ]);

    expect(result.commentFacts.map((facts) => facts.localWorkItemId)).toEqual(["open"]);
  });

  it("asks nothing when no item is settled", async () => {
    const { requests } = fakeAzure({});

    await expect(
      findAzureCommentFacts(config(), [{ localWorkItemId: "active", sourceId: sourceId(4821) }]),
    ).resolves.toEqual({ commentFacts: [] });
    expect(requests).toEqual([]);
  });

  const fromAna = (id: number) => ({
    id,
    text: "<p>Any news?</p>",
    createdBy: { id: ANA, displayName: "Ana Silva" },
    createdDate: "2026-10-18T11:00:00Z",
  });
  const settledItem = (id: number) => ({
    localWorkItemId: `local-${id}`,
    sourceId: sourceId(id),
    commentsSince: "2026-10-18T10:00:00Z",
  });

  it("gives up on a stalled item and keeps the others", async () => {
    fakeAzure({ 4821: "stall", 4822: [fromAna(3)] });

    const result = await findAzureCommentFacts(
      config(),
      [settledItem(4821), settledItem(4822)],
      { budgetMs: 5_000, requestTimeoutMs: 50 },
    );

    expect(result.commentFacts.map((facts) => facts.localWorkItemId)).toEqual([
      "local-4822",
    ]);
  });

  it("stops reading comments when its time budget runs out", async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7];
    const { requests } = fakeAzure(
      Object.fromEntries(ids.map((id) => [id, "stall" as const])),
    );

    const result = await findAzureCommentFacts(config(), ids.map(settledItem), {
      budgetMs: 80,
      requestTimeoutMs: 1_000,
    });

    expect(result.commentFacts).toEqual([]);
    // The first five ran out the budget; the other two were never asked.
    expect(requests.filter((url) => url.includes("/comments?"))).toHaveLength(5);
  });

  it("reads the items changed since their settle first", async () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const { requests } = fakeAzure(
      Object.fromEntries(ids.map((id) => [id, id === 6 ? [fromAna(9)] : []])),
      {
        1: "2026-10-18T09:00:00Z",
        2: "2026-10-18T09:00:00Z",
        3: "2026-10-18T09:00:00Z",
        4: "2026-10-18T09:00:00Z",
        5: "2026-10-18T09:00:00Z",
        6: "2026-10-18T11:00:00Z",
      },
    );

    const result = await findAzureCommentFacts(config(), ids.map(settledItem));

    const first = requests.find((url) => url.includes("/comments?"));
    expect(first).toContain("/workItems/6/comments?");
    expect(result.commentFacts.map((facts) => facts.localWorkItemId)).toEqual([
      "local-6",
    ]);
  });

  it("reads the comments of the most recently settled batch before naming the next batch's projects", async () => {
    const ids = Array.from({ length: 201 }, (_, index) => index + 1);
    const { requests } = fakeAzure(Object.fromEntries(ids.map((id) => [id, []])));

    await findAzureCommentFacts(
      config(),
      ids.map((id) => ({
        localWorkItemId: `local-${id}`,
        sourceId: sourceId(id),
        // Item 201 was settled first, so it goes in the later batch.
        commentsSince: id === 201 ? "2026-10-17T10:00:00Z" : "2026-10-18T10:00:00Z",
      })),
      // The older items keep their order.
      { budgetMs: 10_000, requestTimeoutMs: 4_000, random: () => 0 },
    );

    const batches = requests
      .map((url, index) => ({ url, index }))
      .filter(({ url }) => url.includes("/workitemsbatch"));
    const firstComments = requests.findIndex((url) => url.includes("/comments?"));
    expect(batches).toHaveLength(2);
    expect(firstComments).toBeLessThan(batches[1]!.index);
    expect(requests.at(-1)).toContain("/workItems/201/comments?");
  });

  it("reads from a random point each sync, most recently settled first from there", () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({
      name: `item-${index + 1}`,
      since: 100 - index,
    }));

    const names = (random: number) =>
      commentFactsOrder(entries, () => random).map((entry) => entry.name);

    expect(names(0)).toEqual(["item-1", "item-2", "item-3", "item-4", "item-5", "item-6"]);
    expect(names(0.5)).toEqual(["item-4", "item-5", "item-6", "item-1", "item-2", "item-3"]);
  });

  it("gets to an old item when newer ones stall, at a sync that starts with it", async () => {
    const ids = Array.from({ length: 16 }, (_, index) => index + 1);
    // Item 16 was settled first; the fifteen newer ones never answer.
    fakeAzure(
      Object.fromEntries(ids.map((id) => [id, id === 16 ? [fromAna(16)] : "stall"])),
    );

    const result = await findAzureCommentFacts(
      config(),
      ids.map((id) => ({
        localWorkItemId: `local-${id}`,
        sourceId: sourceId(id),
        commentsSince: new Date(Date.parse("2026-10-18T10:00:00Z") - id * 60_000).toISOString(),
      })),
      // This sync starts at the oldest, item 16. The budget fits only the
      // first group of reads, whose stalled requests time out at 100 ms.
      { budgetMs: 120, requestTimeoutMs: 100, random: () => 0.99 },
    );

    expect(result.commentFacts.map((facts) => facts.localWorkItemId)).toEqual([
      "local-16",
    ]);
  });
});
