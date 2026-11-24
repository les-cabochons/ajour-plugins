import type {} from "@ajour/plugin-sdk/globals";
import { pathSegments, type GitHubClient } from "./github.ts";
import type {
  CodeHostChangedFile,
  CodeHostContentRequest,
  CodeHostContentResult,
  CodeHostFileContentRequest,
  CodeHostFileContentResult,
} from "./contract.ts";

/*
 * What Deck reads to build a pull request's diff: the changed files with
 * their statuses, and each file's text at a commit. Ajour builds the diff
 * itself from both versions of each file, so the patch GitHub sends with
 * the file list is left out.
 */

const FILES_PAGE_SIZE = 100;
/** GitHub lists at most 3,000 files of a pull request, and Ajour reads as many. */
const MAX_FILES = 3_000;
/** The longest path Ajour accepts. A file with a longer path is left out. */
const MAX_PATH_LENGTH = 1_000;
/** The longest text Ajour reads. A longer file is answered as binary: Deck doesn't show its lines. */
const MAX_TEXT_LENGTH = 5_000_000;

interface GitHubPullRequest {
  head: { sha: string };
  base: { sha: string };
}

interface GitHubComparison {
  merge_base_commit?: { sha?: unknown } | null;
}

interface GitHubChangedFile {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch?: string;
}

function changedFile(file: GitHubChangedFile): CodeHostChangedFile {
  // "changed" is a mode change, "unchanged" a file only renamed or copied.
  const status =
    file.status === "changed" || file.status === "unchanged" ? "modified" : file.status;
  return {
    path: file.filename,
    ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
    status,
    additions: file.additions,
    deletions: file.deletions,
    // GitHub sends no patch and counts no line for a binary file. It is a
    // guess: Deck learns it for sure when it reads the file.
    binary:
      file.patch === undefined &&
      file.additions === 0 &&
      file.deletions === 0 &&
      ["added", "removed", "modified"].includes(file.status),
  };
}

const fitsAjour = (file: GitHubChangedFile) =>
  file.filename.length <= MAX_PATH_LENGTH && (file.previous_filename ?? "").length <= MAX_PATH_LENGTH;

/**
 * The pull request's changed files, from the merge base to the head.
 * `base.sha` is the base branch's tip when the pull request last changed,
 * not where the head branched off, so the merge base comes from comparing
 * the two. The second page of a comparison holds only the merge base and no
 * files: its first page would carry every file's patch.
 */
export async function readPullRequestFiles(
  client: GitHubClient,
  request: CodeHostContentRequest,
): Promise<CodeHostContentResult> {
  const repository = pathSegments(request.repository);
  const pull = await client.rest<GitHubPullRequest>(`/repos/${repository}/pulls/${request.number}`);
  const comparison = await client.rest<GitHubComparison>(
    `/repos/${repository}/compare/${pathSegments(`${pull.base.sha}...${pull.head.sha}`)}`,
    { query: { per_page: 1, page: 2 } },
  );
  const mergeBase = comparison.merge_base_commit?.sha;
  // The base branch's tip would show its later commits reverted: no diff is better than a wrong one.
  if (typeof mergeBase !== "string" || !mergeBase) {
    throw new Error("GitHub didn't name where this pull request's branch started.");
  }

  const files: CodeHostChangedFile[] = [];
  for (let page = 1; files.length < MAX_FILES; page += 1) {
    const listed = await client.rest<GitHubChangedFile[]>(`/repos/${repository}/pulls/${request.number}/files`, {
      query: { per_page: FILES_PAGE_SIZE, page },
    });
    files.push(...listed.filter(fitsAjour).slice(0, MAX_FILES - files.length).map(changedFile));
    if (listed.length < FILES_PAGE_SIZE) break;
  }

  return { headSha: pull.head.sha, baseSha: mergeBase, files };
}

/**
 * Whether the broker can request a path: it refuses a segment that holds,
 * once decoded, a `%`, `;`, `\`, a control character, or that is `.` or `..`.
 */
function isRequestable(path: string) {
  return path
    .split("/")
    .every((segment) => segment && !/^[.\s]+$/.test(segment) && !/[%;\\\u0000-\u001f\u007f]/.test(segment));
}

/**
 * A file's text at a commit, or that it is binary or not there. A file Ajour
 * can't read whole, too long or with a name the broker can't request, is
 * answered as binary, so Deck shows the file without its lines.
 */
export async function readFileAtCommit(
  client: GitHubClient,
  request: CodeHostFileContentRequest,
): Promise<CodeHostFileContentResult> {
  if (!isRequestable(request.path)) return { kind: "binary" };
  const file = await client.rawFile(
    `/repos/${pathSegments(request.repository)}/contents/${pathSegments(request.path)}`,
    request.sha,
  );
  if (file.kind === "missing") return { kind: "missing" };
  if (file.kind === "too large") return { kind: "binary" };
  // Git calls a file binary when it holds a NUL byte, which UTF-8 decodes to U+0000.
  if (file.text.includes("\u0000") || file.text.length > MAX_TEXT_LENGTH) return { kind: "binary" };
  return { kind: "text", content: file.text };
}
