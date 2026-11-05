import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, mentions } from "../src/github.ts";
import { syncPullRequests, validateConnection } from "../src/plugin.ts";
import { installAjour, json, pluginConnection, stubGitHub } from "./support/github-ajour.ts";

const viewer = {
  __typename: "User",
  login: "octocat",
  name: "The Octocat",
  avatarUrl: "https://example.com/a.png",
};
const alice = { __typename: "User", login: "alice", avatarUrl: "https://example.com/b.png" };
const bot = { __typename: "Bot", login: "codecov", avatarUrl: "https://example.com/c.png" };

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "PR_1",
    number: 1,
    url: "https://github.com/acme/api/pull/1",
    title: "Add rate limits",
    isDraft: false,
    state: "OPEN",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
    closedAt: null,
    headRefOid: "abc123",
    headRefName: "change/rate-limits",
    headRepository: { nameWithOwner: "alice/api" },
    mergeable: "MERGEABLE",
    repository: { nameWithOwner: "acme/api" },
    author: alice,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
    timelineItems: {
      nodes: [{ __typename: "PullRequestCommit", commit: { committedDate: "2026-10-01T12:00:00Z" } }],
    },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    ...overrides,
  };
}

function searchResult(nodes: unknown[]) {
  return { search: { issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
}

const connection = pluginConnection({ includeTeamRequests: true });

describe("GitHub plugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("validates the connection and summarizes the account, returning no token", async () => {
    const { requests } = stubGitHub(() => ({ viewer }));

    await expect(
      validateConnection(
        pluginConnection({ label: "Work", hostUrl: "https://github.com/", include: "Acme" }),
        { capabilities: ["connector", "codeHost"] },
      ),
    ).resolves.toEqual({
      normalizedConfig: {
        label: "Work",
        hostUrl: "https://github.com",
        include: "acme",
        exclude: "",
        hideDrafts: false,
        includeTeamRequests: true,
      },
      connectionSummary: { account: "octocat", host: "github.com" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      host: "graphql",
      method: "POST",
      path: "/graphql",
      contentType: "application/json",
      body: { variables: {} },
    });
  });

  it("returns direct and team re-request events with their actors and times", async () => {
    const requested = pullRequest({
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "octocat" } }] },
      reviewRequestTimeline: { nodes: [
        { id: "request1", actor: alice, createdAt: "2026-10-02T10:00:00Z", requestedReviewer: { __typename: "User", login: "OctoCat" } },
        { id: "request2", actor: viewer, createdAt: "2026-10-02T11:00:00Z", requestedReviewer: { __typename: "Team", slug: "backend", organization: { login: "acme" } } },
        { id: "request3", actor: bot, createdAt: "2026-10-02T12:00:00Z", requestedReviewer: { __typename: "User", login: "alice" } },
      ] },
    });
    const { calls } = stubGitHub((call) => {
      if (call.query.includes("organizations")) return { viewer: { organizations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ login: "acme", teams: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ slug: "backend" }] } }] } } };
      if (call.query.includes("search(")) return searchResult([requested]);
      return { viewer };
    });
    const result = await syncPullRequests(connection, { tracked: [] });
    expect(result.pullRequests[0]?.reviewRequestEvents).toEqual([
      { id: "request1", author: expect.objectContaining({ login: "alice", isBot: false }), createdAt: Date.parse("2026-10-02T10:00:00Z"), includesViewer: true },
      { id: "request2", author: expect.objectContaining({ login: "octocat", isBot: false }), createdAt: Date.parse("2026-10-02T11:00:00Z"), includesViewer: true },
      { id: "request3", author: expect.objectContaining({ login: "codecov", isBot: true }), createdAt: Date.parse("2026-10-02T12:00:00Z"), includesViewer: false },
    ]);
    expect(calls.some((call) => call.query.includes("REVIEW_REQUESTED_EVENT") && call.query.includes("ReviewRequestedEvent"))).toBe(true);
  });

  it("explains a rejected token", async () => {
    installAjour(() => ({ status: 401, body: "" }));

    await expect(validateConnection(connection, { capabilities: [] })).rejects.toThrow(
      "GitHub rejected the token. Check that it is valid and not expired.",
    );
  });

  it("reports mentions in review bodies without storing their text", async () => {
    const pr = pullRequest({ reviews: { nodes: [{ id: "r", state: "COMMENTED", submittedAt: "2026-10-02T10:00:00Z", body: "@octocat please look", author: alice }] } });
    stubGitHub((call) => call.query.includes("search(") ? searchResult([pr]) : call.query.includes("organizations") ? { viewer: { organizations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } : { viewer });
    const result = await syncPullRequests(connection, { tracked: [] });
    expect(result.pullRequests[0]?.reviews).toEqual([{ id: "r", verdict: "commented", submittedAt: Date.parse("2026-10-02T10:00:00Z"), author: expect.objectContaining({ login: "alice" }), mentionsViewer: true }]);
  });

  it.each(["push", "force_push"])("attributes a %s to the pusher and actual push time on a fork branch", async (activity_type) => {
    const pr = pullRequest({ reviews: { nodes: [{ id: "r", state: "CHANGES_REQUESTED", submittedAt: "2026-10-01T13:00:00Z", author: viewer }] } });
    const activities = [
      { after: "unrelated", ref: "refs/heads/change/rate-limits", activity_type, timestamp: "2026-10-02T11:00:00Z", actor: { login: "someone", type: "User" } },
      { after: "abc123", ref: "refs/heads/change/rate-limits", activity_type, timestamp: "2026-10-02T10:00:00Z", actor: { login: "octocat", type: "User" } },
    ];
    const { requests } = stubGitHub(
      (call) => call.query.includes("search(") ? searchResult([pr]) : call.query.includes("organizations") ? { viewer: { organizations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } : { viewer },
      () => json(activities),
    );
    const result = await syncPullRequests(connection, { tracked: [] });
    expect(result.pullRequests[0]).toMatchObject({ lastPushedAt: Date.parse("2026-10-02T10:00:00Z"), lastPushActor: { login: "octocat", isBot: false } });
    const request = requests.find((seen) => seen.host === "rest")!;
    expect(request).toMatchObject({
      method: "GET",
      path: "/repos/alice/api/activity",
      query: { ref: "refs/heads/change/rate-limits", per_page: 100, direction: "desc" },
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ajour-github-plugin",
      },
    });
    expect(request.contentType).toBeUndefined();
    expect(request.body).toBeUndefined();
  });

  it("tolerates unavailable push attribution, as when the token lacks Contents access", async () => {
    const { requests } = installAjour(() => ({ status: 403, body: "" }));
    const client = new GitHubClient("connection-1");
    await expect(client.latestPush("acme/api", "feature", "abc")).resolves.toBeUndefined();
    expect(requests.map((request) => request.label)).toEqual(["GET rest /repos/acme/api/activity"]);
  });

  it("discovers unseen pull requests beyond the fourth search page", async () => {
    const { calls } = stubGitHub((call) => {
      if (!call.query.includes("search(")) return { viewer };
      if (!String(call.variables.q).includes("author:@me")) return searchResult([]);
      const page = Number(call.variables.after ?? 0);
      return {
        search: {
          issueCount: 125,
          pageInfo: { hasNextPage: page < 4, endCursor: String(page + 1) },
          nodes: Array.from({ length: 25 }, (_, index) =>
            pullRequest({ id: `PR_${page * 25 + index + 1}`, number: page * 25 + index + 1, author: viewer }),
          ),
        },
      };
    });
    const result = await syncPullRequests(
      { ...connection, config: { includeTeamRequests: false } },
      { tracked: [] },
    );
    expect(result.pullRequests).toHaveLength(125);
    expect(result.pullRequests.some((pr) => pr.number === 125)).toBe(true);
    expect(
      calls.filter(
        (call) =>
          String(call.variables.q).includes("author:@me") &&
          !String(call.variables.q).includes("-author:@me"),
      ),
    ).toHaveLength(5);
  });

  it("fails instead of returning a partial search above GitHub's 1000 result limit", async () => {
    stubGitHub((call) =>
      call.query.includes("search(")
        ? { search: { issueCount: 1001, pageInfo: { hasNextPage: true, endCursor: "next" }, nodes: [] } }
        : { viewer },
    );
    await expect(
      syncPullRequests(
        { ...connection, config: { includeTeamRequests: false } },
        { tracked: [] },
      ),
    ).rejects.toThrow(/1,000|1000/);
  });

  it("paginates organizations and membership-filtered teams independently", async () => {
    const terminal = { hasNextPage: false, endCursor: null };
    const requested = pullRequest({
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: "Team", slug: "late", organization: { login: "second" } } },
        ],
      },
    });
    const { calls } = stubGitHub((call) => {
      if (call.query.includes("organizations"))
        return {
          viewer: {
            organizations:
              call.variables.after === "org-next"
                ? {
                    pageInfo: terminal,
                    nodes: [
                      {
                        login: "second",
                        teams: {
                          pageInfo: { hasNextPage: true, endCursor: "team-next" },
                          nodes: [{ slug: "first" }],
                        },
                      },
                    ],
                  }
                : {
                    pageInfo: { hasNextPage: true, endCursor: "org-next" },
                    nodes: [{ login: "first", teams: { pageInfo: terminal, nodes: [] } }],
                  },
          },
        };
      if (call.query.includes("organization(login:"))
        return { organization: { teams: { pageInfo: terminal, nodes: [{ slug: "late" }] } } };
      if (call.query.includes("search(")) return searchResult([requested]);
      return { viewer };
    });
    const result = await syncPullRequests(connection, { tracked: [] });
    expect(result.pullRequests[0]?.reviewRequests).toEqual([
      { kind: "team", name: "second/late", includesViewer: true },
    ]);
    expect(
      calls.some((call) => call.query.includes("organizations") && call.variables.after === "org-next"),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.query.includes("organization(login:") && call.variables.after === "team-next",
      ),
    ).toBe(true);
  });

  it("rejects unavailable membership instead of guessing all teams were requested for the viewer", async () => {
    const requested = pullRequest({
      reviewRequests: {
        nodes: ["one", "two"].map((slug) => ({
          requestedReviewer: { __typename: "Team", slug, organization: { login: "acme" } },
        })),
      },
    });
    stubGitHub((call) =>
      call.query.includes("organizations")
        ? new Error("Resource not accessible by integration")
        : call.query.includes("search(")
          ? searchResult([requested])
          : { viewer },
    );
    await expect(syncPullRequests(connection, { tracked: [] })).rejects.toThrow(/team membership/i);
  });

  it("returns facts for authored, requested and reviewed pull requests once each", async () => {
    const requested = pullRequest({
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: "User", login: "OctoCat" } },
          { requestedReviewer: { __typename: "Team", slug: "backend", organization: { login: "acme" } } },
          { requestedReviewer: { __typename: "Team", slug: "frontend", organization: { login: "acme" } } },
        ],
      },
      reviews: {
        nodes: [
          { id: "R_1", state: "CHANGES_REQUESTED", submittedAt: "2026-10-01T13:00:00Z", author: viewer },
          { id: "R_2", state: "PENDING", submittedAt: null, author: alice },
        ],
      },
      comments: {
        nodes: [{ id: "C_2", createdAt: "2026-10-01T15:00:00Z", body: "Coverage dropped.", author: bot }],
      },
      reviewThreads: {
        nodes: [
          {
            id: "T_1",
            comments: {
              nodes: [
                {
                  id: "C_1",
                  createdAt: "2026-10-01T14:00:00Z",
                  body: "@octocat fixed, thanks",
                  author: alice,
                },
              ],
            },
          },
        ],
      },
    });
    const authored = pullRequest({ id: "PR_2", number: 2, author: viewer, timelineItems: { nodes: [] } });
    const { calls } = stubGitHub((call) => {
      if (call.query.includes("organizations")) {
        return {
          viewer: {
            organizations: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  login: "acme",
                  teams: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ slug: "backend" }] },
                },
              ],
            },
          },
        };
      }
      if (call.query.includes("search(")) {
        const q = String(call.variables.q);
        if (q.includes("author:@me")) return searchResult([authored]);
        if (q.includes("review-requested:@me")) return searchResult([requested]);
        return searchResult([requested]);
      }
      return { viewer };
    });

    const result = await syncPullRequests(connection, { tracked: [] });

    expect(result.viewer).toEqual({
      login: "octocat",
      displayName: "The Octocat",
      isBot: false,
      avatarUrl: "https://example.com/a.png",
    });
    expect(result.pullRequests).toHaveLength(2);
    expect(result.pullRequests.find((facts) => facts.number === 1)).toEqual({
      id: "PR_1",
      repository: "acme/api",
      number: 1,
      url: "https://github.com/acme/api/pull/1",
      title: "Add rate limits",
      author: { login: "alice", isBot: false, avatarUrl: "https://example.com/b.png" },
      state: "open",
      draft: false,
      createdAt: Date.parse("2026-10-01T10:00:00Z"),
      updatedAt: Date.parse("2026-10-02T10:00:00Z"),
      viewerIsAuthor: false,
      headSha: "abc123",
      lastPushedAt: Date.parse("2026-10-01T12:00:00Z"),
      reviewRequestEvents: [],
      reviewRequests: [
        { kind: "user", name: "OctoCat", includesViewer: true },
        { kind: "team", name: "acme/backend", includesViewer: true },
        { kind: "team", name: "acme/frontend", includesViewer: false },
      ],
      reviews: [
        {
          id: "R_1",
          author: expect.objectContaining({ login: "octocat" }),
          verdict: "changes_requested",
          mentionsViewer: false,
          submittedAt: Date.parse("2026-10-01T13:00:00Z"),
        },
      ],
      comments: [
        {
          id: "C_1",
          author: expect.objectContaining({ login: "alice" }),
          createdAt: Date.parse("2026-10-01T14:00:00Z"),
          threadId: "T_1",
          mentionsViewer: true,
        },
        {
          id: "C_2",
          author: expect.objectContaining({ login: "codecov", isBot: true }),
          createdAt: Date.parse("2026-10-01T15:00:00Z"),
          mentionsViewer: false,
        },
      ],
      checks: "failure",
      mergeability: "mergeable",
    });
    expect(result.pullRequests.find((facts) => facts.number === 2)).toMatchObject({
      viewerIsAuthor: true,
      lastPushedAt: Date.parse("2026-10-01T10:00:00Z"),
    });
    expect(calls.map((call) => call.variables.q).filter(Boolean)).toEqual([
      "is:pr is:open archived:false author:@me",
      "is:pr is:open archived:false review-requested:@me",
      "is:pr is:open archived:false reviewed-by:@me -author:@me",
    ]);
  });

  it("fetches tracked pull requests the searches missed, so closed ones report", async () => {
    const merged = pullRequest({ id: "PR_9", number: 9, state: "MERGED", closedAt: "2026-10-03T10:00:00Z" });
    const { calls } = stubGitHub((call) => {
      if (call.query.includes("organizations")) return new Error("Resource not accessible by integration");
      if (call.query.includes("search(")) return searchResult([]);
      if (call.query.includes("repository(")) return { p0: { pullRequest: merged }, p1: null };
      return { viewer };
    });

    const result = await syncPullRequests(
      { ...connection, config: { ...connection.config, includeTeamRequests: false } },
      {
        tracked: [
          { repository: "acme/api", number: 9 },
          { repository: "acme/gone", number: 3 },
        ],
      },
    );

    expect(result.pullRequests).toEqual([
      expect.objectContaining({ number: 9, state: "merged", closedAt: Date.parse("2026-10-03T10:00:00Z") }),
    ]);
    expect(calls.find((call) => call.query.includes("repository("))?.variables).toEqual({
      o0: "acme",
      r0: "api",
      n0: 9,
      o1: "acme",
      r1: "gone",
      n1: 3,
    });
  });

  it("applies filters and hide drafts to open pull requests only", async () => {
    const excluded = pullRequest({ id: "PR_3", number: 3, repository: { nameWithOwner: "acme/legacy" } });
    const draft = pullRequest({ id: "PR_4", number: 4, isDraft: true });
    const closedExcluded = pullRequest({
      id: "PR_5",
      number: 5,
      state: "CLOSED",
      closedAt: "2026-10-03T10:00:00Z",
      repository: { nameWithOwner: "acme/legacy" },
    });
    stubGitHub((call) => {
      if (call.query.includes("search(")) {
        return String(call.variables.q).includes("author:@me")
          ? searchResult([excluded, draft])
          : searchResult([]);
      }
      if (call.query.includes("repository(")) return { p0: { pullRequest: closedExcluded } };
      return { viewer };
    });

    const result = await syncPullRequests(
      {
        ...connection,
        config: { exclude: "acme/legacy", hideDrafts: true, includeTeamRequests: false },
      },
      { tracked: [{ repository: "acme/legacy", number: 5 }] },
    );

    expect(result.pullRequests.map((facts) => facts.number)).toEqual([5]);
  });

  it("treats team requests as not for the user when team requests are off", async () => {
    const requested = pullRequest({
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: "Team", slug: "backend", organization: { login: "acme" } } },
        ],
      },
    });
    const { calls } = stubGitHub((call) => {
      if (call.query.includes("search(")) {
        return String(call.variables.q).includes("reviewed-by")
          ? searchResult([requested])
          : searchResult([]);
      }
      return { viewer };
    });

    const result = await syncPullRequests(
      { ...connection, config: { includeTeamRequests: false } },
      { tracked: [] },
    );

    expect(result.pullRequests[0]?.reviewRequests).toEqual([
      { kind: "team", name: "acme/backend", includesViewer: false },
    ]);
    expect(calls.some((call) => call.query.includes("organizations"))).toBe(false);
    expect(calls.map((call) => call.variables.q)).toContain(
      "is:pr is:open archived:false user-review-requested:@me",
    );
  });
});

describe("mentions", () => {
  it.each([
    ["@octocat please look", true],
    ["thanks @OctoCat!", true],
    ["cc @octocat-bot", false],
    ["email octocat@example.com", false],
    ["see acme/@octocat", false],
  ])("%j mentions octocat: %s", (body, expected) => {
    expect(mentions(body, "octocat")).toBe(expected);
  });
});
