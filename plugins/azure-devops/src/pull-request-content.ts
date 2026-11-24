import type { PullRequestConfig } from "./pull-request-config.ts";
import {
  API_VERSION,
  AzureReposClient,
  fetchTracked,
  type AzureIteration,
  type AzurePullRequest,
} from "./pull-requests.ts";
import type {
  CodeHostChangedFile,
  CodeHostContentRequest,
  CodeHostContentResult,
  CodeHostFileContentRequest,
  CodeHostFileContentResult,
} from "./contract.ts";

/*
 * What Deck reads to build a pull request's diff (les-cabochons/ajour#780):
 * the changed files with their statuses, and each file's text at a commit.
 * Ajour builds the diff itself from both versions of each file, with Review
 * Deck's `buildDiff`, so the files are the ones Review Deck lists for the
 * same comparison: the latest iteration against the pull request's base.
 */

/** Azure DevOps lists at most 2,000 changes a page. */
const CHANGES_PAGE_SIZE = 2_000;
/** The most files Ajour reads of a pull request. */
const MAX_FILES = 3_000;
/** The longest path Ajour accepts. A file with a longer path is left out. */
const MAX_PATH_LENGTH = 1_000;
/** The longest text Ajour reads. A longer file is answered as binary: Deck doesn't show its lines. */
const MAX_TEXT_LENGTH = 5_000_000;

/** A change of an iteration. `changeType` is a list of flags, such as "edit, rename". */
interface AzureChange {
  changeType?: string;
  item?: { path?: string; isFolder?: boolean; gitObjectType?: string };
  originalPath?: string;
}

interface AzureIterationChanges {
  changeEntries?: AzureChange[];
  nextSkip?: number;
}

const withoutSlash = (path: string) => path.replace(/^\//, "");

/**
 * Whether the change is a file Deck can read. A folder has no content, and
 * neither has a submodule, whose entry names a commit of another repository:
 * reading either at a commit would fail the whole pull request's open.
 */
function isFile(change: AzureChange) {
  const item = change.item;
  return !!item?.path && !item.isFolder && item.gitObjectType !== "tree" && item.gitObjectType !== "commit";
}

/** Whether Ajour accepts the change's paths: a file with a longer path is left out. */
function fitsAjour(change: AzureChange) {
  const path = withoutSlash(change.item!.path!);
  return path.length > 0 && path.length <= MAX_PATH_LENGTH && withoutSlash(change.originalPath ?? "").length <= MAX_PATH_LENGTH;
}

/**
 * A change as a changed file. The status follows Review Deck's order: an
 * addition or a deletion first, then a rename, and anything else is an edit.
 * Azure DevOps counts no lines and doesn't say a file is binary: Deck learns
 * that when it reads the file.
 */
function changedFile(change: AzureChange): CodeHostChangedFile {
  const flags = new Set((change.changeType ?? "").split(",").map((flag) => flag.trim().toLowerCase()));
  const previousPath = change.originalPath ? withoutSlash(change.originalPath) : undefined;
  const status = flags.has("add")
    ? "added"
    : flags.has("delete")
      ? "removed"
      : flags.has("rename") && previousPath
        ? "renamed"
        : "modified";
  return {
    path: withoutSlash(change.item!.path!),
    ...(status === "renamed" ? { previousPath } : {}),
    status,
    additions: 0,
    deletions: 0,
    binary: false,
  };
}

/** The pull request's address under its project and repository, by id. */
function pullRequestPath(pullRequest: AzurePullRequest) {
  const { project, id: repositoryId } = pullRequest.repository;
  return `/${encodeURIComponent(project.id)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequest.pullRequestId}`;
}

/**
 * The pull request's changed files, from the latest iteration's common
 * commit to its head. That is the comparison Review Deck shows and publishes
 * guides for: iteration N against 0, the pull request's base. An iteration
 * never changes once pushed, so a push while the files are listed can't mix
 * two heads. The common commit is where the iteration's head and the target
 * branch met when it was pushed, Azure DevOps's own merge base, kept with
 * the iteration: a later commit on the target branch doesn't move it.
 */
export async function readPullRequestFiles(
  config: PullRequestConfig,
  request: CodeHostContentRequest,
): Promise<CodeHostContentResult> {
  const client = new AzureReposClient(config.connectionId, config.savedOrganizationUrl);
  // A pull request's id is unique in the organization or collection.
  const pullRequest = await fetchTracked(client, request);
  if (!pullRequest) throw new Error("Azure DevOps could not find the pull request.");
  const base = pullRequestPath(pullRequest);
  const iterations = (
    await client.get<{ value: AzureIteration[] }>(`${base}/iterations`, { "api-version": API_VERSION })
  ).value;
  const latest = iterations.reduce<AzureIteration | undefined>(
    (found, iteration) => (!found || iteration.id > found.id ? iteration : found),
    undefined,
  );
  const headSha = latest?.sourceRefCommit?.commitId;
  const baseSha = latest?.commonRefCommit?.commitId;
  // Any other commit would show changes the pull request doesn't make: no diff is better than a wrong one.
  if (!latest || !headSha || !baseSha) {
    throw new Error("Azure DevOps didn't name the commits of this pull request's latest iteration.");
  }

  const files: CodeHostChangedFile[] = [];
  for (let skip = 0; ; ) {
    const page = await client.get<AzureIterationChanges>(`${base}/iterations/${latest.id}/changes`, {
      $compareTo: 0,
      $top: CHANGES_PAGE_SIZE,
      $skip: skip,
      "api-version": API_VERSION,
    });
    files.push(...(page.changeEntries ?? []).filter(isFile).filter(fitsAjour).map(changedFile));
    // Part of a pull request would read as the whole of it, so a larger one fails.
    if (files.length > MAX_FILES) {
      throw new Error("This pull request changes more than 3,000 files, more than Deck reads.");
    }
    if (!page.nextSkip || page.nextSkip <= skip) break;
    skip = page.nextSkip;
  }

  return { headSha, baseSha, files };
}

/** "project/repository" as its two names. */
function splitRepository(repository: string): [project: string, name: string] {
  const slash = repository.indexOf("/");
  const project = repository.slice(0, slash);
  const name = repository.slice(slash + 1);
  if (slash <= 0 || !name || name.includes("/")) {
    throw new Error(`Azure DevOps names a repository "project/repository", not "${repository}".`);
  }
  return [project, name];
}

/**
 * A file's text at a commit, or that it is binary or not there. The path
 * goes in the query, so any name the repository holds can be read. A file
 * Ajour can't read whole, with a NUL byte, too long, or over the broker's
 * answer limit, is answered as binary, so Deck shows it without its lines.
 * Git LFS files are read as their pointers, as Review Deck reads them.
 */
export async function readFileAtCommit(
  config: PullRequestConfig,
  request: CodeHostFileContentRequest,
): Promise<CodeHostFileContentResult> {
  const [project, name] = splitRepository(request.repository);
  const client = new AzureReposClient(config.connectionId, config.savedOrganizationUrl);
  const file = await client.rawFile(
    `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(name)}/items`,
    {
      path: `/${request.path}`,
      "versionDescriptor.version": request.sha,
      "versionDescriptor.versionType": "commit",
      "api-version": API_VERSION,
    },
  );
  if (file.kind === "missing") return { kind: "missing" };
  if (file.kind === "too large") return { kind: "binary" };
  // Git calls a file binary when it holds a NUL byte, which UTF-8 decodes to U+0000.
  if (file.text.includes("\u0000") || file.text.length > MAX_TEXT_LENGTH) return { kind: "binary" };
  return { kind: "text", content: file.text };
}
