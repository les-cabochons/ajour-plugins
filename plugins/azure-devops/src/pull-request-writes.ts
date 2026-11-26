import type { PullRequestConfig } from "./pull-request-config.ts";
import { findPullRequest, pullRequestPath, RESOLVED } from "./pull-request-review.ts";
import {
  API_VERSION,
  AzureReposClient,
  fetchViewer,
  time,
  type AzureIteration,
  type AzurePullRequest,
  type AzureThread,
} from "./pull-requests.ts";
import type {
  CodeHostLineAnchor,
  CodeHostPostCommentRequest,
  CodeHostPostCommentResult,
  CodeHostReplyRequest,
  CodeHostResolveThreadRequest,
  CodeHostResolveThreadResult,
  CodeHostSubmitReviewRequest,
  CodeHostSubmitReviewResult,
} from "./contract.ts";

/*
 * The writes of Deck's draft review (les-cabochons/ajour#784, ADR 0002). Azure
 * DevOps has no review to submit: a comment is a thread, and Finish review
 * posts a thread per line comment, one for the summary, then sets the
 * reviewer's vote, approve as 10 and request changes as -5, "Wait for
 * author". A comment leaves the vote as it is. Line comments sit on the
 * iteration whose head is the commit the user reviewed, against the common
 * commit of the source and target branches, the diff Deck showed. The
 * manifest puts these endpoints behind the "Review pull requests" access
 * choice, Code (Read & write), and Ajour refuses the operations while it's
 * off.
 *
 * The rest of a review round (les-cabochons/ajour#785) adds a reply at the
 * end of a thread and a thread resolved or unresolved. Azure DevOps keeps
 * no per-file viewed state the REST API shares, so the plugin offers no
 * setFileViewed, and Ajour keeps viewed marks on the computer.
 */

const VOTES: Record<CodeHostSubmitReviewRequest["verdict"], number | undefined> = {
  approve: 10,
  request_changes: -5,
  comment: undefined,
};

/** A text comment's type, and an active thread's status, as the REST API numbers them. */
const TEXT_COMMENT = 1;
const ACTIVE = 1;

/**
 * The thread property naming the review a thread was posted for. Azure
 * DevOps keeps a thread's properties and shows none of them, so a retry
 * finds what an earlier try posted by it. Ajour runs the tries of one
 * submission one at a time, so two windows retrying the same draft don't
 * both find nothing and both post.
 */
const SUBMISSION_PROPERTY = "Ajour.ReviewSubmission";

/** Lines as a range: a single line starts where it ends. */
function rangeOf(anchor: CodeHostLineAnchor) {
  return {
    start: anchor.startLine !== undefined && anchor.startLine < anchor.line ? anchor.startLine : anchor.line,
    end: anchor.line,
  };
}

/** Where a thread sits: the head's lines on the right of the file, the base's on the left. */
function threadContext(anchor: CodeHostLineAnchor) {
  const [start, end] = anchor.side === "base" ? ["leftFileStart", "leftFileEnd"] : ["rightFileStart", "rightFileEnd"];
  const range = rangeOf(anchor);
  return {
    filePath: `/${anchor.path.replace(/^\/+/, "")}`,
    [start]: { line: range.start, offset: 1 },
    [end]: { line: range.end, offset: 1 },
  };
}

function newThread(body: string, anchor?: CodeHostLineAnchor, iteration?: number, submissionId?: string) {
  return {
    comments: [{ parentCommentId: 0, content: body, commentType: TEXT_COMMENT }],
    status: ACTIVE,
    ...(anchor ? { threadContext: threadContext(anchor) } : {}),
    // Lines of the iteration the user reviewed. Equal comparing iterations
    // put the common commit of the two branches on the left, as Deck's diff
    // does; the first iteration would put the base's lines on older code.
    ...(anchor && iteration !== undefined
      ? {
          pullRequestThreadContext: {
            iterationContext: { firstComparingIteration: iteration, secondComparingIteration: iteration },
          },
        }
      : {}),
    ...(submissionId ? { properties: { [SUBMISSION_PROPERTY]: { $type: "System.String", $value: submissionId } } } : {}),
  };
}

const MOVED_ON = "The pull request has new commits since you read it.";

async function iterationsOf(client: AzureReposClient, pullRequest: AzurePullRequest) {
  return (
    await client.get<{ value: AzureIteration[] }>(`${pullRequestPath(pullRequest)}/iterations`, {
      "api-version": API_VERSION,
    })
  ).value.sort((left, right) => left.id - right.id);
}

/**
 * The iteration whose head is `headSha`: the one the user reviewed, and
 * whether it's the latest. A head no iteration has means the pull request
 * moved on since Deck read it.
 */
