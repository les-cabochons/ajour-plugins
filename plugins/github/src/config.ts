import { parseConnectorFieldValues, type ConnectorFieldValues } from "./contract.ts";

/** An organization or user, or one repository when `repository` is set. */
export interface GitHubScope {
  owner: string;
  repository?: string;
}

export interface GitHubConfig {
  /** The connection `ajour.http` sends through. */
  connectionId: string;
  /** The GitHub URL the user saved, as an origin: what an issue's or pull request's address starts with. */
  hostUrl: string;
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
  if (url.hostname.toLowerCase() === "www.github.com") {
    // Ajour derives api.github.com from github.com alone.
    throw new Error('GitHub field "GitHub URL" for GitHub.com is https://github.com, without www.');
  }
  return url.origin;
}

function parseBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * The settings of a connection Ajour hands to an operation. They hold no token:
 * that stays with Ajour's broker, which attaches it to each request.
 */
export function buildGitHubConfig(connection: { id: string; config: ConnectorFieldValues }): GitHubConfig {
  const parsed = parseConnectorFieldValues(connection.config);
  return {
    connectionId: connection.id,
    hostUrl: parseHostUrl(parsed.hostUrl),
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
