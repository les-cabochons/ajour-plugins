import type {} from "@ajour/plugin-sdk/globals";
import type { PluginModule } from "@ajour/plugin-sdk";
import { buildGitHubConfig } from "./config.ts";
import { readIssueDescription, writeIssueDescription } from "./description-source.ts";
import { fetchViewer, GitHubClient, syncPullRequests as syncGitHubPullRequests } from "./github.ts";
import { listIssueSettleStates, syncIssues, writeIssueSettle } from "./issues.ts";
import { readFileAtCommit, readPullRequestFiles } from "./pull-request-content.ts";
import { readChecks, readConversation, readLinkedTickets } from "./pull-request-review.ts";

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

/** The issues the pull request closes or is linked to, for the summary Deck shows above its guide. */
export const getLinkedTickets: NonNullable<PluginModule["getLinkedTickets"]> = async (connection, request) =>
  await readLinkedTickets(new GitHubClient(connection.id), request);

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
