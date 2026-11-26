import { afterEach, describe, expect, it, vi } from "vitest";
import { getChecks, getPullRequestConversation } from "../src/plugin.ts";
import { json, pluginConnection, stubGitHub, type GraphQLCall, type SeenRequest } from "./support/github-ajour.ts";

/*
 * What Deck's review page reads beside the diff (les-cabochons/ajour#783):
 * the conversation and the checks on the head. Every request goes through
 * the fake Ajour with the real plugin.json, so one the manifest does not
 * declare is refused, as Ajour's broker does.
 */

const connection = pluginConnection();
const ref = { repository: "acme/api", number: 7 };
const alice = { __typename: "User", login: "alice", name: "Alice", avatarUrl: "https://example.test/a.png" };
const bob = { __typename: "User", login: "bob", avatarUrl: "https://example.test/b.png" };

const page = <T>(nodes: T[], endCursor: string | null = null) => ({
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
  nodes,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answers each GraphQL query of the conversation from `pages`, by connection and cursor. */
function conversationGitHub(pages: {
  threads?: Record<string, unknown>;
  timeline?: Record<string, unknown>;
  files?: Record<string, unknown>;
  pullRequest?: unknown;
}) {
  return stubGitHub((call: GraphQLCall) => {
    const after = String(call.variables.after ?? "");
    const connectionOf = (key: string, answers: Record<string, unknown> = {}) => ({
      repository: { pullRequest: { [key]: answers[after] ?? page([]) } },
    });
    if (call.query.includes("reviewThreads(")) return connectionOf("reviewThreads", pages.threads);
    if (call.query.includes("timelineItems(")) return connectionOf("timelineItems", pages.timeline);
    if (call.query.includes("files(")) return connectionOf("files", pages.files);
    return {
      repository: {
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        pullRequest:
          pages.pullRequest === undefined
            ? { body: "## Why\n\nRetries stop on 410.", createdAt: "2026-11-01T10:00:00Z", author: alice }
            : pages.pullRequest,
      },
    };
  });
}

describe("getPullRequestConversation", () => {
  it("returns the description, the timeline oldest first, the threads on their lines and the viewed files", async () => {
    const { calls } = conversationGitHub({
      threads: {
        "": page(
          [
            {
              id: "T_1",
              path: "src/retry.ts",
              diffSide: "RIGHT",
              line: 14,
              startLine: 12,
              isResolved: false,
              isOutdated: false,
              comments: {
                nodes: [
                  { id: "C_1", body: "<!-- ajour-review: comment_submission_1 -->\n\nWhy 410 only?", createdAt: "2026-11-01T12:00:00Z", lastEditedAt: null, author: bob },
                  { id: "C_2", body: "It's the only one that means gone.", createdAt: "2026-11-01T13:00:00Z", lastEditedAt: "2026-11-01T13:05:00Z", author: alice },
                ],
              },
            },
          ],
          "threads-2",
        ),
        "threads-2": page([
          {
            id: "T_2",
            path: "src/old.ts",
            diffSide: "LEFT",
            line: null,
            startLine: null,
            isResolved: true,
            isOutdated: true,
            comments: { nodes: [{ id: "C_3", body: "Gone now.", createdAt: "2026-11-01T11:00:00Z", lastEditedAt: null, author: bob }] },
          },
        ]),
      },
      timeline: {
        "": page([
          { __typename: "PullRequestCommit", commit: { oid: "abc123", messageHeadline: "Stop on 410", committedDate: "2026-11-01T10:30:00Z", author: { name: "Alice" } } },
          // Ajour's submission lines, which GitHub doesn't show either, before
          // the words or after them, as an earlier build and an edit leave them.
          { __typename: "PullRequestReview", id: "R_1", state: "APPROVED", body: "<!-- ajour-review: review_submission_1 -->\n\nShip it.", submittedAt: "2026-11-01T14:00:00Z", author: bob },
          { __typename: "PullRequestReview", id: "R_2", state: "PENDING", body: "draft", submittedAt: null, author: alice },
          { __typename: "IssueComment", id: "IC_1", body: "Ready for another look.\n\n<!-- ajour-review: comment_submission_2 -->", createdAt: "2026-11-01T13:30:00Z", author: alice },
          { __typename: "RenamedTitleEvent", id: "E_1", createdAt: "2026-11-01T10:45:00Z", previousTitle: "WIP", currentTitle: "Stop retries on 410", actor: alice },
          { __typename: "ReviewRequestedEvent", id: "E_2", createdAt: "2026-11-01T10:50:00Z", actor: alice, requestedReviewer: { __typename: "Team", slug: "backend", organization: { login: "acme" } } },
          { __typename: "HeadRefForcePushedEvent", id: "E_3", createdAt: "2026-11-01T11:30:00Z", actor: null },
        ]),
      },
      files: {
        "": page([
          { path: "src/retry.ts", viewerViewedState: "VIEWED" },
          { path: "src/old.ts", viewerViewedState: "UNVIEWED" },
          { path: "src/client.ts", viewerViewedState: "DISMISSED" },
        ]),
      },
    });

    const conversation = await getPullRequestConversation(connection, ref);

    expect(conversation.description).toBe("## Why\n\nRetries stop on 410.");
    expect(conversation.mergeMethods).toEqual(["merge", "squash"]);
    expect(conversation.viewedPaths).toEqual(["src/retry.ts"]);
    expect(conversation.threads).toEqual([
      {
        id: "T_1",
        path: "src/retry.ts",
        side: "head",
        line: 14,
        startLine: 12,
        resolved: false,
        outdated: false,
        comments: [
          { id: "C_1", author: { login: "bob", isBot: false, avatarUrl: "https://example.test/b.png" }, body: "Why 410 only?", createdAt: Date.parse("2026-11-01T12:00:00Z") },
          {
            id: "C_2",
            author: { login: "alice", displayName: "Alice", isBot: false, avatarUrl: "https://example.test/a.png" },
            body: "It's the only one that means gone.",
            createdAt: Date.parse("2026-11-01T13:00:00Z"),
            updatedAt: Date.parse("2026-11-01T13:05:00Z"),
          },
        ],
      },
      // An outdated thread keeps its side, without a line of the latest diff.
      {
        id: "T_2",
        path: "src/old.ts",
        side: "base",
        resolved: true,
        outdated: true,
        comments: [expect.objectContaining({ id: "C_3", body: "Gone now." })],
      },
    ]);
    expect(conversation.timeline.map((event) => [event.kind, "text" in event ? event.text : "body" in event ? event.body : event.headline])).toEqual([
      ["event", "opened this pull request"],
      ["commit", "Stop on 410"],
      ["event", "renamed the title from “WIP” to “Stop retries on 410”"],
      ["event", "requested a review from acme/backend"],
      ["event", "force-pushed the branch"],
      ["comment", "Ready for another look."],
      ["review", "Ship it."],
    ]);
    expect(conversation.timeline[1]).toEqual({
      kind: "commit",
      sha: "abc123",
      headline: "Stop on 410",
      authorName: "Alice",
      createdAt: Date.parse("2026-11-01T10:30:00Z"),
    });
    expect(conversation.timeline.at(-1)).toMatchObject({ kind: "review", id: "R_1", verdict: "approved", body: "Ship it." });
    expect(conversation.timeline[4]).not.toHaveProperty("actor");
    // Each connection reads page by page: the threads took two.
    expect(calls.filter((call) => call.query.includes("reviewThreads(")).map((call) => call.variables.after)).toEqual([null, "threads-2"]);
    expect(calls[0]?.variables).toEqual({ owner: "acme", name: "api", number: 7 });
  });

  it("reads the comments of a long thread past its first page, up to 500", async () => {
    const comment = (index: number) => ({
      id: `C_${index}`,
      body: `Comment ${index}`,
      createdAt: "2026-11-01T12:00:00Z",
      lastEditedAt: null,
      author: bob,
    });
    const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => comment(from + index));
    const { calls } = stubGitHub((call: GraphQLCall) => {
      if (call.query.includes("node(id:")) {
        const after = String(call.variables.after);
        const pages: Record<string, unknown> = {
          "comments-1": page(range(100, 100), "comments-2"),
          "comments-2": page(range(200, 100), "comments-3"),
          "comments-3": page(range(300, 100), "comments-4"),
          "comments-4": page(range(400, 100), "comments-5"),
          "comments-5": page(range(500, 100), "comments-6"),
        };
        return { node: { comments: pages[after] } };
      }
      if (call.query.includes("reviewThreads(")) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: page([
                {
                  id: "T_long",
                  path: "src/retry.ts",
                  diffSide: "RIGHT",
                  line: 3,
                  startLine: null,
                  isResolved: false,
                  isOutdated: false,
                  comments: page(range(0, 100), "comments-1"),
                },
              ]),
            },
          },
        };
      }
      if (call.query.includes("timelineItems(")) return { repository: { pullRequest: { timelineItems: page([]) } } };
      if (call.query.includes("files(")) return { repository: { pullRequest: { files: page([]) } } };
      return {
        repository: {
          mergeCommitAllowed: true,
          squashMergeAllowed: false,
          rebaseMergeAllowed: false,
          pullRequest: { body: "", createdAt: "2026-11-01T10:00:00Z", author: alice },
        },
      };
    });

    const conversation = await getPullRequestConversation(connection, ref);

    const comments = conversation.threads[0]!.comments;
    expect(comments).toHaveLength(500);
    expect(comments[100]?.body).toBe("Comment 100");
    expect(comments.at(-1)?.body).toBe("Comment 499");
    expect(
      calls.filter((call) => call.query.includes("node(id:")).map((call) => [call.variables.id, call.variables.after]),
    ).toEqual([
      ["T_long", "comments-1"],
      ["T_long", "comments-2"],
      ["T_long", "comments-3"],
      ["T_long", "comments-4"],
    ]);
  });

  it("fails when GitHub doesn't find the pull request", async () => {
    conversationGitHub({ pullRequest: null });

    await expect(getPullRequestConversation(connection, ref)).rejects.toThrow("GitHub could not find the pull request.");
  });
});

