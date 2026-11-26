import { afterEach, describe, expect, it, vi } from "vitest";
import { replyToThread, setFileViewed, setThreadResolved } from "../src/plugin.ts";
import { json, pluginConnection, stubGitHub, type GraphQLCall, type SeenRequest } from "./support/github-ajour.ts";

/*
 * The rest of a review round from Deck (les-cabochons/ajour#785): a reply at
 * the end of a thread, resolving and unresolving it, and a file marked
 * viewed. Every request goes through the fake Ajour with the real
 * plugin.json, so the REST reply answers only while the connection turned
 * on "Review pull requests".
 */

const REVIEW = "reviewPullRequests";
const ref = { repository: "acme/api", number: 7 };
const THREAD = "PRRT_kwDOA1";
const connection = (access: readonly string[] = [REVIEW]) => pluginConnection({}, { access: [...access] });

afterEach(() => {
  vi.unstubAllGlobals();
});

const posts = (requests: SeenRequest[]) => requests.filter((request) => request.host === "rest");

describe("replyToThread", () => {
  const SUBMISSION = "reply_submission_1";
  const MARK = `<!-- ajour-review: ${SUBMISSION} -->`;
  const FIRST_TRY = Date.parse("2026-11-26T10:00:00Z");
  const at = (minutes: number) => new Date(FIRST_TRY + minutes * 60_000).toISOString();

  interface ThreadComment {
    databaseId: number;
    viewerDidAuthor: boolean;
    body: string;
    createdAt: string;
  }
  const comment = (fields: Partial<ThreadComment> & { databaseId: number }): ThreadComment => ({
    viewerDidAuthor: false,
    body: "Why 410 only?",
    createdAt: at(-60),
    ...fields,
  });

  /** GitHub holding a thread with these comments, oldest first, served newest first in pages of `size`. */
  function gitHub({
    comments = [comment({ databaseId: 41 })],
    size = 100,
    access = [REVIEW],
    thread = true,
  }: { comments?: ThreadComment[]; size?: number; access?: readonly string[]; thread?: boolean } = {}) {
    const pageOf = (before: unknown) => {
      const end = typeof before === "string" ? Number(before) : comments.length;
      const start = Math.max(0, end - size);
      return {
        pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
        nodes: comments.slice(start, end),
      };
    };
    return stubGitHub(
      ({ variables }: GraphQLCall) => ({
        node: thread
          ? {
              first: { nodes: comments.slice(0, 1).map(({ databaseId }) => ({ databaseId })) },
              comments: pageOf(variables.before),
            }
          : null,
      }),
      () => json({ id: 90 }, 201),
      { access },
    );
  }

  it("replies to the thread's first comment, its mark on a line before the words", async () => {
    const { calls, requests } = gitHub();

    await expect(
      replyToThread!(connection(), { ...ref, threadId: THREAD, body: "Fixed in the next push.", submissionId: SUBMISSION }),
    ).resolves.toEqual({ commentId: "90" });

    expect(calls[0]!.variables).toEqual({ id: THREAD });
    expect(posts(requests)).toMatchObject([
      {
        label: "POST rest /repos/acme/api/pulls/7/comments/41/replies",
        contentType: "application/json",
        body: { body: `${MARK}\n\nFixed in the next push.` },
      },
    ]);
  });

  it("posts the words alone without a submission", async () => {
    const { requests } = gitHub();

    await replyToThread!(connection(), { ...ref, threadId: THREAD, body: "Thanks." });

    expect(posts(requests)[0]!.body).toEqual({ body: "Thanks." });
  });

  it("is refused while the connection has Review pull requests off", async () => {
    const { requests } = gitHub({ access: [] });

    await expect(replyToThread!(connection([]), { ...ref, threadId: THREAD, body: "Thanks." })).rejects.toThrow(
      /reviewPullRequests/,
    );
    expect(posts(requests)).toEqual([]);
  });

  it("says so when GitHub has no such thread", async () => {
    const { requests } = gitHub({ thread: false });

    await expect(replyToThread!(connection(), { ...ref, threadId: THREAD, body: "Thanks." })).rejects.toThrow(
      "GitHub could not find the review thread.",
    );
    expect(posts(requests)).toEqual([]);
  });

  it("refuses an identity a marker can't hold, sending nothing", async () => {
    const { calls, requests } = gitHub();

    await expect(
      replyToThread!(connection(), { ...ref, threadId: THREAD, body: "Thanks.", submissionId: "a --> b" }),
    ).rejects.toThrow("The submission id");
    expect(calls).toEqual([]);
    expect(requests).toEqual([]);
  });

  describe("a retry", () => {
    const retry = { ...ref, threadId: THREAD, body: "Fixed.", submissionId: SUBMISSION, firstTriedAt: FIRST_TRY };

    it("finds the reply an earlier try left, newest first through every page, and posts nothing", async () => {
      const { calls, requests } = gitHub({
        size: 2,
        comments: [
          comment({ databaseId: 41 }),
          comment({ databaseId: 42, viewerDidAuthor: true, body: `${MARK}\n\nFixed.`, createdAt: at(0) }),
          comment({ databaseId: 43, createdAt: at(1), body: "Great." }),
          comment({ databaseId: 44, createdAt: at(2), body: "Agreed." }),
          comment({ databaseId: 45, createdAt: at(3), body: "Ship it." }),
        ],
      });

      await expect(replyToThread!(connection(), retry)).resolves.toEqual({ commentId: "42" });
      expect(posts(requests)).toEqual([]);
      expect(calls.map((call) => call.variables)).toEqual([
        { id: THREAD },
        { id: THREAD, before: "3" },
      ]);
    });

    it("finds the reply with its mark anywhere in an edited body", async () => {
      const { requests } = gitHub({
        comments: [
          comment({ databaseId: 41 }),
          comment({ databaseId: 42, viewerDidAuthor: true, body: `Fixed.\n\n${MARK}\n\nEdited.`, createdAt: at(0) }),
        ],
      });

      await expect(replyToThread!(connection(), retry)).resolves.toEqual({ commentId: "42" });
      expect(posts(requests)).toEqual([]);
    });

    it("can't tell, and posts nothing, when a reply of the user's since the first try names no submission", async () => {
      const { requests } = gitHub({
        comments: [comment({ databaseId: 41 }), comment({ databaseId: 42, viewerDidAuthor: true, body: "Fixed!", createdAt: at(0) })],
      });

      await expect(replyToThread!(connection(), retry)).resolves.toEqual({ uncertain: true });
      expect(posts(requests)).toEqual([]);
    });

    it("can't tell, and posts nothing, when it runs out of pages before the thread's first comment", async () => {
      const { requests } = gitHub({
        size: 1,
        comments: Array.from({ length: 40 }, (_, index) => comment({ databaseId: index + 1 })),
      });

      await expect(replyToThread!(connection(), retry)).resolves.toEqual({ uncertain: true });
      expect(posts(requests)).toEqual([]);
    });

    it.each([
      ["someone else's reply", comment({ databaseId: 42, body: MARK, createdAt: at(0) })],
      ["another submission's reply", comment({ databaseId: 42, viewerDidAuthor: true, body: "<!-- ajour-review: other -->", createdAt: at(0) })],
      ["the user's reply from before the first try", comment({ databaseId: 42, viewerDidAuthor: true, body: "Earlier.", createdAt: at(-30) })],
    ])("replies beside %s", async (_, existing) => {
      const { requests } = gitHub({ comments: [comment({ databaseId: 41 }), existing] });

      await expect(replyToThread!(connection(), retry)).resolves.toEqual({ commentId: "90" });
      expect(posts(requests)).toHaveLength(1);
    });
  });
});

