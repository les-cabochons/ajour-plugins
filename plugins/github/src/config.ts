import { parseConnectorFieldValues, type ConnectorFieldValues } from "./contract.js";

/** An organization or user, or one repository when `repository` is set. */
export interface GitHubScope {
  owner: string;
  repository?: string;
}

export interface GitHubConfig {
  hostUrl: string;
  apiUrl: string;
  token: string;
  include: GitHubScope[];
  exclude: GitHubScope[];
  hideDrafts: boolean;
  includeTeamRequests: boolean;
}

const SCOPE_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/;

function parseScopes(value: unknown, fieldLabel: string): GitHubScope[] {
  if (value === undefined || value === "") {
    return [];
  }
  if (typeof value !== "string") {
    throw new Error(`GitHub field "${fieldLabel}" must be text.`);
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (!SCOPE_PATTERN.test(entry)) {
        throw new Error(
          `"${entry}" in "${fieldLabel}" is not an organization, user or owner/repository.`,
        );
      }
      const [owner, repository] = entry.toLowerCase().split("/");
      return repository ? { owner: owner!, repository } : { owner: owner! };
    });
}

function parseHostUrl(value: unknown) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "https://github.com";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('GitHub field "GitHub URL" must be a URL.');
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error('GitHub field "GitHub URL" must use HTTP or HTTPS.');
  }
  return url.origin;
}

/** GitHub.com serves its API from api.github.com; GitHub Enterprise Server from /api. */
export function graphqlUrlForHost(hostUrl: string) {
  const host = new URL(hostUrl).hostname.toLowerCase();
  return host === "github.com" || host === "www.github.com"
    ? "https://api.github.com/graphql"
    : `${hostUrl}/api/graphql`;
}

function parseBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function buildGitHubConfig(values: ConnectorFieldValues): GitHubConfig {
  const parsed = parseConnectorFieldValues(values);
  if (typeof parsed.token !== "string" || !parsed.token.trim()) {
    throw new Error('GitHub field "Personal access token" is required.');
  }

  const hostUrl = parseHostUrl(parsed.hostUrl);
  return {
    hostUrl,
    apiUrl: graphqlUrlForHost(hostUrl),
    token: parsed.token.trim(),
    include: parseScopes(parsed.include, "Only these organizations or repositories"),
    exclude: parseScopes(parsed.exclude, "Never these organizations or repositories"),
    hideDrafts: parseBoolean(parsed.hideDrafts, false),
    includeTeamRequests: parseBoolean(parsed.includeTeamRequests, true),
  };
}

function matchesScope(repository: string, scope: GitHubScope) {
  const [owner, name] = repository.toLowerCase().split("/");
  return scope.owner === owner && (scope.repository === undefined || scope.repository === name);
}

/** Whether the connection's include and exclude filters keep the repository. */
export function repositoryInScope(config: GitHubConfig, repository: string) {
  if (config.exclude.some((scope) => matchesScope(repository, scope))) {
    return false;
  }
  return config.include.length === 0 || config.include.some((scope) => matchesScope(repository, scope));
}
