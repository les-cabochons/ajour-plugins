import { pathSegments, splitRepository, type GitHubClient } from "./github.ts";
import type {
  CodeHostDiffSide,
  CodeHostLineAnchor,
  CodeHostPostCommentRequest,
  CodeHostPostCommentResult,
  CodeHostPullRequestRef,
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
 * GitHub takes no idempotency key, so a review or comment carries its
 * submission id in an HTML comment on the first line of its body, which
 * GitHub's pages don't show. A retry looks back, newest first, to the first
 * try for the user's post that carries it: an earlier try whose answer was
 * lost, after GitHub took it. A post of the user's since then that names no
 * submission may be it with the mark edited out, so the answer is
 * uncertain, and Ajour asks the user before posting again; so is a look
 * that runs out of pages first. Ajour runs the tries of one submission one
 * at a time.
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

/** The hidden line naming a post's submission. Ajour's own reading leaves it out. */
const markOf = (submissionId: string) => `<!-- ajour-review: ${submissionId} -->`;
const MARK = /<!-- ajour-review: ([\w-]{1,100}) -->/g;

/** The submissions a body's intact marks name, wherever they are in it. */
function marksIn(body: string) {
  return [...body.matchAll(MARK)].map((match) => match[1]!);
}

/** A body without its submission lines, wherever an edit left them. */
export function withoutSubmissionMark(body: string) {
  return body
    .replace(/[ \t]*<!-- ajour-review: [\w-]{1,100} -->[ \t]*(?:\r?\n){0,2}/g, "")
    .trimEnd();
}

/**
 * The words to post, after the mark on a line of its own: first, so no
 * formatting the user's Markdown leaves open, such as a code fence that
 * never closes, takes it in.
 */
function marked(body: string | undefined, submissionId: string | undefined) {
  if (!submissionId) return body;
  return body ? `${markOf(submissionId)}\n\n${body}` : markOf(submissionId);
}

function checkSubmissionId(submissionId: string | undefined) {
  if (submissionId !== undefined && !/^[\w-]{1,100}$/.test(submissionId)) {
    throw new Error("The submission id must be letters, digits, - and _.");
  }
}

/**
 * How far before the first try a retry looks, for the clocks of this
 * computer and GitHub to disagree by.
 */
const CLOCK_SLACK_MS = 2 * 60_000;
/** Pages a retry reads before it calls the answer uncertain. */
const MAX_PAGES = 20;

interface Page<T> {
  pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
  nodes: (T | null)[];
}

/** What a post on GitHub is to a retry: the one it looks for, maybe it with its mark edited out, or neither. */
type Verdict<T> = { found: T } | "maybe" | undefined;

/**
 * Reads a pull request's posts newest first, page by page, back to the
 * first try: the post that carries the submission, or `uncertain` when one
 * of the user's since then names none, or the pages ran out first.
 * Undefined when nothing since the first try is the user's.
 */
async function lookBack<T extends { createdAt: string }, R>(
  page: (before: string | undefined) => Promise<Page<T> | undefined>,
  firstTriedAt: number,
  judge: (node: T) => Verdict<R>,
): Promise<{ found: R } | "uncertain" | undefined> {
  const since = firstTriedAt - CLOCK_SLACK_MS;
  let maybe = false;
  let before: string | undefined;
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const current = await page(before);
    if (!current) return maybe ? "uncertain" : undefined;
    for (const node of [...current.nodes].reverse()) {
      if (!node) continue;
      if (Date.parse(node.createdAt) < since) return maybe ? "uncertain" : undefined;
      const verdict = judge(node);
      if (verdict === "maybe") maybe = true;
      else if (verdict) return verdict;
    }
    if (!current.pageInfo.hasPreviousPage || !current.pageInfo.startCursor) {
      return maybe ? "uncertain" : undefined;
    }
    before = current.pageInfo.startCursor;
  }
  // A truncated look isn't "nothing posted".
  return "uncertain";
}

const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 50, before: $before) {
        pageInfo { hasPreviousPage startCursor }
        nodes { databaseId state viewerDidAuthor body createdAt comments(first: 10) { nodes { databaseId body } } }
      }
    }
  }
}`;

const COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(last: 100, before: $before) {
        pageInfo { hasPreviousPage startCursor }
        nodes { databaseId viewerDidAuthor body createdAt }
      }
    }
  }
}`;

interface ReviewNode {
  databaseId: number | null;
  state: string;
  viewerDidAuthor: boolean;
  body: string;
  createdAt: string;
  comments: { nodes: ({ databaseId: number | null; body: string } | null)[] };
}

interface CommentNode {
  databaseId: number | null;
  viewerDidAuthor: boolean;
  body: string;
  createdAt: string;
}

