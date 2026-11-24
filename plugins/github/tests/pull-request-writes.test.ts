import { afterEach, describe, expect, it, vi } from "vitest";
import { postComment, submitReview } from "../src/plugin.ts";
import { withoutSubmissionMark } from "../src/pull-request-writes.ts";
import { installAjour, json, pluginConnection, stubGitHub, type SeenRequest } from "./support/github-ajour.ts";

/*
 * The writes of Deck's draft review (les-cabochons/ajour#784): a comment
 * posted at once, on lines or on the conversation, and a review submitted
 * with its verdict and line comments. Every request goes through the fake
 * Ajour with the real plugin.json, so the write endpoints answer only while
 * the connection turned on "Review pull requests", as Ajour's broker does.
 */

const REVIEW = "reviewPullRequests";
const ref = { repository: "acme/api", number: 7 };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** GitHub answering each write with a new id. */
function gitHub(access: readonly string[] = [REVIEW]) {
  return installAjour(
    (request: SeenRequest) =>
      request.path.endsWith("/reviews") ? json({ id: 80 }, 200) : json({ id: 90 }, 201),
    { access },
  );
}

const connection = (access: readonly string[] = [REVIEW]) => pluginConnection({}, { access: [...access] });

describe("postComment", () => {
  it("comments on a line of the head at the reviewed commit", async () => {
    const { requests } = gitHub();

    await expect(
      postComment!(connection(), {
        ...ref,
        body: "Why 410 only?",
        anchor: { path: "src/retry.ts", side: "head", line: 14, headSha: "abc123" },
      }),
    ).resolves.toEqual({ commentId: "90" });

    expect(requests).toMatchObject([
      {
        label: "POST rest /repos/acme/api/pulls/7/comments",
        contentType: "application/json",
        body: { body: "Why 410 only?", commit_id: "abc123", path: "src/retry.ts", line: 14, side: "RIGHT" },
      },
    ]);
  });

  it("comments on lines of the base, from the first one", async () => {
    const { requests } = gitHub();

    await postComment!(connection(), {
      ...ref,
      body: "These went away.",
      anchor: { path: "src/old.ts", side: "base", line: 9, startLine: 4, headSha: "abc123" },
    });

    expect(requests[0]!.body).toEqual({
      body: "These went away.",
      commit_id: "abc123",
      path: "src/old.ts",
      line: 9,
      side: "LEFT",
      start_line: 4,
      start_side: "LEFT",
    });
  });

  it("comments on the conversation without an anchor", async () => {
    const { requests } = gitHub();

    await expect(postComment!(connection(), { ...ref, body: "Thanks!" })).resolves.toEqual({ commentId: "90" });
    expect(requests).toMatchObject([{ label: "POST rest /repos/acme/api/issues/7/comments", body: { body: "Thanks!" } }]);
  });

  it("is refused while the connection has Review pull requests off", async () => {
    const { requests } = gitHub([]);

    await expect(postComment!(connection([]), { ...ref, body: "Thanks!" })).rejects.toThrow(
      /reviewPullRequests/,
    );
    expect(requests).toEqual([]);
  });

  it("says why GitHub refused it", async () => {
    installAjour(() => json({ message: "Validation Failed" }, 422), { access: [REVIEW] });

    await expect(
      postComment!(connection(), {
        ...ref,
        body: "Here.",
        anchor: { path: "src/retry.ts", side: "head", line: 999, headSha: "abc123" },
      }),
    ).rejects.toThrow("GitHub request failed (422): Validation Failed.");
  });
});

