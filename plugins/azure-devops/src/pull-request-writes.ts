import type { PullRequestConfig } from "./pull-request-config.ts";
import { findPullRequest, pullRequestPath } from "./pull-request-review.ts";
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
  CodeHostCommentResult,
  CodeHostLineAnchor,
  CodeHostPostCommentRequest,
  CodeHostSubmitReviewRequest,
  CodeHostSubmitReviewResult,
} from "./contract.ts";

/*
 * The writes of Deck's draft review (les-cabochons/ajour#784, ADR 0002). Azure
 * DevOps has no review to submit: a comment is a thread, and Finish review
 * posts a thread per line comment, one for the summary, then sets the
 * reviewer's vote, approve as 10 and request changes as -5, "Wait for
 * author". A comment leaves the vote as it is. Line comments sit on the
 * iteration whose head is the commit the user reviewed, against the target
 * branch, the diff Deck showed. The manifest puts these
 * endpoints behind the "Review pull requests" access choice, Code (Read &
 * write), and Ajour refuses the operations while it's off.
 */

const VOTES: Record<CodeHostSubmitReviewRequest["verdict"], number | undefined> = {
  approve: 10,
  request_changes: -5,
  comment: undefined,
};

/** A text comment's type, and an active thread's status, as the REST API numbers them. */
const TEXT_COMMENT = 1;
const ACTIVE = 1;

/** Where a thread sits: the head's lines on the right of the file, the base's on the left. */
function threadContext(anchor: CodeHostLineAnchor) {
  const [start, end] = anchor.side === "base" ? ["leftFileStart", "leftFileEnd"] : ["rightFileStart", "rightFileEnd"];
  return {
    filePath: `/${anchor.path.replace(/^\/+/, "")}`,
    [start]: { line: anchor.startLine !== undefined && anchor.startLine < anchor.line ? anchor.startLine : anchor.line, offset: 1 },
    [end]: { line: anchor.line, offset: 1 },
  };
}

/** How long after a try a retry may find its comments posted already. */
const RETRY_WINDOW_MS = 15 * 60 * 1000;

function newThread(body: string, anchor?: CodeHostLineAnchor, iteration?: number) {
  return {
    comments: [{ parentCommentId: 0, content: body, commentType: TEXT_COMMENT }],
    status: ACTIVE,
    ...(anchor ? { threadContext: threadContext(anchor) } : {}),
    // Lines of the iteration the user reviewed, compared with the target branch.
    ...(anchor && iteration !== undefined
      ? {
          pullRequestThreadContext: {
            iterationContext: { firstComparingIteration: 1, secondComparingIteration: iteration },
          },
        }
      : {}),
  };
}

/**
 * The iteration whose head is `headSha`: the one the user reviewed. A head
 * no iteration has means the pull request moved on since Deck read it.
 */
async function reviewedIteration(client: AzureReposClient, pullRequest: AzurePullRequest, headSha: string) {
  const iterations = (
    await client.get<{ value: AzureIteration[] }>(`${pullRequestPath(pullRequest)}/iterations`, {
      "api-version": API_VERSION,
    })
  ).value;
  const found = iterations.find((iteration) => iteration.sourceRefCommit?.commitId?.toLowerCase() === headSha.toLowerCase());
  if (!found) {
    throw new Error(
      "The pull request has new commits since you read it. Open it again to comment on its latest changes.",
    );
  }
  return found.id;
}

/** The same place and words as `anchor` and `body`: no context for a thread on the whole pull request. */
function samePlace(thread: AzureThread, body: string, anchor: CodeHostLineAnchor | undefined) {
  const context = thread.threadContext ?? undefined;
  if (thread.comments[0]?.content?.trim() !== body.trim()) return false;
  if (!anchor) return !context?.filePath;
  const end = anchor.side === "base" ? context?.leftFileEnd?.line : context?.rightFileEnd?.line;
  return context?.filePath?.replace(/^\/+/, "") === anchor.path.replace(/^\/+/, "") && end === anchor.line;
}

function clientOf(config: PullRequestConfig) {
  return new AzureReposClient(config.connectionId, config.savedOrganizationUrl);
}

/** A comment, as a thread of its own: on lines when `anchor` is set, or on the whole pull request. */
export async function postPullRequestComment(
  config: PullRequestConfig,
  request: CodeHostPostCommentRequest,
): Promise<CodeHostCommentResult> {
  const client = clientOf(config);
  const pullRequest = await findPullRequest(client, request);
  const iteration = request.anchor ? await reviewedIteration(client, pullRequest, request.anchor.headSha) : undefined;
  const thread = await client.send<AzureThread>(
    "POST",
    `${pullRequestPath(pullRequest)}/threads`,
    { "api-version": API_VERSION },
    newThread(request.body, request.anchor, iteration),
  );
  return { commentId: `${thread.id}-${thread.comments[0]?.id ?? 1}` };
}

/**
 * A review: a thread for each line comment and one for the summary, then
 * the vote. A comment the user posted in the last 15 minutes at the same
 * place with the same words is taken as an earlier try's and isn't posted
 * again, so Retry after a failure, such as on the vote, repeats nothing.
 */
export async function submitPullRequestReview(
  config: PullRequestConfig,
  request: CodeHostSubmitReviewRequest,
): Promise<CodeHostSubmitReviewResult> {
  const client = clientOf(config);
  const [viewer, pullRequest] = await Promise.all([fetchViewer(client), findPullRequest(client, request)]);
  const base = pullRequestPath(pullRequest);
  const iteration = request.comments.length ? await reviewedIteration(client, pullRequest, request.headSha) : undefined;
  const since = Date.now() - RETRY_WINDOW_MS;
  const theirs = (await client.get<{ value: AzureThread[] }>(`${base}/threads`, { "api-version": API_VERSION })).value.filter(
    (thread) =>
      !thread.isDeleted &&
      thread.comments[0]?.author?.id?.toLowerCase() === viewer.id.toLowerCase() &&
      (time(thread.publishedDate ?? thread.comments[0]?.publishedDate) ?? 0) >= since,
  );
  const posts: { body: string; anchor?: CodeHostLineAnchor }[] = [
    ...request.comments.map(({ body, ...anchor }) => ({ body, anchor })),
    ...(request.body ? [{ body: request.body }] : []),
  ];
  for (const post of posts) {
    if (theirs.some((thread) => samePlace(thread, post.body, post.anchor))) continue;
    await client.send("POST", `${base}/threads`, { "api-version": API_VERSION }, newThread(post.body, post.anchor, iteration));
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
  // Azure DevOps keeps no review: the pull request and its reviewer name it.
  return { reviewId: `${pullRequest.pullRequestId}-${viewer.id}` };
}
