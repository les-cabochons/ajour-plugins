import { pathSegments, type GitHubClient } from "./github.ts";
import type {
  CodeHostMergeRequest,
  CodeHostMergeResult,
  CodeHostUpdatePullRequestRequest,
  CodeHostUpdatePullRequestResult,
} from "./contract.ts";

/*
 * The author's actions from Deck (les-cabochons/ajour#786, ADR 0002): edit
 * the title, convert to a draft or mark ready, and merge. REST edits the
 * title and merges; only GraphQL changes the draft state. The manifest puts
 * the REST writes behind "Review pull requests", and Ajour refuses both
 * operations while it's off.
 *
 * A merge happens at most once, and only at the head the user saw. It first
 * reads the pull request: one already merged at that head is the answer to
 * a retry whose first answer was lost, and merges nothing again. Then it
 * merges with GitHub's `sha`, which refuses the merge if a push landed
 * since. When the merge fails, it reads the pull request again, since
 * GitHub may have merged before its answer was lost.
 */

/** What Ajour reads of a pull request. */
interface RestPull {
  node_id: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  title: string;
  head: { sha: string };
  merge_commit_sha: string | null;
}

const MOVED = "The pull request has new commits since you read it. Refresh to review them before merging.";

const pullPath = (request: { repository: string; number: number }) =>
  `/repos/${pathSegments(request.repository)}/pulls/${request.number}`;

const DRAFT_FIELDS = "pullRequest { title isDraft }";
const TO_DRAFT = `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { ${DRAFT_FIELDS} } }`;
const TO_READY = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { ${DRAFT_FIELDS} } }`;

interface DraftAnswer {
  convertPullRequestToDraft?: { pullRequest: { title: string; isDraft: boolean } };
  markPullRequestReadyForReview?: { pullRequest: { title: string; isDraft: boolean } };
}

/** The title, the draft state or both, answered with what GitHub then holds. */
export async function updateGitHubPullRequest(
  client: GitHubClient,
  request: CodeHostUpdatePullRequestRequest,
): Promise<CodeHostUpdatePullRequestResult> {
  const pull =
    request.title !== undefined
      ? await client.rest<RestPull>(pullPath(request), { method: "PATCH", body: { title: request.title } })
      : await client.rest<RestPull>(pullPath(request));
  if (request.draft === undefined || pull.draft === request.draft) {
    return { title: pull.title, draft: pull.draft };
  }
  const answer = await client.query<DraftAnswer>(request.draft ? TO_DRAFT : TO_READY, { id: pull.node_id });
  const changed = (answer.convertPullRequestToDraft ?? answer.markPullRequestReadyForReview)?.pullRequest;
  if (!changed) throw new Error("GitHub didn't say whether the pull request is a draft.");
  return { title: changed.title, draft: changed.isDraft };
}

/**
 * The merge an earlier try made, when the pull request merged at the head
 * the user saw. Throws when it can't merge it: merged at another head,
 * closed, moved on, or a draft.
 */
function mergeableOrEarlier(pull: RestPull, request: CodeHostMergeRequest): CodeHostMergeResult | undefined {
  if (pull.merged) {
    if (pull.head.sha !== request.headSha) {
      throw new Error("This pull request was already merged, with commits you didn't read.");
    }
    return pull.merge_commit_sha ? { mergeCommitSha: pull.merge_commit_sha } : {};
  }
  if (pull.state !== "open") throw new Error("This pull request is closed.");
  if (pull.head.sha !== request.headSha) throw new Error(MOVED);
  if (pull.draft) throw new Error("This pull request is a draft. Mark it ready for review to merge it.");
  return undefined;
}

/** Merges the pull request with `method` at the head the user saw, once. */
export async function mergeGitHubPullRequest(
  client: GitHubClient,
  request: CodeHostMergeRequest,
): Promise<CodeHostMergeResult> {
  const earlier = mergeableOrEarlier(await client.rest<RestPull>(pullPath(request)), request);
  if (earlier) return earlier;
  // A rebase makes no merge commit, so it has no title or message.
  const commit =
    request.method === "rebase"
      ? {}
      : {
          ...(request.commitTitle ? { commit_title: request.commitTitle } : {}),
          ...(request.commitMessage ? { commit_message: request.commitMessage } : {}),
        };
  try {
    const answer = await client.rest<{ sha?: string }>(`${pullPath(request)}/merge`, {
      method: "PUT",
      body: { merge_method: request.method, sha: request.headSha, ...commit },
    });
    return answer.sha ? { mergeCommitSha: answer.sha } : {};
  } catch (error) {
    // GitHub may have merged before its answer was lost.
    const after = await client.rest<RestPull>(pullPath(request)).catch(() => undefined);
    if (after?.merged && after.head.sha === request.headSha) {
      return after.merge_commit_sha ? { mergeCommitSha: after.merge_commit_sha } : {};
    }
    throw error;
  }
}
