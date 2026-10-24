import { afterEach, describe, expect, it, vi } from "vitest";
import { syncPullRequests, validateConnection } from "../src/plugin.ts";
import { AzureReposClient, checkState, mentions, PullRequestSearch } from "../src/pull-requests.ts";
import type { ConnectorPluginConnection } from "../src/contract.ts";

const ORG = "https://dev.azure.com/contoso";
/** The organization-wide list the search tries first. */
const ORG_PROBE = `${ORG}/_apis/git/pullrequests?$top=1&`;
const VIEWER = "11111111-1111-1111-1111-111111111111";
const ALICE = "22222222-2222-2222-2222-222222222222";
const TEAM = "33333333-3333-3333-3333-333333333333";
const PROJECT = "44444444-4444-4444-4444-444444444444";
const BUILD = "55555555-5555-5555-5555-555555555555";

const viewerIdentity = { id: VIEWER, displayName: "Viewer", uniqueName: "viewer@contoso.com", descriptor: "aad.v" };
const alice = { id: ALICE, displayName: "Alice", uniqueName: "alice@contoso.com", descriptor: "aad.a" };
const buildService = {
  id: BUILD,
  displayName: "Fabrikam Build Service (contoso)",
  uniqueName: "Build\\66666666-6666-6666-6666-666666666666",
  descriptor: "svc.abc",
};
const repository = { id: "repo-1", name: "api", project: { id: PROJECT, name: "Fabrikam Web" } };

function pullRequest(id: number, overrides: Record<string, unknown> = {}) {
  return {
    pullRequestId: id,
    status: "active",
    title: `Change ${id}`,
    creationDate: "2026-10-01T10:00:00Z",
    createdBy: alice,
    reviewers: [],
    mergeStatus: "succeeded",
    lastMergeSourceCommit: { commitId: `sha-${id}` },
    repository,
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Routes = Record<string, unknown>;

/** Answers a request by the first route whose key the URL contains. */
function stubFetch(routes: Routes) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      const url = decodeURIComponent(String(input));
      calls.push(url);
      const key = Object.keys(routes).find((route) => url.includes(route));
      if (!key) return json({ message: "not found" }, 404);
      const body = routes[key];
      return body instanceof Response ? body : json(body);
    }),
  );
  return calls;
}

const connectionData = {
  authenticatedUser: {
    id: VIEWER,
    providerDisplayName: "Viewer",
    properties: { Account: { $type: "System.String", $value: "viewer@contoso.com" } },
  },
};

function connection(config: Record<string, string | number | boolean> = {}): ConnectorPluginConnection {
  return {
    id: "c1",
    pluginId: "azure_repos",
    label: "Work",
    tenantLabel: "Contoso",
    autoSync: true,
    autoSyncIntervalMinutes: 5,
    connectedAt: 0,
    config: { organizationUrl: ORG, personalAccessToken: "secret", ...config },
  };
}

