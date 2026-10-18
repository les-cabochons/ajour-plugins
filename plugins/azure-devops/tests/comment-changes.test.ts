import { afterEach, describe, expect, it, vi } from "vitest";
import type { AzureDevOpsConnectionInput } from "../src/azure-devops.ts";
import {
  deleteAzureItemComment,
  editAzureItemComment,
  identitiesBaseUrl,
  searchAzureItemPeople,
  setAzureItemCommentReaction,
} from "../src/comments.ts";
import {
  DEFAULT_PRIORITY_LEVEL_VALUES,
  parsePriorityLevelRanges,
} from "../src/priority-levels.ts";

const ORG = "https://dev.azure.com/contoso";
const ANA = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const ME = "11111111-2222-3333-4444-555555555555";
const SOURCE_ID = `${ORG}/Contoso%20Portal/_workitems/edit/4821`;
const COMMENT = "/contoso/Contoso%20Portal/_apis/wit/workItems/4821/comments/7";

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

/** Records each comment request; `answer` replies to everything but the project lookup. */
function fakeAzure(answer: (method: string, url: URL) => Response) {
  const calls: Array<{ method: string; url: URL; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/_apis/wit/workitems/4821")) {
        return json({ id: 4821, fields: { "System.TeamProject": "Contoso Portal" } });
      }
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return answer(method, url);
    }),
  );
  return calls;
}

describe("changing Azure DevOps comments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("edits a comment as Markdown and returns Ajour's text", async () => {
    const calls = fakeAzure(() =>
      json({
        id: 7,
        text: `Code first, @<${ANA}>.`,
        format: "markdown",
        createdBy: { id: ME, displayName: "Alex" },
        createdDate: "2026-10-16T09:00:00Z",
        modifiedDate: "2026-10-18T09:00:00Z",
      }),
    );
    const body = `Code first, [@Ana Silva](mention:${ANA}).`;

    const result = await editAzureItemComment(config(), {
      sourceId: SOURCE_ID,
      commentId: "7",
      body,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url.pathname).toBe(COMMENT);
    expect(calls[0]!.url.searchParams.get("format")).toBe("markdown");
    expect(calls[0]!.body).toEqual({ text: `Code first, @<${ANA}>.` });
    expect(result.comment).toMatchObject({
      id: "7",
      body,
      updatedAt: "2026-10-18T09:00:00Z",
    });
  });

  it("deletes a comment that answers with no body", async () => {
    const calls = fakeAzure(() => new Response(null, { status: 204 }));

    await expect(
      deleteAzureItemComment(config(), { sourceId: SOURCE_ID, commentId: "7" }),
    ).resolves.toEqual({});
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["DELETE", COMMENT],
    ]);
  });

  it("adds and removes a reaction, then returns the comment's reactions", async () => {
    const calls = fakeAzure((method) =>
      method === "GET"
        ? json({
            id: 7,
            text: "x",
            format: "markdown",
            createdDate: "2026-10-16T09:00:00Z",
            reactions: [
              { type: "like", count: 2, isCurrentUserEngaged: true },
              { type: "smile", count: 1, isCurrentUserEngaged: true },
            ],
          })
        : json({ type: "smile", count: 1, isCurrentUserEngaged: true }),
    );

    const result = await setAzureItemCommentReaction(config(), {
      sourceId: SOURCE_ID,
      commentId: "7",
      reaction: "laugh",
      reacted: true,
    });
    await setAzureItemCommentReaction(config(), {
      sourceId: SOURCE_ID,
      commentId: "7",
      reaction: "like",
      reacted: false,
    });

    expect(
      calls.map((call) => [call.method, call.url.pathname]),
    ).toEqual([
      ["PUT", `${COMMENT}/reactions/smile`],
      ["GET", COMMENT],
      ["DELETE", `${COMMENT}/reactions/like`],
      ["GET", COMMENT],
    ]);
    expect(result.reactions).toEqual([
      { reaction: "like", count: 2, viewerReacted: true },
      { reaction: "laugh", count: 1, viewerReacted: true },
    ]);
  });

  it("refuses a reaction Azure DevOps doesn't have and a comment id that isn't one", async () => {
    fakeAzure(() => json({}));

    await expect(
      setAzureItemCommentReaction(config(), {
        sourceId: SOURCE_ID,
        commentId: "7",
        reaction: "rocket",
        reacted: true,
      }),
    ).rejects.toThrow('Azure DevOps has no "rocket" reaction.');
    await expect(
      deleteAzureItemComment(config(), { sourceId: SOURCE_ID, commentId: "7/../8" }),
    ).rejects.toThrow("is not an Azure DevOps comment");
  });
});

describe("searching Azure DevOps people", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("finds active users on the identities host and skips groups", async () => {
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        urls.push(url);
        return json({
          value: [
            { id: ANA.toUpperCase(), providerDisplayName: "Ana Silva" },
            { id: ME, providerDisplayName: "Andrew Lee", isActive: false },
            { id: "22222222-2222-2222-2222-222222222222", providerDisplayName: "[Contoso]\\Analysts", isContainer: true },
          ],
        });
      }),
    );

    const result = await searchAzureItemPeople(config(), {
      sourceId: SOURCE_ID,
      query: "An",
      limit: 8,
    });

    expect(result.people).toEqual([{ id: ANA, displayName: "Ana Silva" }]);
    expect(urls[0]!.origin + urls[0]!.pathname).toBe(
      "https://vssps.dev.azure.com/contoso/_apis/identities",
    );
    expect(urls[0]!.searchParams.get("filterValue")).toBe("An");
  });

  it("finds the identities host for each kind of organization URL", () => {
    expect(identitiesBaseUrl("https://dev.azure.com/contoso/")).toBe(
      "https://vssps.dev.azure.com/contoso",
    );
    expect(identitiesBaseUrl("https://contoso.visualstudio.com")).toBe(
      "https://contoso.vssps.visualstudio.com",
    );
    expect(identitiesBaseUrl("https://tfs.contoso.local/DefaultCollection")).toBe(
      "https://tfs.contoso.local/DefaultCollection",
    );
  });
});