/** Answers the checks query from `pages`, by cursor. */
function checksGitHub(pages: Record<string, unknown> | null, rollup = true) {
  return stubGitHub((call: GraphQLCall) => {
    if (pages === null) return { repository: { pullRequest: null } };
    const after = String(call.variables.after ?? "");
    return {
      repository: {
        pullRequest: {
          commits: { nodes: [{ commit: { statusCheckRollup: rollup ? { contexts: pages[after] ?? page([]) } : null } }] },
        },
      },
    };
  });
}

describe("the merge methods a conversation offers", () => {
  /** A repository allowing every method, whose pull request merges into `release/2026`, and its branch rules from `rules`. */
  function mergeGitHub(rules: (request: SeenRequest) => ReturnType<typeof json>) {
    return stubGitHub(
      (call: GraphQLCall) => {
        if (call.query.includes("reviewThreads(")) return { repository: { pullRequest: { reviewThreads: page([]) } } };
        if (call.query.includes("timelineItems(")) return { repository: { pullRequest: { timelineItems: page([]) } } };
        if (call.query.includes("files(")) return { repository: { pullRequest: { files: page([]) } } };
        return {
          repository: {
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: true,
            pullRequest: { body: "", createdAt: "2026-11-01T10:00:00Z", author: alice, baseRefName: "release/2026" },
          },
        };
      },
      rules,
    );
  }
  const pullRequestRule = (allowed?: string[]) => ({
    type: "pull_request",
    ruleset_source_type: "Repository",
    ruleset_source: "acme/api",
    ruleset_id: 1,
    parameters: {
      required_approving_review_count: 1,
      ...(allowed ? { allowed_merge_methods: allowed } : {}),
    },
  });

  it("offers only what the target branch's rules allow, among the repository's methods", async () => {
    const { requests } = mergeGitHub((request) =>
      request.path === "/repos/acme/api/rules/branches/release/2026"
        ? json([{ type: "deletion" }, pullRequestRule(["squash"])])
        : json({ message: "Not Found" }, 404),
    );

    const conversation = await getPullRequestConversation(connection, ref);

    expect(conversation.mergeMethods).toEqual(["squash"]);
    expect(requests.filter((request) => request.host === "rest").map((request) => request.label)).toEqual([
      "GET rest /repos/acme/api/rules/branches/release/2026",
    ]);
  });

  it("offers only what every ruleset on the branch allows", async () => {
    mergeGitHub(() => json([pullRequestRule(["merge", "squash"]), pullRequestRule(["squash", "rebase"])]));

    expect((await getPullRequestConversation(connection, ref)).mergeMethods).toEqual(["squash"]);
  });

  it("keeps the repository's methods when no rule limits them", async () => {
    mergeGitHub(() => json([pullRequestRule()]));

    expect((await getPullRequestConversation(connection, ref)).mergeMethods).toEqual(["merge", "squash", "rebase"]);
  });

  it.each([
    ["refused", 403],
    ["missing on an older GitHub Enterprise Server", 404],
  ])("keeps the repository's methods when the rules are %s", async (_, status) => {
    mergeGitHub(() => json({ message: "Resource not accessible by personal access token" }, status));

    expect((await getPullRequestConversation(connection, ref)).mergeMethods).toEqual(["merge", "squash", "rebase"]);
  });
});