function emptyDetails(id: number) {
  return {
    [`pullRequests/${id}/threads`]: { value: [] },
    [`pullRequests/${id}/iterations`]: { value: [] },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("validateConnection with pull requests", () => {
  it("checks pull request access only when pull requests are on, and keeps the work item values", async () => {
    const calls = stubFetch({ "_apis/connectionData": connectionData, "_apis/git/repositories": { value: [] } });

    const result = await validateConnection(
      {
        organizationUrl: `${ORG}/Fabrikam/`,
        personalAccessToken: " secret ",
        queryScope: "assigned_to_me",
        pullRequestsInclude: " Fabrikam Web/api ",
      },
      { capabilities: ["codeHost"] },
    );

    expect(result).toEqual({
      normalizedConfig: {
        organizationUrl: ORG,
        personalAccessToken: "secret",
        queryScope: "assigned_to_me",
        pullRequestsInclude: "Fabrikam Web/api",
        pullRequestsExclude: "",
        hideDraftPullRequests: false,
        includeTeamReviewRequests: true,
      },
      connectionSummary: { account: "viewer@contoso.com" },
    });
    expect(calls).toEqual([`${ORG}/_apis/connectionData`, `${ORG}/_apis/git/repositories?api-version=7.1`]);
  });

  it("keeps pull request values unchecked while pull requests are off", async () => {
    const calls = stubFetch({});

    await expect(
      validateConnection(
        { organizationUrl: ORG, personalAccessToken: "secret", pullRequestsInclude: "a/b/c" },
        { capabilities: [] },
      ),
    ).resolves.toEqual({
      normalizedConfig: { organizationUrl: ORG, personalAccessToken: "secret", pullRequestsInclude: "a/b/c" },
      connectionSummary: {},
    });
    expect(calls).toHaveLength(0);
  });

  it("explains a rejected token", async () => {
    stubFetch({ "_apis/connectionData": new Response("<html>sign in</html>", { status: 203 }) });

    await expect(
      validateConnection({ organizationUrl: ORG, personalAccessToken: "bad" }, { capabilities: ["codeHost"] }),
    ).rejects.toThrow(/rejected the token/);
  });

  it("asks for Code (Read) when pull requests cannot be listed", async () => {
    stubFetch({
      "_apis/connectionData": connectionData,
      "_apis/git/repositories": json({ message: "denied" }, 403),
    });

    await expect(
      validateConnection({ organizationUrl: ORG, personalAccessToken: "secret" }, { capabilities: ["codeHost"] }),
    ).rejects.toThrow(/Code \(Read\)/);
  });
});

describe("syncPullRequests", () => {
  it("maps a requested review with votes, comments, pushes and checks", async () => {
    const calls = stubFetch({
      "_apis/connectionData": connectionData,
      [ORG_PROBE]: { value: [] },
      "_apis/teams": { value: [{ id: TEAM }] },
      [`reviewerId=${VIEWER}`]: {
        value: [
          pullRequest(7, {
            reviewers: [
              { ...viewerIdentity, vote: 0 },
              { ...alice, vote: -5 },
              { id: TEAM, displayName: "[Fabrikam Web]\\Reviewers", isContainer: true, vote: 0 },
            ],
          }),
        ],
      },
      [`creatorId=${VIEWER}`]: { value: [] },
      [`reviewerId=${TEAM}`]: { value: [] },
      "pullRequests/7/threads": {
        value: [
          {
            id: 1,
            publishedDate: "2026-10-01T11:00:00Z",
            properties: {
              CodeReviewThreadType: { $value: "ReviewersUpdate" },
              CodeReviewReviewersUpdatedAddedIdentity: { $value: "1" },
              CodeReviewReviewersUpdatedByIdentity: { $value: "2" },
            },
            identities: { "1": viewerIdentity, "2": alice },
            comments: [{ id: 1, commentType: "system", publishedDate: "2026-10-01T11:00:00Z", content: "added" }],
          },
          {
            id: 2,
            publishedDate: "2026-10-01T12:00:00Z",
            properties: {
              CodeReviewThreadType: { $value: "VoteUpdate" },
              CodeReviewVoteResult: { $type: "System.String", $value: "-5" },
              CodeReviewVotedByIdentity: { $value: "1" },
            },
            identities: { "1": alice },
            comments: [{ id: 1, commentType: "system", publishedDate: "2026-10-01T12:00:00Z" }],
          },
          {
            id: 3,
            publishedDate: "2026-10-01T13:00:00Z",
            lastUpdatedDate: "2026-10-02T09:00:00Z",
            comments: [
              {
                id: 1,
                author: alice,
                commentType: "text",
                publishedDate: "2026-10-01T13:00:00Z",
                content: `Can you look, @<${VIEWER.toUpperCase()}>?`,
              },
              { id: 2, author: viewerIdentity, commentType: "text", publishedDate: "2026-10-01T14:00:00Z", content: "Yes" },
              { id: 3, author: alice, isDeleted: true, commentType: "text", publishedDate: "2026-10-01T15:00:00Z" },
            ],
          },
          {
            id: 4,
            publishedDate: "2026-10-01T16:00:00Z",
            comments: [{ id: 1, author: buildService, commentType: "text", publishedDate: "2026-10-01T16:00:00Z", content: "Coverage 80%" }],
          },
        ],
      },
      "pullRequests/7/iterations": {
        value: [
          { id: 2, createdDate: "2026-10-01T18:00:00Z", author: alice, sourceRefCommit: { commitId: "sha-7" } },
          { id: 1, createdDate: "2026-10-01T10:00:00Z", author: alice, sourceRefCommit: { commitId: "sha-0" } },
        ],
      },
      "_apis/policy/evaluations": {
        value: [
          { status: "running", configuration: { type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" } } },
          { status: "rejected", configuration: { type: { id: "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd" } } },
        ],
      },
    });

    const result = await syncPullRequests(connection(), { tracked: [] });

    expect(result.viewer).toEqual({ login: "viewer@contoso.com", displayName: "Viewer", isBot: false });
    expect(result.instanceUrl).toBe(ORG);
    expect(result.pullRequests).toHaveLength(1);
    const facts = result.pullRequests[0]!;
    expect(facts).toMatchObject({
      id: "7",
      repository: "Fabrikam Web/api",
      number: 7,
      url: `${ORG}/Fabrikam%20Web/_git/api/pullrequest/7`,
      title: "Change 7",
      author: { login: "alice@contoso.com", displayName: "Alice", isBot: false },
      state: "open",
      draft: false,
      createdAt: Date.parse("2026-10-01T10:00:00Z"),
      updatedAt: Date.parse("2026-10-02T09:00:00Z"),
      viewerIsAuthor: false,
      headSha: "sha-7",
      lastPushedAt: Date.parse("2026-10-01T18:00:00Z"),
      lastPushActor: { login: "alice@contoso.com" },
      checks: "pending",
      mergeability: "mergeable",
    });
    expect(facts.reviewRequests).toEqual([
      { kind: "user", name: "viewer@contoso.com", includesViewer: true },
      { kind: "team", name: "[Fabrikam Web]\\Reviewers", includesViewer: true },
    ]);
    expect(facts.reviewRequestEvents).toEqual([
      {
        id: "reviewers-1",
        author: { login: "alice@contoso.com", displayName: "Alice", isBot: false },
        createdAt: Date.parse("2026-10-01T11:00:00Z"),
        includesViewer: true,
      },
    ]);
    expect(facts.reviews).toEqual([
      {
        id: "vote-2",
        author: { login: "alice@contoso.com", displayName: "Alice", isBot: false },
        verdict: "changes_requested",
        submittedAt: Date.parse("2026-10-01T12:00:00Z"),
        mentionsViewer: false,
      },
    ]);
    expect(facts.comments.map(({ id, author, threadId, mentionsViewer }) => [id, author.login, author.isBot, threadId, mentionsViewer])).toEqual([
      ["3-1", "alice@contoso.com", false, "3", true],
      ["3-2", "viewer@contoso.com", false, "3", false],
      ["4-1", buildService.uniqueName, true, "4", false],
    ]);
    expect(calls.some((url) => url.includes(`artifactId=vstfs:///CodeReview/CodeReviewId/${PROJECT}/7`))).toBe(true);
  });

  it("merges searches, applies filters, and reports tracked pull requests that closed", async () => {
    stubFetch({
      "_apis/connectionData": connectionData,
      [ORG_PROBE]: { value: [] },
      [`creatorId=${VIEWER}`]: {
        value: [
          pullRequest(1, { createdBy: viewerIdentity }),
          pullRequest(2, { createdBy: viewerIdentity, isDraft: true }),
          pullRequest(3, { createdBy: viewerIdentity, repository: { ...repository, name: "legacy" } }),
        ],
      },
      [`reviewerId=${VIEWER}`]: { value: [pullRequest(1, { createdBy: viewerIdentity })] },
      "_apis/git/pullrequests/9?": pullRequest(9, { status: "completed", closedDate: "2026-10-03T00:00:00Z" }),
      ...emptyDetails(1),
      ...emptyDetails(9),
    });

    const result = await syncPullRequests(
      connection({ includeTeamReviewRequests: false, hideDraftPullRequests: true, pullRequestsExclude: "Fabrikam Web/legacy" }),
      { tracked: [{ repository: "Fabrikam Web/api", number: 9 }, { repository: "Fabrikam Web/api", number: 10 }] },
    );

    expect(result.pullRequests.map((facts) => [facts.number, facts.state, facts.viewerIsAuthor])).toEqual([
      [1, "open", true],
      [9, "merged", false],
    ]);
    expect(result.pullRequests[1]).toMatchObject({ closedAt: Date.parse("2026-10-03T00:00:00Z"), checks: "none" });
  });

  it("pages through search results", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => pullRequest(index + 1));
    const calls = stubFetch({
      "_apis/connectionData": connectionData,
      [ORG_PROBE]: { value: [] },
      [`creatorId=${VIEWER}&$top=100&$skip=0`]: { value: firstPage },
      [`creatorId=${VIEWER}&$top=100&$skip=100`]: { value: [pullRequest(101)] },
      [`reviewerId=${VIEWER}`]: { value: [] },
      "/threads": { value: [] },
      "/iterations": { value: [] },
    });

    const result = await syncPullRequests(connection({ includeTeamReviewRequests: false }), { tracked: [] });

    expect(result.pullRequests).toHaveLength(101);
    expect(calls.filter((url) => url.includes(`creatorId=${VIEWER}`))).toHaveLength(2);
  });

  it("explains missing team access", async () => {
    stubFetch({ "_apis/connectionData": connectionData, "_apis/teams": json({ message: "denied" }, 403) });

    await expect(syncPullRequests(connection(), { tracked: [] })).rejects.toThrow(/Project and Team \(Read\)/);
  });
});

describe("PullRequestSearch", () => {
  it("searches each project when the organization-wide list is not routed", async () => {
    const OTHER = "66666666-6666-6666-6666-666666666666";
    const calls = stubFetch({
      [ORG_PROBE]: json({ message: "not found" }, 404),
      "_apis/git/repositories": {
        value: [
          { id: "r1", project: { id: PROJECT } },
          { id: "r2", project: { id: PROJECT } },
          { id: "r3", project: { id: OTHER } },
        ],
      },
      [`${ORG}/${PROJECT}/_apis/git/pullrequests?`]: { value: [pullRequest(1)] },
      [`${ORG}/${OTHER}/_apis/git/pullrequests?`]: { value: [pullRequest(2)] },
    });

    const search = new PullRequestSearch(new AzureReposClient(ORG, "secret"));
    const found = await search.run({ "searchCriteria.creatorId": VIEWER });

    expect(found.map((pr) => pr.pullRequestId)).toEqual([1, 2]);
    expect(calls).toEqual([
      `${ORG}/_apis/git/pullrequests?$top=1&api-version=7.1`,
      `${ORG}/_apis/git/repositories?api-version=7.1`,
      `${ORG}/${PROJECT}/_apis/git/pullrequests?searchCriteria.status=active&searchCriteria.creatorId=${VIEWER}&$top=100&$skip=0&api-version=7.1`,
      `${ORG}/${OTHER}/_apis/git/pullrequests?searchCriteria.status=active&searchCriteria.creatorId=${VIEWER}&$top=100&$skip=0&api-version=7.1`,
    ]);
  });

  it("uses the organization-wide list once it answers", async () => {
    const calls = stubFetch({
      [ORG_PROBE]: { value: [] },
      [`${ORG}/_apis/git/pullrequests?searchCriteria`]: { value: [pullRequest(3)] },
    });

    const search = new PullRequestSearch(new AzureReposClient(ORG, "secret"));
    await search.run({ "searchCriteria.creatorId": VIEWER });
    await search.run({ "searchCriteria.reviewerId": VIEWER });

    expect(calls.filter((url) => url.includes("$top=1&"))).toHaveLength(1);
    expect(calls.some((url) => url.includes("_apis/git/repositories"))).toBe(false);
  });

  it("asks for Code (Read) when the token cannot list pull requests", async () => {
    stubFetch({ [ORG_PROBE]: json({ message: "denied" }, 403) });

    const search = new PullRequestSearch(new AzureReposClient(ORG, "secret"));
    await expect(search.run({})).rejects.toThrow(/Code \(Read\)/);
  });
});

describe("mentions", () => {
  it("matches Markdown and HTML mentions of the identity only", () => {
    expect(mentions(`hi @<${VIEWER}>`, VIEWER)).toBe(true);
    expect(mentions(`<a href="#" data-vss-mention="version:2.0,${VIEWER}">@Viewer</a>`, VIEWER)).toBe(true);
    expect(mentions(`hi @<${ALICE}>`, VIEWER)).toBe(false);
    expect(mentions("hi @Viewer", VIEWER)).toBe(false);
  });
});

describe("checkState", () => {
  const build = (status: string) => ({ status, configuration: { type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" } } });

  it.each([
    [undefined, "none"],
    [[build("notApplicable")], "none"],
    [[build("approved")], "success"],
    [[build("approved"), build("queued")], "pending"],
    [[build("running"), build("broken")], "failure"],
  ])("reads %j as %s", (evaluations, expected) => {
    expect(checkState(evaluations)).toBe(expected);
  });
});