describe("setThreadResolved", () => {
  /** GitHub holding the thread on `parent`, and answering the mutation with `resolved`. */
  function gitHub(resolved: boolean, parent: { repository: string; number: number } | null = ref) {
    return stubGitHub(
      ({ query }: GraphQLCall) =>
        query.includes("ReviewThread(input")
          ? { [query.includes("unresolve") ? "unresolveReviewThread" : "resolveReviewThread"]: { thread: { isResolved: resolved } } }
          : {
              node: parent
                ? { pullRequest: { number: parent.number, repository: { nameWithOwner: parent.repository } } }
                : null,
            },
      undefined,
      { access: [REVIEW] },
    );
  }
  const mutations = (calls: GraphQLCall[]) => calls.filter((call) => call.query.startsWith("mutation"));

  it.each([
    [true, "resolveReviewThread"],
    [false, "unresolveReviewThread"],
  ] as const)("resolved %s calls %s and answers GitHub's state", async (resolved, mutation) => {
    const { calls, requests } = gitHub(resolved);

    await expect(setThreadResolved!(connection(), { ...ref, threadId: THREAD, resolved })).resolves.toEqual({ resolved });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.variables).toEqual({ id: THREAD });
    expect(mutations(calls)).toHaveLength(1);
    expect(calls[1]!.query).toContain(`${mutation}(input: { threadId: $id })`);
    expect(calls[1]!.variables).toEqual({ id: THREAD });
    expect(posts(requests)).toEqual([]);
  });

  it("takes the repository's name in any case", async () => {
    gitHub(true, { repository: "Acme/API", number: 7 });

    await expect(setThreadResolved!(connection(), { ...ref, threadId: THREAD, resolved: true })).resolves.toEqual({
      resolved: true,
    });
  });

  it.each([
    ["another repository's", { repository: "acme/web", number: 7 }],
    ["another pull request's", { repository: "acme/api", number: 8 }],
  ])("refuses %s thread, changing nothing", async (_, parent) => {
    const { calls } = gitHub(true, parent);

    await expect(setThreadResolved!(connection(), { ...ref, threadId: THREAD, resolved: true })).rejects.toThrow(
      "This review thread belongs to another pull request.",
    );
    expect(mutations(calls)).toEqual([]);
  });

  it("says so when GitHub has no such thread, changing nothing", async () => {
    const { calls } = gitHub(true, null);

    await expect(setThreadResolved!(connection(), { ...ref, threadId: THREAD, resolved: false })).rejects.toThrow(
      "GitHub could not find the review thread.",
    );
    expect(mutations(calls)).toEqual([]);
  });

  it("says why GitHub refused it", async () => {
    stubGitHub(() => new Error("Resource not accessible by personal access token"), undefined, { access: [REVIEW] });

    await expect(setThreadResolved!(connection(), { ...ref, threadId: THREAD, resolved: true })).rejects.toThrow(
      "Resource not accessible",
    );
  });
});