/** A page of the pull request's reviews or conversation comments, before `before`. */
function pages<T>(client: GitHubClient, ref: CodeHostPullRequestRef, query: string, field: "reviews" | "comments") {
  const [owner, name] = splitRepository(ref.repository);
  return async (before: string | undefined) => {
    const data = await client.query<{
      repository: { pullRequest: Record<string, Page<T>> | null } | null;
    }>(query, { owner, name, number: ref.number, ...(before ? { before } : {}) });
    return data.repository?.pullRequest?.[field];
  };
}

/** The review state each verdict leaves; a dismissed review was one of them. */
const STATES: Record<CodeHostSubmitReviewRequest["verdict"], string> = {
  approve: "APPROVED",
  request_changes: "CHANGES_REQUESTED",
  comment: "COMMENTED",
};

/** The user's submitted reviews, with their comments' marks. */
function submitted(node: ReviewNode) {
  return node.viewerDidAuthor && node.state !== "PENDING" && node.databaseId != null;
}
const commentMarks = (node: ReviewNode) => node.comments.nodes.flatMap((comment) => (comment ? marksIn(comment.body) : []));

/**
 * The review an earlier try of `request` left: the user's that carries its
 * mark. A review of the user's of the same kind that names no submission
 * may be it with the mark edited out.
 */
function judgeReview(request: CodeHostSubmitReviewRequest, submissionId: string) {
  return (node: ReviewNode): Verdict<number> => {
    if (!submitted(node)) return undefined;
    const marks = marksIn(node.body);
    if (marks.includes(submissionId)) return { found: node.databaseId! };
    if (marks.length || commentMarks(node).length) return undefined;
    return node.state === STATES[request.verdict] || node.state === "DISMISSED" ? "maybe" : undefined;
  };
}

/** A comment on lines posts as a review of one comment: the user's whose comment carries the mark. */
function judgeLineComment(submissionId: string) {
  return (node: ReviewNode): Verdict<number> => {
    if (!submitted(node)) return undefined;
    const found = node.comments.nodes.find((comment) => comment && marksIn(comment.body).includes(submissionId));
    if (found?.databaseId != null) return { found: found.databaseId };
    if (marksIn(node.body).length || commentMarks(node).length) return undefined;
    return node.state === "COMMENTED" ? "maybe" : undefined;
  };
}

function judgeConversationComment(submissionId: string) {
  return (node: CommentNode): Verdict<number> => {
    if (!node.viewerDidAuthor || node.databaseId == null) return undefined;
    const marks = marksIn(node.body);
    if (marks.includes(submissionId)) return { found: node.databaseId };
    return marks.length ? undefined : "maybe";
  };
}

/**
 * A comment on lines at the reviewed commit, or on the conversation without
 * an anchor. A retry of a submission first finds what an earlier try left.
 */
export async function postPullRequestComment(
  client: GitHubClient,
  request: CodeHostPostCommentRequest,
): Promise<CodeHostPostCommentResult> {
  const { submissionId, firstTriedAt } = request;
  checkSubmissionId(submissionId);
  if (submissionId && firstTriedAt !== undefined) {
    const earlier = request.anchor
      ? await lookBack(
          pages<ReviewNode>(client, request, REVIEWS_QUERY, "reviews"),
          firstTriedAt,
          judgeLineComment(submissionId),
        )
      : await lookBack(
          pages<CommentNode>(client, request, COMMENTS_QUERY, "comments"),
          firstTriedAt,
          judgeConversationComment(submissionId),
        );
    if (earlier === "uncertain") return { uncertain: true };
    if (earlier) return { commentId: String(earlier.found) };
  }
  const body = marked(request.body, submissionId);
  const { id } = request.anchor
    ? await client.rest<{ id: number }>(`${pullsPath(request.repository, request.number)}/comments`, {
        method: "POST",
        body: { body, commit_id: request.anchor.headSha, ...lineFields(request.anchor) },
      })
    : await client.rest<{ id: number }>(`/repos/${pathSegments(request.repository)}/issues/${request.number}/comments`, {
        method: "POST",
        body: { body },
      });
  return { commentId: String(id) };
}

/**
 * A review with its verdict and its line comments, at the head the user
 * reviewed. A retry of a submission returns the review GitHub already
 * holds as it is, and sends nothing twice.
 */
export async function submitPullRequestReview(
  client: GitHubClient,
  request: CodeHostSubmitReviewRequest,
): Promise<CodeHostSubmitReviewResult> {
  const { submissionId, firstTriedAt } = request;
  checkSubmissionId(submissionId);
  if (submissionId && firstTriedAt !== undefined) {
    const earlier = await lookBack(
      pages<ReviewNode>(client, request, REVIEWS_QUERY, "reviews"),
      firstTriedAt,
      judgeReview(request, submissionId),
    );
    if (earlier === "uncertain") return { uncertain: true };
    if (earlier) return { reviewId: String(earlier.found) };
  }
  const body = marked(request.body, submissionId);
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
