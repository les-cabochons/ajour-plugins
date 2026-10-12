import { buildGitHubConfig } from "./config.js";
import {
  parseConnectorFieldValues,
  type CodeHostSyncRequest,
  type CodeHostSyncResult,
  type ConnectorFieldValues,
  type ConnectorPluginConnection,
  type ConnectorPluginValidationResult,
} from "./contract.js";
import { fetchViewer, GitHubClient, syncPullRequests as syncGitHubPullRequests } from "./github.js";

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
