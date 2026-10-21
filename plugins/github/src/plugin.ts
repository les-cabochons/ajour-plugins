import { buildGitHubConfig } from "./config.js";
import {
  parseConnectorFieldValues,
  type BacklogReadDescriptionRequest,
  type BacklogReadDescriptionResult,
  type BacklogWriteDescriptionRequest,
  type BacklogWriteDescriptionResult,
  type CodeHostSyncRequest,
  type CodeHostSyncResult,
  type ConnectorFieldValues,
  type ConnectorPluginConnection,
  type ConnectorPluginSyncResult,
  type ConnectorPluginValidationResult,
  type ConnectorSettleStatesRequest,
  type ConnectorSettleStatesResult,
  type ConnectorSettleWriteRequest,
  type ConnectorSettleWriteResult,
  type ConnectorSyncWorkItem,
} from "./contract.js";
import { readIssueDescription, writeIssueDescription } from "./description-source.js";
import { fetchViewer, GitHubClient, syncPullRequests as syncGitHubPullRequests } from "./github.js";
import { listIssueSettleStates, syncIssues, writeIssueSettle } from "./issues.js";

/** Both issues and pull requests need only a token GitHub accepts. */
export async function validateConnection(
  values: ConnectorFieldValues,
): Promise<ConnectorPluginValidationResult> {
  const parsed = parseConnectorFieldValues(values);
  const config = buildGitHubConfig(parsed);
  const viewer = await fetchViewer(new GitHubClient(config.apiUrl, config.token));

  return {
    normalizedConfig: {
      ...parsed,
      hostUrl: config.hostUrl,
      token: config.token,
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
}

export async function syncPullRequests(
  connection: ConnectorPluginConnection,
  request: CodeHostSyncRequest,
): Promise<CodeHostSyncResult> {
  return await syncGitHubPullRequests(buildGitHubConfig(connection.config), request.tracked);
}

/** Issues assigned to you, as backlog items. */
export async function syncConnection(
  connection: ConnectorPluginConnection,
  workItems: ConnectorSyncWorkItem[] = [],
): Promise<ConnectorPluginSyncResult> {
  return await syncIssues(buildGitHubConfig(connection.config), connection, workItems);
}

export async function listSettleStates(
  connection: ConnectorPluginConnection,
  request: ConnectorSettleStatesRequest,
): Promise<ConnectorSettleStatesResult> {
  return await listIssueSettleStates(buildGitHubConfig(connection.config), request.sourceId);
}

export async function writeSettle(
  connection: ConnectorPluginConnection,
  request: ConnectorSettleWriteRequest,
): Promise<ConnectorSettleWriteResult> {
  return await writeIssueSettle(buildGitHubConfig(connection.config), request);
}

/** The issue's current body, read when the user edits its description in Ajour. */
export async function readDescription(
  connection: ConnectorPluginConnection,
  request: BacklogReadDescriptionRequest,
): Promise<BacklogReadDescriptionResult> {
  return await readIssueDescription(buildGitHubConfig(connection.config), request);
}

/** Writes the user's edit, unless the issue's body changed since it was read. */
export async function writeDescription(
  connection: ConnectorPluginConnection,
  request: BacklogWriteDescriptionRequest,
): Promise<BacklogWriteDescriptionResult> {
  return await writeIssueDescription(buildGitHubConfig(connection.config), request);
}
