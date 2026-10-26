import { parseConnectorFieldValues, type ConnectorFieldValues } from "./contract.ts";

/** A project, or one repository of it when `repository` is set. */
export interface PullRequestScope {
  project: string;
  repository?: string;
}

export interface PullRequestConfig {
  /** The connection `ajour.http` sends through. */
  connectionId: string;
  /** Organization or collection URL without a trailing slash, for web links. */
  organizationUrl: string;
  include: PullRequestScope[];
  exclude: PullRequestScope[];
  hideDrafts: boolean;
  includeTeamRequests: boolean;
}

// Azure DevOps forbids commas and slashes in project and repository names.
const NAME_PATTERN = /^[^,/\\]+$/;

function parseScopes(value: unknown, fieldId: string): PullRequestScope[] {
  if (value === undefined || value === "") {
    return [];
  }
  if (typeof value !== "string") {
    throw new Error(`Azure DevOps field "${fieldId}" must be text.`);
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [project = "", repository, ...rest] = entry.split("/").map((part) => part.trim());
      if (
        rest.length > 0 ||
        !NAME_PATTERN.test(project) ||
        (repository !== undefined && !NAME_PATTERN.test(repository))
      ) {
        throw new Error(`"${entry}" in Azure DevOps field "${fieldId}" is not a project or project/repository.`);
      }
      return repository === undefined ? { project } : { project, repository };
    });
}

/**
 * The organization or collection that every call starts from: the
 * Organization URL as saved, without a trailing slash. Ajour's broker builds
 * each request's address from the saved URL and never climbs above its path,
 * so the URL must name the organization itself: https://dev.azure.com/org,
 * https://org.visualstudio.com, or an Azure DevOps Server collection such as
 * https://ado.contoso.com/tfs/DefaultCollection. A project's or repository's
 * URL under dev.azure.com or visualstudio.com is refused, with what to enter.
 */
export function organizationRootUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error('Azure DevOps field "organizationUrl" is required.');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Azure DevOps field "organizationUrl" must be a URL.');
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error('Azure DevOps field "organizationUrl" must use HTTP or HTTPS.');
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === "dev.azure.com") {
    if (!segments[0]) {
      throw new Error(
        'Azure DevOps field "organizationUrl" must name the organization, such as https://dev.azure.com/your-org.',
      );
    }
    if (segments.length > 1) {
      throw new Error(
        `Azure DevOps field "organizationUrl" must be the organization's URL, ${url.origin}/${segments[0]}, not a project's.`,
      );
    }
  } else if (
    host.endsWith(".visualstudio.com") &&
    (segments.length > 1 || (segments[0] !== undefined && segments[0].toLowerCase() !== "defaultcollection"))
  ) {
    throw new Error(
      `Azure DevOps field "organizationUrl" must be the organization's URL, ${url.origin}, not a project's.`,
    );
  }
  return `${url.origin}${segments.length ? `/${segments.join("/")}` : ""}`;
}

function parseBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Pull request settings from the connection's shared and pull request fields.
 * They hold no token: Ajour's broker keeps it and attaches it to each request.
 */
export function buildPullRequestConfig(connection: {
  id: string;
  config: ConnectorFieldValues;
}): PullRequestConfig {
  const parsed = parseConnectorFieldValues(connection.config);

  return {
    connectionId: connection.id,
    organizationUrl: organizationRootUrl(parsed.organizationUrl),
    include: parseScopes(parsed.pullRequestsInclude, "pullRequestsInclude"),
    exclude: parseScopes(parsed.pullRequestsExclude, "pullRequestsExclude"),
    hideDrafts: parseBoolean(parsed.hideDraftPullRequests, false),
    includeTeamRequests: parseBoolean(parsed.includeTeamReviewRequests, true),
  };
}

export function formatScopes(scopes: PullRequestScope[]) {
  return scopes
    .map((scope) => (scope.repository ? `${scope.project}/${scope.repository}` : scope.project))
    .join(", ");
}

function matchesScope(project: string, repository: string, scope: PullRequestScope) {
  return (
    scope.project.toLowerCase() === project.toLowerCase() &&
    (scope.repository === undefined || scope.repository.toLowerCase() === repository.toLowerCase())
  );
}

/** Whether the connection's include and exclude filters keep the repository. */
export function repositoryInScope(config: PullRequestConfig, project: string, repository: string) {
  if (config.exclude.some((scope) => matchesScope(project, repository, scope))) {
    return false;
  }
  return (
    config.include.length === 0 ||
    config.include.some((scope) => matchesScope(project, repository, scope))
  );
}