describe("submitReview", () => {
  it.each([
    ["approve", "APPROVE"],
    ["request_changes", "REQUEST_CHANGES"],
    ["comment", "COMMENT"],
  ] as const)("submits %s as GitHub's %s, with its comments on their lines", async (verdict, event) => {
    const { requests } = gitHub();

    await expect(
      submitReview!(connection(), {
        ...ref,
        headSha: "abc123",
        verdict,
        body: "A few things.",
        comments: [
          { path: "src/retry.ts", side: "head", line: 14, body: "Why 410 only?" },
          { path: "src/old.ts", side: "base", line: 9, startLine: 4, body: "These went away." },
        ],
      }),
    ).resolves.toEqual({ reviewId: "80" });

    expect(requests).toMatchObject([
      {
        label: "POST rest /repos/acme/api/pulls/7/reviews",
        body: {
          commit_id: "abc123",
          event,
          body: "A few things.",
          comments: [
            { path: "src/retry.ts", line: 14, side: "RIGHT", body: "Why 410 only?" },
            { path: "src/old.ts", line: 9, side: "LEFT", start_line: 4, start_side: "LEFT", body: "These went away." },
          ],
        },
      },
    ]);
  });

  it("sends no body when the review has none", async () => {
    const { requests } = gitHub();

    await submitReview!(connection(), { ...ref, headSha: "abc123", verdict: "approve", comments: [] });

    expect(requests[0]!.body).toEqual({ commit_id: "abc123", event: "APPROVE", comments: [] });
  });

  it("is refused while the connection has Review pull requests off", async () => {
    const { requests } = gitHub([]);

    await expect(
      submitReview!(connection([]), { ...ref, headSha: "abc123", verdict: "approve", comments: [] }),
    ).rejects.toThrow(/reviewPullRequests/);
    expect(requests).toEqual([]);
  });
});

