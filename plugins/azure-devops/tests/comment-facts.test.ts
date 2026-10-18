import { afterEach, describe, expect, it, vi } from "vitest";
import type { AzureDevOpsConnectionInput } from "../src/azure-devops.ts";
import { findAzureCommentFacts } from "../src/comments.ts";
import {
  DEFAULT_PRIORITY_LEVEL_VALUES,
  parsePriorityLevelRanges,
} from "../src/priority-levels.ts";

const ORG = "https://dev.azure.com/contoso";
const ANA = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const ME = "11111111-2222-3333-4444-555555555555";

function config(): AzureDevOpsConnectionInput {
  return {
    id: "connection-1",
    label: "Main connection",
    tenantLabel: "Contoso",
    organizationUrl: ORG,
    personalAccessToken: "secret",
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

/** `comments` maps a work item id to its newest comments, or to a status that fails. */
function fakeAzure(comments: Record<number, unknown[] | number>) {
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
        value: ids.map((id) => ({ id, fields: { "System.TeamProject": "Contoso Portal" } })),
      });
    }
    const match = /\/_apis\/wit\/workItems\/(\d+)\/comments\?/.exec(url);
    const found = match ? comments[Number(match[1])] : undefined;
    if (typeof found === "number") return json({ message: "Nope" }, found);
    if (found) return json({ comments: found });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
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
});