async function reviewedIteration(client: AzureReposClient, pullRequest: AzurePullRequest, headSha: string) {
  const iterations = await iterationsOf(client, pullRequest);
  const found = iterations.find((iteration) => iteration.sourceRefCommit?.commitId?.toLowerCase() === headSha.toLowerCase());
  if (!found) throw new Error(`${MOVED_ON} Open it again to comment on its latest changes.`);
  return { id: found.id, latest: found.id === iterations.at(-1)?.id };
}

/** Whether the latest iteration's head is `headSha`, read now. */
async function headIsLatest(client: AzureReposClient, pullRequest: AzurePullRequest, headSha: string) {
  const latest = (await iterationsOf(client, pullRequest)).at(-1);
  return latest?.sourceRefCommit?.commitId?.toLowerCase() === headSha.toLowerCase();
}

/** A post's place, the same for a thread and for what the request asks: a file's side and lines, or the whole pull request. */
function placeOf(anchor: CodeHostLineAnchor | undefined) {
  if (!anchor) return "";
  const { start, end } = rangeOf(anchor);
  return `${anchor.path.replace(/^\/+/, "")}|${anchor.side}|${start}|${end}`;
}

function threadPlace(thread: AzureThread) {
  const context = thread.threadContext ?? undefined;
  if (!context?.filePath) return "";
  const [side, start, end] = context.rightFileEnd
    ? (["head", context.rightFileStart?.line, context.rightFileEnd.line] as const)
    : (["base", context.leftFileStart?.line, context.leftFileEnd?.line] as const);
  return `${context.filePath.replace(/^\/+/, "")}|${side}|${start ?? end}|${end}`;
}

function clientOf(config: PullRequestConfig) {
  return new AzureReposClient(config.connectionId, config.savedOrganizationUrl);
}

const commentIdOf = (thread: AzureThread) => `${thread.id}-${thread.comments[0]?.id ?? 1}`;

/**
 * A comment, as a thread of its own: on lines when `anchor` is set, or on
 * the whole pull request. The thread carries the request's `submissionId`;
 * a retry returns the user's thread that carries it and posts nothing.
 */
export async function postPullRequestComment(
  config: PullRequestConfig,
  request: CodeHostPostCommentRequest,
): Promise<CodeHostPostCommentResult> {
  const client = clientOf(config);
  const pullRequest = await findPullRequest(client, request);
  const base = pullRequestPath(pullRequest);
  if (request.submissionId && request.firstTriedAt !== undefined) {
    const viewer = await fetchViewer(client);
    const [earlier] = await submissionThreads(client, base, viewer.id, request.submissionId);
    if (earlier) return { commentId: commentIdOf(earlier) };
  }
  const iteration = request.anchor ? (await reviewedIteration(client, pullRequest, request.anchor.headSha)).id : undefined;
  const thread = await client.send<AzureThread>(
    "POST",
    `${base}/threads`,
    { "api-version": API_VERSION },
    newThread(request.body, request.anchor, iteration, request.submissionId),
  );
  return { commentId: commentIdOf(thread) };
}

/**
 * A review: a thread for each line comment and one for the summary, then
 * the vote, all checked against the head the user reviewed first. An
 * approval needs that head to be the latest: a vote counts for the whole
 * pull request, code the user didn't read included.
 *
 * The latest iteration is read again right before an approval's vote, and
 * a push that landed while the threads posted sends no vote: the answer
 * says the vote was withheld, not a failure, since the threads are on the
 * pull request and a retry under a new submission would post them again.
 * Ajour takes them out of the draft and asks the user to vote again once
 * they've read the new commits. Azure DevOps
 * has no vote bound to a head, so a push in the moment between that read
 * and the vote still gets it. That gap is one request long, well under a
 * second; before, it lasted while every thread posted.
 *
 * Each thread carries the request's `submissionId`. A retry with the same
 * identity reads the pull request's threads and posts only the places it
 * finds no thread of that submission at, one thread for each, so Retry
 * after a failure, such as on the vote, repeats nothing, however long after.
 */
