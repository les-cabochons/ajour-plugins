import type { PullRequestConfig } from "./pull-request-config.ts";
import { findPullRequest, pullRequestPath } from "./pull-request-review.ts";
import { API_VERSION, AzureReposClient, type AzurePullRequest } from "./pull-requests.ts";
import type {
  CodeHostMergeRequest,
  CodeHostMergeResult,
  CodeHostUpdatePullRequestRequest,
  CodeHostUpdatePullRequestResult,
} from "./contract.ts";

/*
 * The author's actions from Deck (les-cabochons/ajour#786, ADR 0002): edit
 * the title, mark as draft or publish, and complete the pull request with a
 * merge strategy. Each is one update of the pull request, which the manifest
 * puts behind "Review pull requests", Code (Read & write); Ajour refuses the
 * operations while it's off.
 *
 * A merge happens at most once, and only at the head the user saw. It first
 * reads the pull request: one already completed at that head is the answer
 * to a retry whose first answer was lost, and completes nothing again. Then
 * it completes it with `lastMergeSourceCommit` set to that head, which Azure
 * DevOps refuses if a push landed since. When the completion fails, it reads
 * the pull request again, since Azure DevOps may have completed it before
 * its answer was lost.
 */

const STRATEGIES: Record<CodeHostMergeRequest["method"], string> = {
  merge: "noFastForward",
  squash: "squash",
  rebase: "rebase",
};

const MOVED = "The pull request has new commits since you read it. Refresh to review them before merging.";

function clientOf(config: PullRequestConfig) {
  return new AzureReposClient(config.connectionId, config.savedOrganizationUrl);
}

/** The title, the draft state or both, in one update, answered with what Azure DevOps then holds. */
export async function updateAzurePullRequest(
  config: PullRequestConfig,
  request: CodeHostUpdatePullRequestRequest,
): Promise<CodeHostUpdatePullRequestResult> {
  const client = clientOf(config);
  const pullRequest = await findPullRequest(client, request);
  const updated = await client.send<AzurePullRequest>(
    "PATCH",
    pullRequestPath(pullRequest),
    { "api-version": API_VERSION },
    {
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.draft !== undefined ? { isDraft: request.draft } : {}),
    },
  );
  return { title: updated.title, draft: updated.isDraft ?? false };
}

const mergeOf = (pullRequest: AzurePullRequest): CodeHostMergeResult =>
  pullRequest.lastMergeCommit?.commitId ? { mergeCommitSha: pullRequest.lastMergeCommit.commitId } : {};

const headOf = (pullRequest: AzurePullRequest) => pullRequest.lastMergeSourceCommit?.commitId;

/**
 * The merge an earlier try made, when the pull request completed at the
 * head the user saw. Throws when it can't complete it: merged at another
 * head, abandoned, moved on, or a draft.
 */
function earlierMerge(pullRequest: AzurePullRequest, request: CodeHostMergeRequest) {
  if (pullRequest.status === "completed") {
    if (headOf(pullRequest) !== request.headSha) {
      throw new Error("This pull request was already merged, with commits you didn't read.");
    }
    return mergeOf(pullRequest);
  }
  if (pullRequest.status === "abandoned") throw new Error("This pull request was abandoned.");
  if (headOf(pullRequest) !== request.headSha) throw new Error(MOVED);
  if (pullRequest.isDraft) throw new Error("This pull request is a draft. Publish it to merge it.");
  return undefined;
}

/** What goes in the merge commit's message: the title, then the message after a blank line. */
function commitMessage(request: CodeHostMergeRequest) {
  // A rebase and fast-forward makes no merge commit.
  if (request.method === "rebase") return undefined;
  const parts = [request.commitTitle, request.commitMessage].filter((part) => part?.trim());
  return parts.length ? parts.join("\n\n") : undefined;
}

/** Completes the pull request with `method` at the head the user saw, once. */
export async function mergeAzurePullRequest(
  config: PullRequestConfig,
  request: CodeHostMergeRequest,
): Promise<CodeHostMergeResult> {
  const client = clientOf(config);
  const pullRequest = await findPullRequest(client, request);
  const earlier = earlierMerge(pullRequest, request);
  if (earlier) return earlier;
  const message = commitMessage(request);
  try {
    const completed = await client.send<AzurePullRequest>(
      "PATCH",
      pullRequestPath(pullRequest),
      { "api-version": API_VERSION },
      {
        status: "completed",
        lastMergeSourceCommit: { commitId: request.headSha },
        completionOptions: {
          mergeStrategy: STRATEGIES[request.method],
          ...(message ? { mergeCommitMessage: message } : {}),
        },
      },
    );
    // Azure DevOps may still be completing it: no merge commit yet.
    return completed.status === "completed" ? mergeOf(completed) : {};
  } catch (error) {
    // Azure DevOps may have completed it before its answer was lost.
    const after = await findPullRequest(client, request).catch(() => undefined);
    if (after?.status === "completed" && headOf(after) === request.headSha) return mergeOf(after);
    throw error;
  }
}
