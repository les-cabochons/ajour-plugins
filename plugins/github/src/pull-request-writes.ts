import { pathSegments, splitRepository, type GitHubClient } from "./github.ts";
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
 *
 * GitHub takes no idempotency key, so a review carries its submission id in
 * an HTML comment at the end of its body, which GitHub's pages don't show.
 * Before posting, a submit with an id looks for the user's review that
 * carries it: an earlier try whose answer was lost, after GitHub took it.
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

/** The hidden line naming a review's submission. Ajour's own reading leaves it out. */
const markOf = (submissionId: string) => `<!-- ajour-review: ${submissionId} -->`;
const MARK = /\s*<!-- ajour-review: [\w-]+ -->\s*$/;

/** A review body without its submission line. */
export function withoutSubmissionMark(body: string) {
  return body.replace(MARK, "");
}

const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { reviews(last: 100) { nodes { databaseId state viewerDidAuthor body } } }
  }
}`;

interface ReviewNode {
  databaseId: number | null;
  state: string;
  viewerDidAuthor: boolean;
  body: string;
}

/** The user's submitted review that carries `submissionId`, among the pull request's last 100. */
async function findSubmitted(client: GitHubClient, request: CodeHostSubmitReviewRequest, submissionId: string) {
  const [owner, name] = splitRepository(request.repository);
  const data = await client.query<{
    repository: { pullRequest: { reviews: { nodes: (ReviewNode | null)[] } } | null } | null;
  }>(REVIEWS_QUERY, { owner, name, number: request.number });
  const mark = markOf(submissionId);
  return data.repository?.pullRequest?.reviews.nodes.find(
    (node) =>
      node?.databaseId != null && node.viewerDidAuthor && node.state !== "PENDING" && node.body.trimEnd().endsWith(mark),
  );
}

/**
 * A review with its verdict and its line comments, at the head the user
 * reviewed. With a submission id, one GitHub already holds is returned as
 * it is: a retry sends nothing twice.
 */
export async function submitPullRequestReview(
  client: GitHubClient,
  request: CodeHostSubmitReviewRequest,
): Promise<CodeHostSubmitReviewResult> {
  const { submissionId } = request;
  if (submissionId !== undefined && !/^[\w-]{1,100}$/.test(submissionId)) {
    throw new Error("The review's submission id must be letters, digits, - and _.");
  }
  if (submissionId) {
    const submitted = await findSubmitted(client, request, submissionId);
    if (submitted) return { reviewId: String(submitted.databaseId) };
  }
  const body = submissionId
    ? request.body
      ? `${request.body}

${markOf(submissionId)}`
      : markOf(submissionId)
    : request.body;
  const { id } = await client.rest<{ id: number }>(`${pullsPath(request.repository, request.number)}/reviews`, {
    method: "POST",
    body: {
      commit_id: request.headSha,
      event: EVENTS[request.verdict],
      ...(body ? { body } : {}),
      comments: request.comments.map((comment) => ({ ...lineFields(comment), body: comment.body })),
    },
  });
  return { reviewId: String(id) };
}
