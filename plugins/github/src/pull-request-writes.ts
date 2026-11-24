import { pathSegments, type GitHubClient } from "./github.ts";
import type {
  CodeHostCommentResult,
  CodeHostDiffSide,
  CodeHostLineAnchor,
  CodeHostPostCommentRequest,
  CodeHostSubmitReviewRequest,
  CodeHostSubmitReviewResult,
} from "./contract.ts";

/*
 * The writes of Deck's draft review (les-cabochons/ajour#784, ADR 0002): a
 * comment posted at once, and a review submitted with its verdict and line
 * comments in one call, so GitHub holds no pending review. The manifest puts
 * these REST endpoints behind the "Review pull requests" access choice, and
 * Ajour refuses the operations while it's off.
 */

const EVENTS: Record<CodeHostSubmitReviewRequest["verdict"], string> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

/** GitHub's name for a side of the diff: the head's lines are on the right. */
const sideOf = (side: CodeHostDiffSide) => (side === "base" ? "LEFT" : "RIGHT");

/** A line anchor as GitHub's review comment fields. */
function lineFields(anchor: CodeHostLineAnchor) {
  const side = sideOf(anchor.side);
  return {
    path: anchor.path,
    line: anchor.line,
    side,
    ...(anchor.startLine !== undefined && anchor.startLine < anchor.line
      ? { start_line: anchor.startLine, start_side: side }
      : {}),
  };
}

const pullsPath = (repository: string, number: number) => `/repos/${pathSegments(repository)}/pulls/${number}`;

/** A comment on lines at the reviewed commit, or on the conversation without an anchor. */
export async function postPullRequestComment(
  client: GitHubClient,
  request: CodeHostPostCommentRequest,
): Promise<CodeHostCommentResult> {
  const { id } = request.anchor
    ? await client.rest<{ id: number }>(`${pullsPath(request.repository, request.number)}/comments`, {
        method: "POST",
        body: { body: request.body, commit_id: request.anchor.headSha, ...lineFields(request.anchor) },
      })
    : await client.rest<{ id: number }>(`/repos/${pathSegments(request.repository)}/issues/${request.number}/comments`, {
        method: "POST",
        body: { body: request.body },
      });
  return { commentId: String(id) };
}

/** A review with its verdict and its line comments, at the head the user reviewed. */
export async function submitPullRequestReview(
  client: GitHubClient,
  request: CodeHostSubmitReviewRequest,
): Promise<CodeHostSubmitReviewResult> {
  const { id } = await client.rest<{ id: number }>(`${pullsPath(request.repository, request.number)}/reviews`, {
    method: "POST",
    body: {
      commit_id: request.headSha,
      event: EVENTS[request.verdict],
      ...(request.body ? { body: request.body } : {}),
      comments: request.comments.map((comment) => ({ ...lineFields(comment), body: comment.body })),
    },
  });
  return { reviewId: String(id) };
}
