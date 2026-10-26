import { afterEach, describe, expect, it, vi } from "vitest";
import type { AzureDevOpsConnectionInput } from "../src/azure-devops.ts";
import {
  deleteAzureItemComment,
  editAzureItemComment,
  searchAzureItemPeople,
  setAzureItemCommentReaction,
} from "../src/comments.ts";
import {
  DEFAULT_PRIORITY_LEVEL_VALUES,
  parsePriorityLevelRanges,
} from "../src/priority-levels.ts";
import { ALL_ACCESS, deriveAddress, manifest, stubAzureFetch } from "./support/azure-ajour.ts";

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

/** Records each comment request; `answer` replies to everything but the project lookup. */
function fakeAzure(answer: (method: string, url: URL) => Response) {
  const calls: Array<{ method: string; url: URL; body?: unknown }> = [];
  stubAzureFetch(vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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

  const BRUNO = "33333333-3333-3333-3333-333333333333";

  /** A reply, or "stall" for a request that answers only when it times out. */
  type Answer = Response | ((project?: string) => Response) | "stall";

  /**
   * Answers the item, its comments, the project's recent work items and the
   * identities search; records the identities search URLs and the queries.
   */
  function fakePeople(answers: {
    item?: Answer;
    comments?: Answer;
    identities?: Answer;
    projectItems?: Answer;
    projectPeople?: Answer;
  }) {
    const searches: URL[] = [];
    const projectQueries: Array<{ project: string; query: string }> = [];
    const commentProjects: string[] = [];
    const reply = (
      answer: Answer | undefined,
      empty: unknown,
      signal?: AbortSignal | null,
      project?: string,
    ) =>
      answer === "stall"
        ? new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason));
          })
        : typeof answer === "function"
          ? answer(project)
          : (answer ?? json(empty));
    stubAzureFetch(vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/_apis/identities")) {
          searches.push(url);
          return reply(answers.identities, { value: [] }, init?.signal);
        }
        if (url.pathname.endsWith("/4821/comments")) {
          commentProjects.push(decodeURIComponent(url.pathname.split("/")[2]!));
          return reply(answers.comments, { comments: [] }, init?.signal);
        }
        const wiql = /\/([^/]+)\/_apis\/wit\/wiql$/.exec(url.pathname);
        if (wiql) {
          const project = decodeURIComponent(wiql[1]!);
          projectQueries.push({ project, ...JSON.parse(String(init?.body)) });
          return reply(answers.projectItems, { workItems: [] }, init?.signal, project);
        }
        if (url.pathname.endsWith("/_apis/wit/workitemsbatch")) {
          return reply(answers.projectPeople, { value: [] }, init?.signal);
        }
        if (url.pathname.endsWith("/_apis/wit/workitems/4821")) {
          return reply(answers.item, {
            id: 4821,
            fields: { "System.TeamProject": "Contoso Portal" },
          }, init?.signal);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    return Object.assign(searches, { projectQueries, commentProjects });
  }

  const itemWithPeople = () =>
    json({
      id: 4821,
      fields: {
        "System.TeamProject": "Contoso Portal",
        "System.AssignedTo": { id: ANA.toUpperCase(), displayName: "Ana Silva", uniqueName: "ana@contoso.com" },
        "System.CreatedBy": { id: ME, displayName: "Alex Martin", uniqueName: "alex@contoso.com" },
        "System.ChangedBy": { id: ME, displayName: "Alex Martin", uniqueName: "alex@contoso.com" },
      },
    });
  const ANA_SUGGESTION = { id: ANA, displayName: "Ana Silva", email: "ana@contoso.com" };
  const brunoComments = () =>
    json({ comments: [{ id: 9, createdBy: { id: BRUNO, displayName: "Bruno Côté" } }] });

  async function search(query: string) {
    return (await searchAzureItemPeople(config(), { sourceId: SOURCE_ID, query, limit: 8 }))
      .people;
  }

  it("finds active users on the identities host and skips groups", async () => {
    const searches = fakePeople({
      identities: json({
        value: [
          { id: ANA.toUpperCase(), providerDisplayName: "Ana Silva" },
          { id: ME, providerDisplayName: "Andrew Lee", isActive: false },
          { id: "22222222-2222-2222-2222-222222222222", providerDisplayName: "[Contoso]\Analysts", isContainer: true },
        ],
      }),
    });

    expect(await search("An")).toEqual([{ id: ANA, displayName: "Ana Silva" }]);
    expect(searches[0]!.origin + searches[0]!.pathname).toBe(
      "https://vssps.dev.azure.com/contoso/_apis/identities",
    );
    expect(searches[0]!.searchParams.get("filterValue")).toBe("An");
  });

  it("finds the item's people by their last name, a full name or the start of their account", async () => {
    const searches = fakePeople({ item: itemWithPeople, comments: brunoComments });

    expect(await search("silva")).toEqual([ANA_SUGGESTION]);
    expect(await search("  bru   cote ")).toEqual([{ id: BRUNO, displayName: "Bruno Côté" }]);
    expect(await search("ana@con")).toEqual([ANA_SUGGESTION]);
    expect(await search("Ana Silva")).toEqual([ANA_SUGGESTION]);
    expect(await search("ana costa")).toEqual([]);
    expect(searches.map((url) => url.searchParams.get("filterValue"))).toContain("bru cote");
  });

  it("lists the item's people first and each person once", async () => {
    fakePeople({
      item: itemWithPeople,
      identities: json({
        value: [
          { id: "44444444-4444-4444-4444-444444444444", providerDisplayName: "Alba Reyes" },
          { id: ME, providerDisplayName: "Alex Martin" },
        ],
      }),
    });

    expect(await search("al")).toEqual([
      { id: ME, displayName: "Alex Martin", email: "alex@contoso.com" },
      { id: "44444444-4444-4444-4444-444444444444", displayName: "Alba Reyes" },
    ]);
  });

  it("still suggests the item's people when the token can't search identities", async () => {
    fakePeople({
      item: itemWithPeople,
      comments: brunoComments,
      identities: () => new Response("Unauthorized", { status: 401 }),
    });

    expect(await search("côté")).toEqual([{ id: BRUNO, displayName: "Bruno Côté" }]);
  });

  it("keeps the item's fields' people when its comments fail", async () => {
    fakePeople({ item: itemWithPeople, comments: () => json({ message: "Busy" }, 503) });

    expect(await search("silva")).toEqual([ANA_SUGGESTION]);
  });

  it("answers with what it found when a request takes too long", async () => {
    fakePeople({
      item: itemWithPeople,
      comments: "stall",
      identities: "stall",
    });

    const result = await searchAzureItemPeople(
      config(),
      { sourceId: SOURCE_ID, query: "ana", limit: 8 },
      20,
    );
    expect(result.people).toEqual([ANA_SUGGESTION]);
  });

  it("answers a bare @ with the item's people, without searching the organization", async () => {
    const searches = fakePeople({ item: itemWithPeople, comments: brunoComments });

    expect(await search("")).toEqual([
      ANA_SUGGESTION,
      { id: ME, displayName: "Alex Martin", email: "alex@contoso.com" },
      { id: BRUNO, displayName: "Bruno Côté" },
    ]);
    expect(searches).toHaveLength(0);
  });

  it("fails a bare @ when neither the item nor its project can be read", async () => {
    fakePeople({
      item: () => json({ message: "No access" }, 401),
      projectItems: () => json({ message: "No access" }, 401),
    });

    await expect(search("")).rejects.toThrow("Azure DevOps request failed (401)");
  });

  it("gives the organization's users their email", async () => {
    fakePeople({
      identities: json({
        value: [
          {
            id: "44444444-4444-4444-4444-444444444444",
            providerDisplayName: "Alba Reyes",
            properties: { Mail: { $type: "System.String", $value: "alba@contoso.com" } },
          },
          {
            id: "55555555-5555-5555-5555-555555555555",
            providerDisplayName: "Alan Build",
            properties: { Account: { $value: "Build Service" } },
          },
        ],
      }),
    });

    expect(await search("al")).toEqual([
      { id: "44444444-4444-4444-4444-444444444444", displayName: "Alba Reyes", email: "alba@contoso.com" },
      { id: "55555555-5555-5555-5555-555555555555", displayName: "Alan Build" },
    ]);
  });

  const CARLA = "66666666-6666-6666-6666-666666666666";
  const projectWithCarla = () => json({ workItems: [{ id: 7 }, { id: 8 }] });
  const carlaAndAna = () =>
    json({
      value: [
        {
          id: 7,
          fields: {
            "System.AssignedTo": { id: CARLA, displayName: "Carla Diaz", uniqueName: "carla@contoso.com" },
            "System.CreatedBy": { id: ANA, displayName: "Ana Silva", uniqueName: "ana@contoso.com" },
          },
        },
        { id: 8, fields: { "System.ChangedBy": { id: CARLA, displayName: "Carla Diaz", uniqueName: "carla@contoso.com" } } },
      ],
    });

  it("finds people active in the item's project, after the item's own, with only Work Items access", async () => {
    const searches = fakePeople({
      item: itemWithPeople,
      projectItems: projectWithCarla,
      projectPeople: carlaAndAna,
      identities: () => new Response("Unauthorized", { status: 401 }),
    });

    expect(await search("diaz")).toEqual([
      { id: CARLA, displayName: "Carla Diaz", email: "carla@contoso.com" },
    ]);
    expect(await search("")).toEqual([
      ANA_SUGGESTION,
      { id: ME, displayName: "Alex Martin", email: "alex@contoso.com" },
      { id: CARLA, displayName: "Carla Diaz", email: "carla@contoso.com" },
    ]);
    expect(searches.projectQueries[0]).toEqual({
      project: "Contoso Portal",
      query: expect.stringContaining("[System.ChangedDate] >= @today - 180"),
    });
  });

  it("asks for the project's people alongside the item, from the project in the source id", async () => {
    // The item never answers in time, yet the project's people still come.
    fakePeople({ item: "stall", projectItems: projectWithCarla, projectPeople: carlaAndAna });

    const result = await searchAzureItemPeople(
      config(),
      { sourceId: SOURCE_ID, query: "carla", limit: 8 },
      20,
    );
    expect(result.people).toEqual([
      { id: CARLA, displayName: "Carla Diaz", email: "carla@contoso.com" },
    ]);
  });

  it("asks the project the item moved to, not only the one in its source id", async () => {
    const searches = fakePeople({
      item: () =>
        json({
          id: 4821,
          fields: {
            "System.TeamProject": "Contoso Mobile",
            "System.AssignedTo": { id: ANA, displayName: "Ana Silva", uniqueName: "ana@contoso.com" },
          },
        }),
      projectItems: (project) =>
        project === "Contoso Mobile" ? projectWithCarla() : json({ workItems: [] }),
      projectPeople: carlaAndAna,
    });

    expect(await search("carla")).toEqual([
      { id: CARLA, displayName: "Carla Diaz", email: "carla@contoso.com" },
    ]);
    expect(searches.projectQueries.map((query) => query.project)).toEqual([
      "Contoso Portal",
      "Contoso Mobile",
    ]);
    expect(searches.commentProjects).toEqual(["Contoso Portal", "Contoso Mobile"]);
  });

  it("fails only when every search fails", async () => {
    fakePeople({
      item: () => json({ message: "No access" }, 401),
      projectItems: () => json({ message: "No access" }, 401),
      identities: () => new Response("Unauthorized", { status: 401 }),
    });

    await expect(search("ana")).rejects.toThrow("Azure DevOps request failed (401)");
  });

  it("searches people on the identities host Ajour derives for each kind of organization URL", () => {
    const identities = manifest.network!.derivedHosts!.find((host) => host.id === "identities")!;
    expect(deriveAddress(identities.forms, "https://dev.azure.com/contoso/")).toBe(
      "https://vssps.dev.azure.com/contoso",
    );
    expect(deriveAddress(identities.forms, "https://contoso.visualstudio.com")).toBe(
      "https://contoso.vssps.visualstudio.com",
    );
    expect(deriveAddress(identities.forms, "https://tfs.contoso.local/DefaultCollection")).toBe(
      "https://tfs.contoso.local/DefaultCollection",
    );
  });
});
