import type {} from "@ajour/plugin-sdk/globals";
import type { PluginModule } from "@ajour/plugin-sdk";
import { buildGitHubConfig } from "./config.ts";
import { readIssueDescription, writeIssueDescription } from "./description-source.ts";
import { fetchViewer, GitHubClient, syncPullRequests as syncGitHubPullRequests } from "./github.ts";
import { listIssueSettleStates, syncIssues, writeIssueSettle } from "./issues.ts";
import { readFileAtCommit, readPullRequestFiles } from "./pull-request-content.ts";
import { readChecks, readConversation } from "./pull-request-review.ts";
import { readVersions } from "./pull-request-versions.ts";
import {
  postPullRequestComment,
  replyToPullRequestThread,
  setPullRequestFileViewed,
  setPullRequestThreadResolved,
  submitPullRequestReview,
} from "./pull-request-writes.ts";

/*
 * The plugin's entrypoint, loaded as an ES module in Ajour's sandboxed worker
 * (plugin API 4). Each export is one operation. The connection an operation
 * receives holds no token: it stays with Ajour's broker, which attaches it as a
 * bearer credential to every `ajour.http` request.
 */

/** Both issues and pull requests need only a token GitHub accepts. */
export const validateConnection: NonNullable<PluginModule["validateConnection"]> = async (connection) => {
  const config = buildGitHubConfig(connection);
  const viewer = await fetchViewer(new GitHubClient(config.connectionId));

  return {
    normalizedConfig: {
      ...connection.config,
      hostUrl: config.hostUrl,
      include: config.include
        .map((scope) => (scope.repository ? `${scope.owner}/${scope.repository}` : scope.owner))
        .join(", "),
      exclude: config.exclude
        .map((scope) => (scope.repository ? `${scope.owner}/${scope.repository}` : scope.owner))
        .join(", "),
      hideDrafts: config.hideDrafts,
      includeTeamRequests: config.includeTeamRequests,
    },
    connectionSummary: {
      account: viewer.login,
      host: new URL(config.hostUrl).host,
    },
  };
};

export const syncPullRequests: NonNullable<PluginModule["syncPullRequests"]> = async (connection, request) =>
  await syncGitHubPullRequests(buildGitHubConfig(connection), request.tracked);

/** A pull request's changed files and their statuses, for Deck to build its diff. */
export const getPullRequestContent: NonNullable<PluginModule["getPullRequestContent"]> = async (connection, request) =>
  await readPullRequestFiles(new GitHubClient(connection.id), request);

/** One file's text at a commit, for Deck to build a pull request's diff. */
export const getFileContent: NonNullable<PluginModule["getFileContent"]> = async (connection, request) =>
  await readFileAtCommit(new GitHubClient(connection.id), request);

/** The description, timeline, review threads and viewed files, for Deck's review page. */
export const getPullRequestConversation: NonNullable<PluginModule["getPullRequestConversation"]> = async (
  connection,
  request,
) => await readConversation(new GitHubClient(connection.id), request);

/** The checks on the pull request's head, for Deck's status line. */
export const getChecks: NonNullable<PluginModule["getChecks"]> = async (connection, request) =>
  await readChecks(new GitHubClient(connection.id), request);

/** A review with its verdict and line comments, sent at once from Deck's Finish review. */
export const submitReview: NonNullable<PluginModule["submitReview"]> = async (connection, request) =>
  await submitPullRequestReview(new GitHubClient(connection.id), request);

/** One comment, on lines or on the conversation, sent at once from Deck's Comment now. */
export const postComment: NonNullable<PluginModule["postComment"]> = async (connection, request) =>
  await postPullRequestComment(new GitHubClient(connection.id), request);

/** A reply at the end of a review thread, sent at once from Deck. */
export const replyToThread: NonNullable<PluginModule["replyToThread"]> = async (connection, request) =>
  await replyToPullRequestThread(new GitHubClient(connection.id), request);

/** Resolves or unresolves a review thread from Deck. */
export const setThreadResolved: NonNullable<PluginModule["setThreadResolved"]> = async (connection, request) =>
  await setPullRequestThreadResolved(new GitHubClient(connection.id), request);

/** Marks a file viewed, or not, on GitHub, as the user marks it in Deck. */
export const setFileViewed: NonNullable<PluginModule["setFileViewed"]> = async (connection, request) =>
  await setPullRequestFileViewed(new GitHubClient(connection.id), request);

/** Each push with its commits, from the timeline, for Deck's versions bar. */
export const getPullRequestVersions: NonNullable<PluginModule["getPullRequestVersions"]> = async (connection, request) =>
  await readVersions(new GitHubClient(connection.id), request);

/** Issues assigned to you, as backlog items. */
export const syncConnection: NonNullable<PluginModule["syncConnection"]> = async (connection, workItems = []) =>
  await syncIssues(buildGitHubConfig(connection), connection, workItems);

export const listSettleStates: NonNullable<PluginModule["listSettleStates"]> = async (connection, request) =>
  await listIssueSettleStates(buildGitHubConfig(connection), request.sourceId);

export const writeSettle: NonNullable<PluginModule["writeSettle"]> = async (connection, request) =>
  await writeIssueSettle(buildGitHubConfig(connection), request);

/** The issue's current body, read when the user edits its description in Ajour. */
export const readDescription: NonNullable<PluginModule["readDescription"]> = async (connection, request) =>
  await readIssueDescription(buildGitHubConfig(connection), request);

/** Writes the user's edit, unless the issue's body changed since it was read. */
export const writeDescription: NonNullable<PluginModule["writeDescription"]> = async (connection, request) =>
  await writeIssueDescription(buildGitHubConfig(connection), request);