export async function submitPullRequestReview(
  config: PullRequestConfig,
  request: CodeHostSubmitReviewRequest,
): Promise<CodeHostSubmitReviewResult> {
  const client = clientOf(config);
  const [viewer, pullRequest] = await Promise.all([fetchViewer(client), findPullRequest(client, request)]);
  const base = pullRequestPath(pullRequest);
  const iteration = await reviewedIteration(client, pullRequest, request.headSha);
  if (request.verdict === "approve" && !iteration.latest) {
    throw new Error(`${MOVED_ON} Open it again to approve its latest changes.`);
  }
  const posted = request.submissionId ? await submissionPlaces(client, base, viewer.id, request.submissionId) : [];
  const posts: { body: string; anchor?: CodeHostLineAnchor }[] = [
    ...request.comments.map(({ body, ...anchor }) => ({ body, anchor })),
    ...(request.body ? [{ body: request.body }] : []),
  ];
  for (const post of posts) {
    // Each thread an earlier try posted stands for one post at its place.
    const done = posted.indexOf(placeOf(post.anchor));
    if (done !== -1) {
      posted.splice(done, 1);
      continue;
    }
    await client.send(
      "POST",
      `${base}/threads`,
      { "api-version": API_VERSION },
      newThread(post.body, post.anchor, iteration.id, request.submissionId),
    );
  }
  // Azure DevOps keeps no review: the pull request and its reviewer name it.
  const reviewId = `${pullRequest.pullRequestId}-${viewer.id}`;
  if (request.verdict === "approve" && !(await headIsLatest(client, pullRequest, request.headSha))) {
    return { reviewId, voteWithheld: { reason: "new_commits" } };
  }
  const vote = VOTES[request.verdict];
  if (vote !== undefined) {
    await client.send(
      "PUT",
      `${base}/reviewers/${encodeURIComponent(viewer.id)}`,
      { "api-version": API_VERSION },
      { vote },
    );
  }
  return { reviewId };
}

/** The threads the user posted for `submissionId`. */
async function submissionThreads(client: AzureReposClient, base: string, viewerId: string, submissionId: string) {
  const threads = (await client.get<{ value: AzureThread[] }>(`${base}/threads`, { "api-version": API_VERSION })).value;
  return threads.filter(
    (thread) =>
      !thread.isDeleted &&
      thread.properties?.[SUBMISSION_PROPERTY]?.$value === submissionId &&
      thread.comments[0]?.author?.id?.toLowerCase() === viewerId.toLowerCase(),
  );
}

/** The places of the threads the user posted for `submissionId`, one entry per thread. */
async function submissionPlaces(client: AzureReposClient, base: string, viewerId: string, submissionId: string) {
  return (await submissionThreads(client, base, viewerId, submissionId)).map(threadPlace);
}

/** Thread ids are the numbers the conversation reader names threads by. */
function threadNumber(threadId: string) {
  if (!/^\d{1,10}$/.test(threadId)) throw new Error("Azure DevOps could not find the review thread.");
  return Number(threadId);
}

/**
 * How far before the first try a comment of the user's still counts as
 * maybe the first try's, for the clocks of this computer and Azure DevOps
 * to disagree by.
 */
const CLOCK_SLACK_MS = 2 * 60_000;

/**
 * A reply at the end of a thread, under its first comment. Azure DevOps
 * comments carry no properties, and a hidden mark in the words might show,
 * so a reply carries no name: a retry reads the thread, and a comment of
 * the user's from around the first try on may be the earlier try's, so the
 * answer is uncertain and nothing is posted. Ajour then asks the user
 * before posting again, as a new submission.
 */
export async function replyToPullRequestThread(
  config: PullRequestConfig,
  request: CodeHostReplyRequest,
): Promise<CodeHostPostCommentResult> {
  const client = clientOf(config);
  const id = threadNumber(request.threadId);
  const pullRequest = await findPullRequest(client, request);
  const base = pullRequestPath(pullRequest);
  const threads = (await client.get<{ value: AzureThread[] }>(`${base}/threads`, { "api-version": API_VERSION })).value;
  const thread = threads.find((candidate) => candidate.id === id && !candidate.isDeleted);
  const first = thread?.comments[0]?.id;
  if (!thread || first === undefined) throw new Error("Azure DevOps could not find the review thread.");
  if (request.submissionId && request.firstTriedAt !== undefined) {
    const viewer = await fetchViewer(client);
    const since = request.firstTriedAt - CLOCK_SLACK_MS;
    const maybe = thread.comments.some(
      (comment) =>
        !comment.isDeleted &&
        comment.author?.id?.toLowerCase() === viewer.id.toLowerCase() &&
        !((time(comment.publishedDate) ?? Number.POSITIVE_INFINITY) < since),
    );
    if (maybe) return { uncertain: true };
  }
  const comment = await client.send<{ id: number }>(
    "POST",
    `${base}/threads/${id}/comments`,
    { "api-version": API_VERSION },
    { parentCommentId: first, content: request.body, commentType: TEXT_COMMENT },
  );
  return { commentId: `${id}-${comment.id}` };
}

/** Resolves a thread as fixed, or makes it active again, and answers the status Azure DevOps holds then. */
export async function setPullRequestThreadResolved(
  config: PullRequestConfig,
  request: CodeHostResolveThreadRequest,
): Promise<CodeHostResolveThreadResult> {
  const client = clientOf(config);
  const id = threadNumber(request.threadId);
  const pullRequest = await findPullRequest(client, request);
  const thread = await client.send<AzureThread>(
    "PATCH",
    `${pullRequestPath(pullRequest)}/threads/${id}`,
    { "api-version": API_VERSION },
    { status: request.resolved ? "fixed" : "active" },
  );
  return { resolved: RESOLVED.has(thread.status ?? "") };
}