describe("setFileViewed", () => {
  const HEAD = "abc123def456";

  function gitHub(headRefOid = HEAD) {
    return stubGitHub(
      ({ query }: GraphQLCall) =>
        query.includes("markFileAsViewed")
          ? { markFileAsViewed: { pullRequest: { id: "PR_1" } } }
          : query.includes("unmarkFileAsViewed")
            ? { unmarkFileAsViewed: { pullRequest: { id: "PR_1" } } }
            : { repository: { pullRequest: { id: "PR_1", headRefOid } } },
      undefined,
      { access: [REVIEW] },
    );
  }

  it("marks the file viewed on the head the user read", async () => {
    const { calls } = gitHub();

    await expect(
      setFileViewed!(connection(), { ...ref, path: "src/retry.ts", viewed: true, headSha: HEAD.toUpperCase() }),
    ).resolves.toEqual({ viewed: true });

    expect(calls.map((call) => call.variables)).toEqual([
      { owner: "acme", name: "api", number: 7 },
      { id: "PR_1", path: "src/retry.ts" },
    ]);
    expect(calls[1]!.query).toContain("markFileAsViewed(input: { pullRequestId: $id, path: $path })");
    expect(calls[1]!.query).not.toContain("unmarkFileAsViewed");
  });

  it("marks nothing once the pull request has new commits", async () => {
    const { calls } = gitHub("fff999");

    await expect(
      setFileViewed!(connection(), { ...ref, path: "src/retry.ts", viewed: true, headSha: HEAD }),
    ).rejects.toThrow("The pull request has new commits since you read it. Refresh to mark its latest changes viewed.");
    expect(calls).toHaveLength(1);
  });

  it("unmarks the file whatever the head", async () => {
    const { calls } = gitHub("fff999");

    await expect(
      setFileViewed!(connection(), { ...ref, path: "src/retry.ts", viewed: false, headSha: HEAD }),
    ).resolves.toEqual({ viewed: false });
    expect(calls[1]!.query).toContain("unmarkFileAsViewed(input: { pullRequestId: $id, path: $path })");
  });

  it("says so when GitHub can't find the pull request", async () => {
    stubGitHub(() => ({ repository: { pullRequest: null } }), undefined, { access: [REVIEW] });

    await expect(
      setFileViewed!(connection(), { ...ref, path: "src/retry.ts", viewed: true, headSha: HEAD }),
    ).rejects.toThrow("GitHub could not find the pull request.");
  });
});
