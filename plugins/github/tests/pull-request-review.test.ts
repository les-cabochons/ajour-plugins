import { afterEach, describe, expect, it, vi } from "vitest";
import { getChecks, getPullRequestConversation } from "../src/plugin.ts";
import { pluginConnection, stubGitHub, type GraphQLCall } from "./support/github-ajour.ts";

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
                  { id: "C_1", body: "Why 410 only?", createdAt: "2026-11-01T12:00:00Z", lastEditedAt: null, author: bob },
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
          { __typename: "PullRequestReview", id: "R_1", state: "APPROVED", body: "", submittedAt: "2026-11-01T14:00:00Z", author: bob },
          { __typename: "PullRequestReview", id: "R_2", state: "PENDING", body: "draft", submittedAt: null, author: alice },
          { __typename: "IssueComment", id: "IC_1", body: "Ready for another look.", createdAt: "2026-11-01T13:30:00Z", author: alice },
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
      ["review", ""],
    ]);
    expect(conversation.timeline[1]).toEqual({
      kind: "commit",
      sha: "abc123",
      headline: "Stop on 410",
      authorName: "Alice",
      createdAt: Date.parse("2026-11-01T10:30:00Z"),
    });
    expect(conversation.timeline.at(-1)).toMatchObject({ kind: "review", id: "R_1", verdict: "approved" });
    expect(conversation.timeline[4]).not.toHaveProperty("actor");
    // Each connection reads page by page: the threads took two.
    expect(calls.filter((call) => call.query.includes("reviewThreads(")).map((call) => call.variables.after)).toEqual([null, "threads-2"]);
    expect(calls[0]?.variables).toEqual({ owner: "acme", name: "api", number: 7 });
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
