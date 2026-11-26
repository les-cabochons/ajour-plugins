import { pathSegments, splitRepository, type GitHubClient } from "./github.ts";
import type {
  CodeHostDiffSide,
  CodeHostLineAnchor,
  CodeHostPostCommentRequest,
  CodeHostPostCommentResult,
  CodeHostPullRequestRef,
  CodeHostReplyRequest,
  CodeHostResolveThreadRequest,
  CodeHostResolveThreadResult,
  CodeHostSetFileViewedRequest,
  CodeHostSetFileViewedResult,
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
 * GitHub's pages don't show. A retry reads the history, newest first, for
 * the user's post that carries it: an earlier try whose answer was lost,
 * after GitHub took it. It reads back to the first post whatever the time,
 * since this computer's clock may run ahead of GitHub's. A post of the
 * user's from around the first try on that names no submission may be it
 * with the mark edited out, so the answer is uncertain, and Ajour asks the
 * user before posting again; so is a look that runs out of pages first.
 * Ajour runs the tries of one submission one at a time.
 *
 * The rest of a review round (les-cabochons/ajour#785) writes here too: a
 * reply, marked and found again the same way, to a thread's first comment
 * through REST, and through GraphQL, which has no REST form, a thread
 * resolved or unresolved and a file marked viewed or not.
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
 * How far before the first try a post of the user's that names no
 * submission still counts as maybe the first try's, for the clocks of this
 * computer and GitHub to disagree by. Only a hint: the look for the mark
 * itself reads the whole history, since this computer's clock proves
 * nothing about what GitHub holds.
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
 * first: the post that carries the submission, or `uncertain` when one of
 * the user's from around the first try on names none, or the pages ran out
 * before the first post. Undefined when the whole history holds neither.
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
      const verdict = judge(node);
      if (verdict === "maybe") {
        // An unmarked post is only a suspect from around the first try on.
        if (!(Date.parse(node.createdAt) < since)) maybe = true;
      } else if (verdict) return verdict;
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

const THREAD_QUERY = `query($id: ID!, $before: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      pullRequest { number repository { nameWithOwner } }
      first: comments(first: 1) { nodes { databaseId } }
      comments(last: 100, before: $before) {
        pageInfo { hasPreviousPage startCursor }
        nodes { databaseId viewerDidAuthor body createdAt }
      }
    }
  }
}`;

/** The pull request a review thread is on. */
interface ThreadParent {
  number: number;
  repository: { nameWithOwner: string };
}

/**
 * Refuses a thread of another pull request than the request's: GitHub's
 * thread writes and reads name the thread alone. Ajour checks it too; this
 * is the second check.
 */
function checkThreadParent(parent: ThreadParent | undefined, request: { repository: string; number: number }) {
  if (!parent) throw new Error("GitHub could not find the review thread.");
  if (
    parent.number !== request.number ||
    parent.repository.nameWithOwner.toLowerCase() !== request.repository.toLowerCase()
  ) {
    throw new Error("This review thread belongs to another pull request.");
  }
}

interface ThreadNode {
  pullRequest: ThreadParent;
  first: { nodes: ({ databaseId: number | null } | null)[] };
  comments: Page<CommentNode>;
}

async function readThread(client: GitHubClient, threadId: string, before: string | undefined) {
  const data = await client.query<{ node: Partial<ThreadNode> | null }>(THREAD_QUERY, {
    id: threadId,
    ...(before ? { before } : {}),
  });
  const thread = data.node;
  return thread?.first && thread.comments ? (thread as ThreadNode) : undefined;
}

/**
 * A reply at the end of a review thread, to its first comment, as GitHub's
 * own Reply does. A retry of a submission first reads the thread's
 * comments, newest first, for the user's that carries its mark.
 */
export async function replyToPullRequestThread(
  client: GitHubClient,
  request: CodeHostReplyRequest,
): Promise<CodeHostPostCommentResult> {
  const { submissionId, firstTriedAt } = request;
  checkSubmissionId(submissionId);
  const thread = await readThread(client, request.threadId, undefined);
  checkThreadParent(thread?.pullRequest, request);
  const first = thread?.first.nodes[0]?.databaseId;
  if (!thread || first == null) throw new Error("GitHub could not find the review thread.");
  if (submissionId && firstTriedAt !== undefined) {
    // The newest page came with the thread; older ones are read as needed.
    const earlier = await lookBack(
      async (before) => (before ? (await readThread(client, request.threadId, before))?.comments : thread.comments),
      firstTriedAt,
      judgeConversationComment(submissionId),
    );
    if (earlier === "uncertain") return { uncertain: true };
    if (earlier) return { commentId: String(earlier.found) };
  }
  const { id } = await client.rest<{ id: number }>(
    `${pullsPath(request.repository, request.number)}/comments/${first}/replies`,
    { method: "POST", body: { body: marked(request.body, submissionId) } },
  );
  return { commentId: String(id) };
}

const THREAD_PARENT_QUERY = `query($id: ID!) {
  node(id: $id) { ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } } }
}`;

/**
 * Resolves or unresolves a review thread, and answers the state GitHub
 * holds then. The mutation names the thread alone, so the thread's pull
 * request is read first, and a thread of another one is refused.
 */
export async function setPullRequestThreadResolved(
  client: GitHubClient,
  request: CodeHostResolveThreadRequest,
): Promise<CodeHostResolveThreadResult> {
  const { node } = await client.query<{ node: { pullRequest?: ThreadParent } | null }>(THREAD_PARENT_QUERY, {
    id: request.threadId,
  });
  checkThreadParent(node?.pullRequest, request);
  const mutation = request.resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const data = await client.query<Record<string, { thread: { isResolved: boolean } | null } | null>>(
    `mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { isResolved } } }`,
    { id: request.threadId },
  );
  const thread = data[mutation]?.thread;
  if (!thread) throw new Error("GitHub could not find the review thread.");
  return { resolved: thread.isResolved };
}

const PULL_REQUEST_HEAD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id headRefOid } }
}`;

/**
 * Marks a file viewed, or not, as GitHub's Viewed box does. GitHub keeps the
 * mark for the pull request's head, so a file is marked viewed only while
 * the head is the one the user read; unmarking needs no check.
 */
export async function setPullRequestFileViewed(
  client: GitHubClient,
  request: CodeHostSetFileViewedRequest,
): Promise<CodeHostSetFileViewedResult> {
  const [owner, name] = splitRepository(request.repository);
  const data = await client.query<{
    repository: { pullRequest: { id: string; headRefOid: string } | null } | null;
  }>(PULL_REQUEST_HEAD_QUERY, { owner, name, number: request.number });
  const pullRequest = data.repository?.pullRequest;
  if (!pullRequest) throw new Error("GitHub could not find the pull request.");
  if (request.viewed && pullRequest.headRefOid.toLowerCase() !== request.headSha.toLowerCase()) {
    throw new Error("The pull request has new commits since you read it. Refresh to mark its latest changes viewed.");
  }
  const mutation = request.viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
  await client.query(
    `mutation($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { pullRequest { id } } }`,
    { id: pullRequest.id, path: request.path },
  );
  return { viewed: request.viewed };
}
