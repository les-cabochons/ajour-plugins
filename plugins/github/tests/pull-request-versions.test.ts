import { afterEach, describe, expect, it, vi } from "vitest";
import { getPullRequestVersions } from "../src/plugin.ts";
import { pluginConnection, stubGitHub, type GraphQLCall } from "./support/github-ajour.ts";

/*
 * A pull request's versions for Deck's versions bar (les-cabochons/ajour#787):
 * GitHub keeps no record of a plain push, so the pushes come from the
 * timeline. A force push is a version of its own, at the commit it pushed;
 * commits listed between two other events (a review, a comment, a force
 * push) were pushed together. Every request goes through the fake Ajour
 * with the real plugin.json.
 */

const connection = pluginConnection();
const ref = { repository: "acme/api", number: 7 };
const alice = { __typename: "User", login: "alice", avatarUrl: "https://example.test/a.png" };

const page = <T>(nodes: T[], endCursor: string | null = null) => ({
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
  nodes,
});

const commit = (oid: string, headline: string, committedDate: string) => ({
  __typename: "PullRequestCommit",
  commit: { oid, messageHeadline: headline, committedDate, author: { name: "Alice" } },
});
const review = (submittedAt: string | null) => ({ __typename: "PullRequestReview", submittedAt });
const comment = (createdAt: string) => ({ __typename: "IssueComment", createdAt });
const forcePush = (before: string, after: string, createdAt: string) => ({
  __typename: "HeadRefForcePushedEvent",
  createdAt,
  actor: alice,
  beforeCommit: { oid: before },
  afterCommit: { oid: after },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answers the timeline from `pages` by cursor, and the pull request's head and commits. */
function versionsGitHub(options: {
  timeline: Record<string, unknown>;
  headRefOid: string;
  commits?: unknown[];
  missing?: boolean;
}) {
  return stubGitHub((call: GraphQLCall) => {
    if (options.missing) return { repository: { pullRequest: null } };
    if (call.query.includes("timelineItems(")) {
      const after = String(call.variables.after ?? "");
      return { repository: { pullRequest: { timelineItems: options.timeline[after] ?? page([]) } } };
    }
    return {
      repository: {
        pullRequest: {
          headRefOid: options.headRefOid,
          commits: { nodes: (options.commits ?? []).map((node) => ({ commit: (node as { commit: unknown }).commit })) },
        },
      },
    };
  });
}

describe("getPullRequestVersions", () => {
  it("groups the commits pushed between two events into one push, numbered in order", async () => {
    const { calls } = versionsGitHub({
      headRefOid: "c3",
      timeline: {
        "": page(
          [
            commit("c1", "Add the route", "2026-11-01T10:00:00Z"),
            commit("c2", "Test the route", "2026-11-01T10:05:00Z"),
            review("2026-11-01T12:00:00Z"),
            // A pending review is no one else's event.
            review(null),
          ],
          "t-2",
        ),
        "t-2": page([commit("c3", "Address the review", "2026-11-01T15:00:00Z"), comment("2026-11-01T16:00:00Z")]),
      },
    });

    const result = await getPullRequestVersions(connection, ref);

    expect(result.versionName).toBeUndefined();
    expect(result.versions).toEqual([
      {
        number: 1,
        headSha: "c2",
        pushedAt: Date.parse("2026-11-01T10:05:00Z"),
        commits: [
          { sha: "c1", headline: "Add the route", authorName: "Alice", createdAt: Date.parse("2026-11-01T10:00:00Z") },
          { sha: "c2", headline: "Test the route", authorName: "Alice", createdAt: Date.parse("2026-11-01T10:05:00Z") },
        ],
      },
      {
        number: 2,
        headSha: "c3",
        pushedAt: Date.parse("2026-11-01T15:00:00Z"),
        commits: [
          { sha: "c3", headline: "Address the review", authorName: "Alice", createdAt: Date.parse("2026-11-01T15:00:00Z") },
        ],
      },
    ]);
    expect(calls.map((call) => call.variables)).toContainEqual({ owner: "acme", name: "api", number: 7, after: "t-2" });
  });

  it("makes each force push a version at the commit it pushed, with the head's new commits on the last one", async () => {
    versionsGitHub({
      headRefOid: "r2",
      commits: [
        commit("r1", "Add the route", "2026-11-02T09:00:00Z"),
        commit("r2", "Test the route", "2026-11-02T09:01:00Z"),
      ],
      timeline: {
        "": page([
          commit("c1", "Add the route", "2026-11-01T10:00:00Z"),
          review("2026-11-01T12:00:00Z"),
          forcePush("c1", "f1", "2026-11-01T18:00:00Z"),
          // The commits a force push lists after it are its own.
          commit("f1", "Add the route, rebased", "2026-11-01T17:59:00Z"),
          comment("2026-11-01T19:00:00Z"),
          forcePush("f1", "r2", "2026-11-02T10:00:00Z"),
        ]),
      },
    });

    const { versions } = await getPullRequestVersions(connection, ref);

    expect(versions.map(({ number, headSha, forced, pushedAt }) => ({ number, headSha, forced, pushedAt }))).toEqual([
      { number: 1, headSha: "c1", forced: undefined, pushedAt: Date.parse("2026-11-01T10:00:00Z") },
      { number: 2, headSha: "f1", forced: true, pushedAt: Date.parse("2026-11-01T18:00:00Z") },
      { number: 3, headSha: "r2", forced: true, pushedAt: Date.parse("2026-11-02T10:00:00Z") },
    ]);
    expect(versions[1]!.commits.map((entry) => entry.sha)).toEqual(["f1"]);
    // GitHub lists no commits after the last force push: the head's commits no version had.
    expect(versions[2]!.commits.map((entry) => entry.sha)).toEqual(["r1", "r2"]);
  });

  it("ends on the pull request's head, even when the timeline doesn't list its push", async () => {
    versionsGitHub({
      headRefOid: "c9",
      commits: [commit("c1", "Add the route", "2026-11-01T10:00:00Z"), commit("c9", "Later", "2026-11-03T10:00:00Z")],
      timeline: { "": page([commit("c1", "Add the route", "2026-11-01T10:00:00Z")]) },
    });

    const { versions } = await getPullRequestVersions(connection, ref);

    expect(versions.map((version) => [version.number, version.headSha])).toEqual([
      [1, "c1"],
      [2, "c9"],
    ]);
    expect(versions[1]!.commits.map((entry) => entry.sha)).toEqual(["c9"]);
  });

  it("never dates a push after the event that closed it, nor before the push it follows", async () => {
    versionsGitHub({
      headRefOid: "c2",
      timeline: {
        "": page([
          forcePush("c0", "c1", "2026-11-01T12:00:00Z"),
          comment("2026-11-01T13:00:00Z"),
          // Committed before the force push, but pushed after the comment.
          commit("c2", "Old work", "2026-11-01T08:00:00Z"),
          review("2026-11-01T14:00:00Z"),
        ]),
      },
    });

    const { versions } = await getPullRequestVersions(connection, ref);

    expect(versions.map((version) => version.pushedAt)).toEqual([
      Date.parse("2026-11-01T12:00:00Z"),
      Date.parse("2026-11-01T13:00:00Z"),
    ]);
  });

  it("fails when GitHub doesn't find the pull request", async () => {
    versionsGitHub({ headRefOid: "x", timeline: {}, missing: true });

    await expect(getPullRequestVersions(connection, ref)).rejects.toThrow("GitHub could not find the pull request.");
  });
});
