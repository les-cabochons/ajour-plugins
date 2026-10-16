import { parseConnectorFieldValues, type ConnectorFieldValues } from "./contract.js";

/** A project, or one repository of it when `repository` is set. */
export interface PullRequestScope {
  project: string;
  repository?: string;
}

export interface PullRequestConfig {
  /** Organization or collection URL without a trailing slash. */
  organizationUrl: string;
  token: string;
  include: PullRequestScope[];
  exclude: PullRequestScope[];
  hideDrafts: boolean;
  includeTeamRequests: boolean;
}

// Azure DevOps forbids commas and slashes in project and repository names.
const NAME_PATTERN = /^[^,/\\]+$/;

function parseScopes(value: unknown, fieldLabel: string): PullRequestScope[] {
  if (value === undefined || value === "") {
    return [];
  }
  if (typeof value !== "string") {
    throw new Error(`Azure DevOps field "${fieldLabel}" must be text.`);
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
        throw new Error(`"${entry}" in "${fieldLabel}" is not a project or project/repository.`);
      }
      return repository === undefined ? { project } : { project, repository };
    });
}

/**
 * Accepts https://dev.azure.com/org (a project or repository URL under it
 * too), https://org.visualstudio.com, or an Azure DevOps Server collection
 * URL such as https://ado.contoso.com/tfs/DefaultCollection.
 */
export function normalizeOrganizationUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error('Azure DevOps field "Organization URL" is required.');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Azure DevOps field "Organization URL" must be a URL.');
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error('Azure DevOps field "Organization URL" must use HTTP or HTTPS.');
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === "dev.azure.com") {
    if (!segments[0]) {
      throw new Error(
        'Azure DevOps field "Organization URL" must name the organization, such as https://dev.azure.com/your-org.',
      );
    }
    return `${url.origin}/${segments[0]}`;
  }
  if (host.endsWith(".visualstudio.com")) {
    return url.origin;
  }
  return `${url.origin}${segments.length ? `/${segments.join("/")}` : ""}`;
}

function parseBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

/** Pull request settings from the connection's shared and pull request fields. */
export function buildPullRequestConfig(values: ConnectorFieldValues): PullRequestConfig {
  const parsed = parseConnectorFieldValues(values);
  if (typeof parsed.personalAccessToken !== "string" || !parsed.personalAccessToken.trim()) {
    throw new Error('Azure DevOps field "Personal Access Token" is required.');
  }

  return {
    organizationUrl: normalizeOrganizationUrl(parsed.organizationUrl),
    token: parsed.personalAccessToken.trim(),
    include: parseScopes(parsed.pullRequestsInclude, "Only these projects or repositories"),
    exclude: parseScopes(parsed.pullRequestsExclude, "Never these projects or repositories"),
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
