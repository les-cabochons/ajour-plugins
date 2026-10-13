// Ajour plugin API version 2, code host capability. These types mirror
// packages/shared/src/code-host.ts in les-cabochons/ajour. Times are Unix
// milliseconds and a repository is its full name, such as "acme/api".

export type ConnectorFieldValue = string | number | boolean;
export type ConnectorFieldValues = Record<string, ConnectorFieldValue>;

export function parseConnectorFieldValues(value: unknown): ConnectorFieldValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connector field values must be an object.");
  }

  const entries = Object.entries(value);
  if (
    entries.some(
      ([, fieldValue]) =>
        typeof fieldValue !== "string" &&
        typeof fieldValue !== "number" &&
        typeof fieldValue !== "boolean",
    )
  ) {
    throw new Error("Connector field values must contain only primitive values.");
  }

  return Object.fromEntries(entries) as ConnectorFieldValues;
}

export interface ConnectorPluginConnection {
  id: string;
  pluginId: string;
  label: string;
  tenantLabel: string;
  autoSync: boolean;
  autoSyncIntervalMinutes: number;
  connectedAt: number;
  lastSyncAt?: number;
  lastError?: string;
  config: ConnectorFieldValues;
}

export interface ConnectorPluginValidationResult {
  normalizedConfig: ConnectorFieldValues;
  connectionSummary: Record<string, string | number | boolean>;
}

export interface CodeHostUser {
  login: string;
  displayName?: string;
  isBot: boolean;
  avatarUrl?: string;
}

export type CodeHostReviewVerdict =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed";

export interface CodeHostReviewRequest {
  kind: "user" | "team";
  name: string;
  includesViewer: boolean;
}

export interface CodeHostReviewFact {
  id: string;
  author: CodeHostUser;
  verdict: CodeHostReviewVerdict;
  submittedAt: number;
}

export interface CodeHostCommentFact {
  id: string;
  author: CodeHostUser;
  createdAt: number;
  threadId?: string;
  mentionsViewer: boolean;
}

export interface CodeHostPullRequestRef {
  repository: string;
  number: number;
}

export interface CodeHostPullRequestFacts extends CodeHostPullRequestRef {
  id: string;
  url: string;
  title: string;
  author: CodeHostUser;
  state: "open" | "merged" | "closed";
  draft: boolean;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  viewerIsAuthor: boolean;
  headSha: string;
  lastPushedAt: number;
  reviewRequests: CodeHostReviewRequest[];
  reviews: CodeHostReviewFact[];
  comments: CodeHostCommentFact[];
  checks: "none" | "pending" | "success" | "failure";
  mergeability: "mergeable" | "conflicting" | "unknown";
}

export interface CodeHostSyncRequest {
  tracked: CodeHostPullRequestRef[];
}

export interface CodeHostSyncResult {
  viewer: CodeHostUser;
  instanceUrl?: string;
  pullRequests: CodeHostPullRequestFacts[];
}
