import type { GitHubConfig } from "./config.js";
import type {
  BacklogReadDescriptionRequest,
  BacklogReadDescriptionResult,
  BacklogWriteDescriptionRequest,
  BacklogWriteDescriptionResult,
} from "./contract.js";
import { bodyFor, bodyLength, describeIssueBody, GITHUB_BODY_MAX_LENGTH } from "./description.js";
import { GitHubClient, splitRepository } from "./github.js";
import { requireIssueRef, type IssueRef } from "./issues.js";

/** The fields of a REST issue a description needs. */
interface RestIssue {
  body?: string | null;
  pull_request?: unknown;
}

function issuePath(ref: IssueRef) {
  const [owner, name] = splitRepository(ref.repository);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${ref.number}`;
}

/**
 * The issue, read through REST, the API the write uses. REST counts every
 * pull request as an issue too; pull requests are not backlog items, so their
 * bodies are neither read nor written.
 */
async function fetchIssueBody(client: GitHubClient, ref: IssueRef) {
  const issue = await client.rest<RestIssue>(issuePath(ref));
  if (issue.pull_request) {
    throw new Error(`${ref.repository}#${ref.number} is a pull request, not an issue. Ajour syncs only issues.`);
  }
  return issue;
}

/**
 * The issue's current description, as a sync sends it. Ajour asks when the
 * user starts editing and again before it saves, to merge with the source.
 */
export async function readIssueDescription(
  config: GitHubConfig,
  request: BacklogReadDescriptionRequest,
): Promise<BacklogReadDescriptionResult> {
  const ref = requireIssueRef(config, request.sourceId);
  const issue = await fetchIssueBody(new GitHubClient(config.apiUrl, config.token), ref);
  return { description: describeIssueBody(issue.body) };
}

/**
 * Writes the user's description, unless the issue's body changed since Ajour
 * read it: the current one, read as a sync reads it, must still be
 * `expected`. GitHub has no conditional update on an issue, so the check reads
 * the issue right before the write, with nothing else in between; a change
 * made during that one round trip is overwritten. GitHub keeps it in the
 * issue's edit history.
 */
export async function writeIssueDescription(
  config: GitHubConfig,
  request: BacklogWriteDescriptionRequest,
): Promise<BacklogWriteDescriptionResult> {
  const ref = requireIssueRef(config, request.sourceId);
  const client = new GitHubClient(config.apiUrl, config.token);
  const issue = await fetchIssueBody(client, ref);
  const current = describeIssueBody(issue.body);
  if (current.text !== request.expected) {
    return { outcome: "conflict", description: current };
  }
  // Lossy text is written only when the user saw each of its losses and saved
  // anyway. Cut text never is.
  const unseen = (current.lost ?? []).filter((loss) => !(request.allowedLoss ?? []).includes(loss));
  if (current.cut || unseen.length > 0) {
    throw new Error(
      current.cut
        ? "This description is longer than Ajour keeps. Edit it in GitHub."
        : `Writing it would lose its ${unseen.join(", ")} in GitHub. Edit it there.`,
    );
  }

  const body = bodyFor(issue.body, request.text);
  const length = bodyLength(body);
  if (length > GITHUB_BODY_MAX_LENGTH) {
    throw new Error(
      `This description is too long for GitHub: ${length.toLocaleString("en-US")} of ${GITHUB_BODY_MAX_LENGTH.toLocaleString("en-US")} characters.`,
    );
  }

  let written: RestIssue;
  try {
    written = await client.rest<RestIssue>(issuePath(ref), { method: "PATCH", body: { body } });
  } catch (error) {
    // A token without write access gets 403, or 404 on a private repository.
    if (error instanceof Error && /\((?:403|404)\)/.test(error.message)) {
      throw new Error(`${error.message} Writing a description needs the token's Issues permission set to Read and write.`);
    }
    throw error;
  }
  return { outcome: "written", description: describeIssueBody(written.body) };
}
