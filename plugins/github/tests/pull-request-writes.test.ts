import { afterEach, describe, expect, it, vi } from "vitest";
import { postComment, submitReview } from "../src/plugin.ts";
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

describe("submitReview with a submission", () => {
  const SUBMISSION = "review_submission_1";
  const MARK = `<!-- ajour-review: ${SUBMISSION} -->`;
  const review = {
    ...ref,
    headSha: "abc123",
    verdict: "approve" as const,
    body: "Ship it.",
    comments: [{ path: "src/retry.ts", side: "head" as const, line: 14, body: "Nit." }],
    submissionId: SUBMISSION,
  };

  /** GitHub with these reviews on the pull request, answering a new review with id 80. */
  function withReviews(nodes: unknown[]) {
    return stubGitHub(
      () => ({ repository: { pullRequest: { reviews: { nodes } } } }),
      () => json({ id: 80 }, 200),
      { access: [REVIEW] },
    );
  }

  it("marks the review with its submission in a line GitHub doesn't show", async () => {
    const { requests } = withReviews([]);

    await submitReview!(connection(), review);
    await submitReview!(connection(), { ...review, body: undefined });

    expect(requests.filter((request) => request.host === "rest").map((request) => request.body.body)).toEqual([
      `Ship it.\n\n${MARK}`,
      MARK,
    ]);
  });

  it("finds the review an earlier try left, and sends nothing again", async () => {
    // The first try's answer was lost after GitHub took the review.
    const { requests } = withReviews([
      { databaseId: 70, state: "APPROVED", viewerDidAuthor: true, body: "LGTM" },
      { databaseId: 79, state: "APPROVED", viewerDidAuthor: true, body: `Ship it.\n\n${MARK}` },
    ]);

    await expect(submitReview!(connection(), review)).resolves.toEqual({ reviewId: "79" });
    expect(requests.filter((request) => request.host === "rest")).toEqual([]);
    expect(requests[0]!.body.variables).toEqual({ owner: "acme", name: "api", number: 7 });
  });

  it.each([
    ["someone else's", { databaseId: 79, state: "APPROVED", viewerDidAuthor: false, body: MARK }],
    ["another submission's", { databaseId: 79, state: "APPROVED", viewerDidAuthor: true, body: "<!-- ajour-review: other -->" }],
    ["a pending", { databaseId: 79, state: "PENDING", viewerDidAuthor: true, body: MARK }],
  ])("submits beside %s review", async (_, node) => {
    const { requests } = withReviews([node]);

    await expect(submitReview!(connection(), review)).resolves.toEqual({ reviewId: "80" });
    expect(requests.filter((request) => request.host === "rest")).toHaveLength(1);
  });

  it("refuses an identity a marker can't hold, sending nothing", async () => {
    const { requests } = withReviews([]);

    await expect(submitReview!(connection(), { ...review, submissionId: "a --> b" })).rejects.toThrow(
      "The review's submission id",
    );
    expect(requests).toEqual([]);
  });
});