describe("getChecks", () => {
  it("returns each check run and commit status with its name, state and url", async () => {
    const { calls } = checksGitHub({
      "": page(
        [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci.example.test/1", url: "https://github.com/acme/api/runs/1" },
          { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null, detailsUrl: null, url: "https://github.com/acme/api/runs/2" },
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "CANCELLED", detailsUrl: "javascript:alert(1)", url: null },
        ],
        "checks-2",
      ),
      "checks-2": page([
        { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: null, url: null },
        { __typename: "StatusContext", context: "ci/deploy", state: "EXPECTED", targetUrl: null },
        { __typename: "StatusContext", context: "ci/legacy", state: "ERROR", targetUrl: "https://legacy.example.test" },
        { __typename: "CheckRun", name: "  ", status: "QUEUED", conclusion: null, detailsUrl: null, url: null },
      ]),
    });

    await expect(getChecks(connection, ref)).resolves.toEqual({
      checks: [
        { name: "build", state: "success", url: "https://ci.example.test/1" },
        { name: "test", state: "pending", url: "https://github.com/acme/api/runs/2" },
        // A link that isn't http or https is left out.
        { name: "lint", state: "failure" },
        { name: "docs", state: "skipped" },
        { name: "ci/deploy", state: "pending" },
        { name: "ci/legacy", state: "failure", url: "https://legacy.example.test" },
      ],
    });
    expect(calls.map((call) => call.variables.after)).toEqual([null, "checks-2"]);
  });

  it("returns no checks for a head without any", async () => {
    checksGitHub({}, false);

    await expect(getChecks(connection, ref)).resolves.toEqual({ checks: [] });
  });

  it("fails when GitHub doesn't find the pull request", async () => {
    checksGitHub(null);

    await expect(getChecks(connection, ref)).rejects.toThrow("GitHub could not find the pull request.");
  });
});