describe("writes with a submission", () => {
  const SUBMISSION = "review_submission_1";
  const MARK = `<!-- ajour-review: ${SUBMISSION} -->`;
  /** When the first try was sent: GitHub's times below are around it. */
  const FIRST_TRY = Date.parse("2026-11-24T10:00:00Z");
  const at = (minutes: number) => new Date(FIRST_TRY + minutes * 60_000).toISOString();
  const review = {
    ...ref,
    headSha: "abc123",
    verdict: "approve" as const,
    body: "Ship it.",
    comments: [{ path: "src/retry.ts", side: "head" as const, line: 14, body: "Nit." }],
    submissionId: SUBMISSION,
  };
  const retry = { ...review, firstTriedAt: FIRST_TRY };

  interface Review {
    databaseId: number;
    state: string;
    viewerDidAuthor: boolean;
    body: string;
    createdAt: string;
    comments?: { databaseId: number; body: string }[];
  }
  interface IssueComment {
    databaseId: number;
    viewerDidAuthor: boolean;
    body: string;
    createdAt: string;
  }
  const node = (fields: Partial<Review> & { databaseId: number }): Review => ({
    state: "APPROVED",
    viewerDidAuthor: true,
    body: "",
    createdAt: at(1),
    ...fields,
  });

  /**
   * GitHub holding these reviews and conversation comments, oldest first,
   * served newest first in pages of `size`, and answering a post with id 80.
   */
  function gitHub({
    reviews = [],
    comments = [],
    size = 50,
  }: {
    reviews?: Review[];
    comments?: IssueComment[];
    size?: number;
  }) {
    const pageOf = <T>(items: T[], before: unknown) => {
      const end = typeof before === "string" ? Number(before) : items.length;
      const start = Math.max(0, end - size);
      return {
        pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
        nodes: items.slice(start, end),
      };
    };
    return stubGitHub(
      ({ query, variables }) => ({
        repository: {
          pullRequest: query.includes("reviews(")
            ? {
                reviews: pageOf(
                  reviews.map((each) => ({ ...each, comments: { nodes: each.comments ?? [] } })),
                  variables.before,
                ),
              }
            : { comments: pageOf(comments, variables.before) },
        },
      }),
      (request) => (request.path.endsWith("/reviews") ? json({ id: 80 }, 200) : json({ id: 80 }, 201)),
      { access: [REVIEW] },
    );
  }
  const posts = (requests: SeenRequest[]) => requests.filter((request) => request.host === "rest");

  it("marks the review with its submission on a line of its own before the summary, which GitHub doesn't show", async () => {
    const { requests } = gitHub({});

    await submitReview!(connection(), review);
    await submitReview!(connection(), { ...review, body: undefined });
    // A summary whose code fence never closes: the mark stays outside it.
    await submitReview!(connection(), { ...review, body: "```ts\nconst a = 1;" });

    expect(posts(requests).map((request) => request.body.body)).toEqual([
      `${MARK}\n\nShip it.`,
      MARK,
      `${MARK}\n\n\`\`\`ts\nconst a = 1;`,
    ]);
  });

  it("looks for nothing on a first try", async () => {
    const { calls, requests } = gitHub({});

    await expect(submitReview!(connection(), review)).resolves.toEqual({ reviewId: "80" });
    expect(calls).toEqual([]);
    expect(posts(requests)).toHaveLength(1);
  });

  it("finds the review an earlier try left, newest first through every page, and sends nothing again", async () => {
    // The first try's answer was lost after GitHub took the review; 120
    // reviews came after it.
    const { calls, requests } = gitHub({
      reviews: [
        node({ databaseId: 70, body: "LGTM", createdAt: at(-60) }),
        node({ databaseId: 79, body: `${MARK}\n\nShip it.`, createdAt: at(0) }),
        ...Array.from({ length: 120 }, (_, index) =>
          node({ databaseId: 100 + index, viewerDidAuthor: false, body: "Me too.", createdAt: at(2) }),
        ),
      ],
    });

    await expect(submitReview!(connection(), retry)).resolves.toEqual({ reviewId: "79" });
    expect(posts(requests)).toEqual([]);
    expect(calls.map((call) => call.variables)).toEqual([
      { owner: "acme", name: "api", number: 7 },
      { owner: "acme", name: "api", number: 7, before: "72" },
      { owner: "acme", name: "api", number: 7, before: "22" },
    ]);
  });

  it("stops looking at reviews from before the first try", async () => {
    const { calls, requests } = gitHub({
      reviews: Array.from({ length: 60 }, (_, index) =>
        node({ databaseId: index + 1, body: "Old.", state: "COMMENTED", createdAt: at(-60) }),
      ),
    });

    await expect(submitReview!(connection(), retry)).resolves.toEqual({ reviewId: "80" });
    expect(calls).toHaveLength(1);
    expect(posts(requests)).toHaveLength(1);
  });

  it.each([
    ["the end, as an earlier build put it", `Ship it.\n\n${MARK}`],
    ["the start, with words added after it", `${MARK}\n\nShip it.\n\nEdited on GitHub.`],
    ["the middle", `Ship it.\n\n${MARK}\n\nMore.`],
  ])("finds the review with its mark at %s", async (_, body) => {
    const { requests } = gitHub({ reviews: [node({ databaseId: 79, body })] });

    await expect(submitReview!(connection(), retry)).resolves.toEqual({ reviewId: "79" });
    expect(posts(requests)).toEqual([]);
  });

  it.each([
    ["someone else's", node({ databaseId: 79, viewerDidAuthor: false, body: MARK })],
    ["another submission's", node({ databaseId: 79, body: "<!-- ajour-review: other -->" })],
    ["a pending", node({ databaseId: 79, state: "PENDING", body: MARK })],
    ["a request for changes of the user's", node({ databaseId: 79, state: "CHANGES_REQUESTED", body: "No." })],
    [
      "a comment Ajour posted on its own",
      node({ databaseId: 79, state: "COMMENTED", comments: [{ databaseId: 5, body: "<!-- ajour-review: other -->\n\nHm." }] }),
    ],
    ["the user's review from before the first try", node({ databaseId: 79, body: "LGTM", createdAt: at(-10) })],
  ])("submits beside %s review", async (_, existing) => {
    const { requests } = gitHub({ reviews: [existing] });

    await expect(submitReview!(connection(), retry)).resolves.toEqual({ reviewId: "80" });
    expect(posts(requests)).toHaveLength(1);
  });

  it("can't tell, and posts nothing, when a review of the user's since the first try names no submission", async () => {
    // Someone edited the mark out of the review the first try posted.
    const { requests } = gitHub({ reviews: [node({ databaseId: 79, body: "Ship it, edited." })] });

    await expect(submitReview!(connection(), retry)).resolves.toEqual({ uncertain: true });
    expect(posts(requests)).toEqual([]);
  });

  it("can't tell, and posts nothing, when it runs out of pages before the first try", async () => {
    const { calls, requests } = gitHub({
      size: 1,
      reviews: Array.from({ length: 40 }, (_, index) =>
        node({ databaseId: index + 1, viewerDidAuthor: false, createdAt: at(2) }),
      ),
    });

    await expect(submitReview!(connection(), retry)).resolves.toEqual({ uncertain: true });
    expect(calls.length).toBeLessThan(40);
    expect(posts(requests)).toEqual([]);
  });

  it("refuses an identity a marker can't hold, sending nothing", async () => {
    const { requests } = gitHub({});

    await expect(submitReview!(connection(), { ...review, submissionId: "a --> b" })).rejects.toThrow(
      "The submission id",
    );
    expect(requests).toEqual([]);
  });

  describe("a comment", () => {
    const COMMENT_MARK = "<!-- ajour-review: comment_submission_1 -->";
    const onLine = {
      ...ref,
      body: "Why 410 only?",
      anchor: { path: "src/retry.ts", side: "head" as const, line: 14, headSha: "abc123" },
      submissionId: "comment_submission_1",
    };
    const onConversation = { ...ref, body: "Thanks!", submissionId: "comment_submission_1" };

    it("carries its mark before its words, on lines and on the conversation", async () => {
      const { requests } = gitHub({});

      await postComment!(connection(), onLine);
      await postComment!(connection(), onConversation);

      expect(posts(requests).map((request) => [request.label, request.body.body])).toEqual([
        ["POST rest /repos/acme/api/pulls/7/comments", `${COMMENT_MARK}\n\nWhy 410 only?`],
        ["POST rest /repos/acme/api/issues/7/comments", `${COMMENT_MARK}\n\nThanks!`],
      ]);
    });

    it("on lines: a retry finds the one an earlier try left among the user's reviews", async () => {
      const { requests } = gitHub({
        reviews: [
          node({
            databaseId: 60,
            state: "COMMENTED",
            comments: [{ databaseId: 61, body: `${COMMENT_MARK}\n\nWhy 410 only?` }],
          }),
        ],
      });

      await expect(postComment!(connection(), { ...onLine, firstTriedAt: FIRST_TRY })).resolves.toEqual({
        commentId: "61",
      });
      expect(posts(requests)).toEqual([]);
    });

    it("on the conversation: a retry finds the one an earlier try left", async () => {
      const { calls, requests } = gitHub({
        comments: [
          { databaseId: 61, viewerDidAuthor: true, body: `${COMMENT_MARK}\n\nThanks!`, createdAt: at(0) },
          { databaseId: 62, viewerDidAuthor: false, body: "You're welcome.", createdAt: at(1) },
        ],
      });

      await expect(
        postComment!(connection(), { ...onConversation, firstTriedAt: FIRST_TRY }),
      ).resolves.toEqual({ commentId: "61" });
      expect(posts(requests)).toEqual([]);
      expect(calls[0]!.query).toContain("comments(last:");
    });

    it("can't tell when a comment of the user's since the first try names no submission", async () => {
      const { requests } = gitHub({
        comments: [{ databaseId: 61, viewerDidAuthor: true, body: "Thanks! (edited)", createdAt: at(0) }],
      });

      await expect(
        postComment!(connection(), { ...onConversation, firstTriedAt: FIRST_TRY }),
      ).resolves.toEqual({ uncertain: true });
      expect(posts(requests)).toEqual([]);
    });

    it("posts on a retry that finds nothing of the user's since the first try", async () => {
      const { requests } = gitHub({
        comments: [{ databaseId: 61, viewerDidAuthor: true, body: "Earlier.", createdAt: at(-30) }],
      });

      await expect(
        postComment!(connection(), { ...onConversation, firstTriedAt: FIRST_TRY }),
      ).resolves.toEqual({ commentId: "80" });
      expect(posts(requests)).toHaveLength(1);
    });
  });
});

describe("withoutSubmissionMark", () => {
  it.each([
    ["<!-- ajour-review: r1 -->\n\nShip it.", "Ship it."],
    ["Ship it.\n\n<!-- ajour-review: r1 -->", "Ship it."],
    ["Ship it.\n\n<!-- ajour-review: r1 -->\n\nMore.", "Ship it.\n\nMore."],
    ["<!-- ajour-review: r1 -->", ""],
    ["Not ours: <!-- ajour-review: bad id -->", "Not ours: <!-- ajour-review: bad id -->"],
  ])("reads %j as %j", (body, words) => {
    expect(withoutSubmissionMark(body)).toBe(words);
  });
});
