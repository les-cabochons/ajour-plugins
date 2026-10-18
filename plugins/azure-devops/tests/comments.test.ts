import { afterEach, describe, expect, it, vi } from "vitest";
import type { AzureDevOpsConnectionInput } from "../src/azure-devops.ts";
import { commentBodyToMarkdown, listAzureItemComments } from "../src/comments.ts";
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

/** Azure DevOps answers newest first; `pages` maps a continuation token to a page. */
function fakeComments(pages: Record<string, unknown>) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/_apis/connectionData")) {
      return json({ authenticatedUser: { id: ME.toUpperCase(), providerDisplayName: "Alex" } });
    }
    if (/\/_apis\/wit\/workitems\/4821\?fields=System\.TeamProject/.test(url)) {
      return json({ id: 4821, fields: { "System.TeamProject": "Contoso Portal" } });
    }
    if (url.includes("/_apis/wit/workItems/4821/comments")) {
      const token = new URL(url).searchParams.get("continuationToken") ?? "";
      return json(pages[token]);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests };
}

const SOURCE_ID = `${ORG}/Contoso%20Portal/_workitems/edit/4821`;

describe("Azure DevOps comments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the newest page oldest first, with the viewer, total and an earlier cursor", async () => {
    const { requests } = fakeComments({
      "": {
        totalCount: 7,
        continuationToken: "page-2",
        comments: [
          {
            id: 7,
            text: "<p>Newest</p>",
            format: "html",
            createdBy: { id: ANA, displayName: "Ana Silva" },
            createdDate: "2026-10-17T09:00:00Z",
            modifiedDate: "2026-10-17T09:00:00Z",
          },
          {
            id: 6,
            text: "Older **one**",
            format: "markdown",
            createdBy: { id: ME, displayName: "Alex" },
            createdDate: "2026-10-16T09:00:00Z",
            modifiedDate: "2026-10-16T10:00:00Z",
            reactions: [
              { type: "like", count: 2, isCurrentUserEngaged: true },
              { type: "smile", count: 1, isCurrentUserEngaged: false },
              { type: "heart", count: 0, isCurrentUserEngaged: false },
            ],
          },
        ],
      },
    });

    const result = await listAzureItemComments(config(), { sourceId: SOURCE_ID, limit: 2 });

    expect(result).toEqual({
      viewer: { id: ME, displayName: "Alex" },
      total: 7,
      earlierCursor: "page-2",
      comments: [
        {
          id: "6",
          author: { id: ME, displayName: "Alex" },
          body: "Older **one**",
          createdAt: "2026-10-16T09:00:00Z",
          updatedAt: "2026-10-16T10:00:00Z",
          reactions: [
            { reaction: "like", count: 2, viewerReacted: true },
            { reaction: "laugh", count: 1, viewerReacted: false },
          ],
        },
        {
          id: "7",
          author: { id: ANA, displayName: "Ana Silva" },
          body: "Newest",
          createdAt: "2026-10-17T09:00:00Z",
        },
      ],
    });
    const commentUrl = new URL(requests.find((url) => url.includes("/comments"))!);
    expect(commentUrl.pathname).toBe("/contoso/Contoso%20Portal/_apis/wit/workItems/4821/comments");
    expect(commentUrl.searchParams.get("$top")).toBe("2");
    expect(commentUrl.searchParams.get("order")).toBe("desc");
    expect(commentUrl.searchParams.get("continuationToken")).toBeNull();
  });

  it("loads an earlier page with the cursor and skips deleted comments", async () => {
    fakeComments({
      "page-2": {
        totalCount: 7,
        comments: [
          { id: 2, isDeleted: true, text: "gone", createdDate: "2026-10-11T09:00:00Z" },
          {
            id: 1,
            text: "<p>First</p>",
            format: "html",
            createdBy: { id: ANA, displayName: "Ana Silva" },
            createdDate: "2026-10-10T09:00:00Z",
          },
        ],
      },
    });

    const result = await listAzureItemComments(config(), {
      sourceId: SOURCE_ID,
      limit: 20,
      cursor: "page-2",
    });

    expect(result.comments.map((comment) => comment.id)).toEqual(["1"]);
    expect(result.earlierCursor).toBeUndefined();
  });

  it("refuses a work item outside the connection's organization", async () => {
    fakeComments({});

    await expect(
      listAzureItemComments(config(), {
        sourceId: "https://dev.azure.com/other/Portal/_workitems/edit/4821",
        limit: 5,
      }),
    ).rejects.toThrow("is not an Azure DevOps work item");
  });
});

describe("Azure DevOps comment text", () => {
  it("turns an HTML mention into a mention link and the rest into Markdown", () => {
    expect(
      commentBodyToMarkdown({
        id: 1,
        format: "html",
        text: `<div>Thanks <a href="#" data-vss-mention="version:2.0,${ANA.toUpperCase()}">@Ana Silva</a>, <b>shipping</b> it.</div>`,
      }),
    ).toBe(`Thanks [@Ana Silva](mention:${ANA}), **shipping** it.`);
  });

  it("names a Markdown mention from the rendered text", () => {
    expect(
      commentBodyToMarkdown({
        id: 1,
        format: "markdown",
        text: `Ping @<${ANA}> about it`,
        renderedText: `<p>Ping <a href="#" data-vss-mention="version:2.0,${ANA}">@Ana Silva</a> about it</p>`,
      }),
    ).toBe(`Ping [@Ana Silva](mention:${ANA}) about it`);
  });

  it("treats a numeric 0 format as Markdown", () => {
    expect(commentBodyToMarkdown({ id: 1, format: 0, text: "**kept**" })).toBe("**kept**");
  });
});
