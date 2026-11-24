import type { PullRequestConfig } from "./pull-request-config.ts";
import {
  API_VERSION,
  AzureReposClient,
  fetchTracked,
  time,
  type AzureIteration,
  type AzurePullRequest,
} from "./pull-requests.ts";
import type {
  CodeHostPullRequestRef,
  CodeHostVersion,
  CodeHostVersionCommit,
  CodeHostVersionsResult,
} from "./contract.ts";

/*
 * A pull request's versions for Deck's versions bar (les-cabochons/ajour#787):
 * its iterations, each with its head, the common commit it is compared
 * with, when it was pushed and its commits. An iteration keeps its number.
 */

const MAX_VERSIONS = 500;
const MAX_COMMITS = 250;
const MAX_HEADLINE = 1_000;
const MAX_AUTHOR = 240;
/** The reasons Azure DevOps gives for an iteration that rewrote the branch. */
const REWRITES = new Set(["forcepush", "rebase"]);

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function pullRequestPath(pullRequest: AzurePullRequest) {
  const { project, id: repositoryId } = pullRequest.repository;
  return `/${encodeURIComponent(project.id)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequest.pullRequestId}`;
}

/** An iteration's commits, oldest first: Azure DevOps lists them newest first. */
function commitsOf(iteration: AzureIteration): CodeHostVersionCommit[] {
  return (iteration.commits ?? [])
    .flatMap((commit, index) => {
      if (!commit.commitId) return [];
      const createdAt = time(commit.committer?.date) ?? time(commit.author?.date) ?? 0;
      const headline = (commit.comment ?? "").split(/\r?\n/, 1)[0]!.trim();
      return [
        {
          index,
          commit: {
            sha: commit.commitId,
            headline: clip(headline, MAX_HEADLINE),
            authorName: clip(commit.author?.name ?? "", MAX_AUTHOR),
            createdAt,
          },
        },
      ];
    })
    .sort((left, right) => left.commit.createdAt - right.commit.createdAt || right.index - left.index)
    .map((entry) => entry.commit)
    .slice(-MAX_COMMITS);
}

/** The pull request's iterations, oldest first. One without a head commit is left out. */
export async function readVersions(
  config: PullRequestConfig,
  ref: CodeHostPullRequestRef,
): Promise<CodeHostVersionsResult> {
  const client = new AzureReposClient(config.connectionId, config.savedOrganizationUrl);
  const pullRequest = await fetchTracked(client, ref);
  if (!pullRequest) throw new Error("Azure DevOps could not find the pull request.");
  const iterations = (
    await client.get<{ value: AzureIteration[] }>(`${pullRequestPath(pullRequest)}/iterations`, {
      includeCommits: true,
      "api-version": API_VERSION,
    })
  ).value;
  const versions = [...iterations]
    .sort((left, right) => left.id - right.id)
    .flatMap((iteration): CodeHostVersion[] => {
      const headSha = iteration.sourceRefCommit?.commitId;
      if (!headSha || !Number.isInteger(iteration.id) || iteration.id < 1) return [];
      const baseSha = iteration.commonRefCommit?.commitId;
      return [
        {
          number: iteration.id,
          headSha,
          ...(baseSha ? { baseSha } : {}),
          pushedAt: time(iteration.push?.date) ?? time(iteration.createdDate) ?? 0,
          ...(REWRITES.has((iteration.reason ?? "").toLowerCase()) ? { forced: true } : {}),
          commits: commitsOf(iteration),
        },
      ];
    });
  return { versions: versions.slice(-MAX_VERSIONS), versionName: "iteration" };
}
