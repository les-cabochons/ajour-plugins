export type AzureDevOpsQueryScope =
  | "assigned_to_me"
  | "project_open_tasks";

/** Ajour's priority levels. A source value that maps to no level has no priority. */
export type ConnectorPriorityLevel = "urgent" | "high" | "medium" | "low";

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

/**
 * The second argument of `validateConnection`: the capabilities that are on.
 * Ajour before per-capability switches sends none.
 */
export interface ConnectorValidationContext {
  capabilities: ("connector" | "codeHost")[];
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

export interface ConnectorImportCandidateInput {
  source: string;
  connectionId: string;
  connectionLabel: string;
  tenantLabel: string;
  sourceId: string;
  externalId: string;
  sourceUrl?: string;
  title: string;
  note?: string;
  projectName?: string;
  workItemType: string;
  state?: string;
  /** The state's category for people, such as "In Progress". */
  stateCategory?: string;
  /** True for Completed and Removed. Ajour archives done items. */
  stateDone?: boolean;
  assignedTo?: string;
  priority?: ConnectorPriorityLevel;
  originalEstimateHours?: number;
  remainingEstimateHours?: number;
  completedEstimateHours?: number;
  parentSourceId?: string;
  parentTitle?: string;
  depth: 0 | 1;
  selectable: boolean;
  selected?: boolean;
  childCount: number;
  pushedAt?: number;
}

export interface ConnectorSyncEstimateFieldState {
  baselineValue?: number;
  remoteValue?: number;
  resolution?: "keep_local";
}

export interface ConnectorSyncWorkItem {
  localWorkItemId: string;
  sourceId: string;
  originalEstimateHours?: number;
  remainingEstimateHours?: number;
  completedEstimateHours?: number;
  estimateSync?: {
    originalEstimateHours?: ConnectorSyncEstimateFieldState;
    remainingEstimateHours?: ConnectorSyncEstimateFieldState;
    completedEstimateHours?: ConnectorSyncEstimateFieldState;
  };
}

export interface ConnectorSyncFieldUpdate {
  status: "noop" | "pushed" | "pulled" | "conflict" | "error";
  localValue?: number;
  remoteValue?: number;
  baselineValue?: number;
  nextBaselineValue?: number;
  message?: string;
}

export interface ConnectorSyncWorkItemUpdate {
  localWorkItemId: string;
  sourceId: string;
  fields: {
    originalEstimateHours?: ConnectorSyncFieldUpdate;
    remainingEstimateHours?: ConnectorSyncFieldUpdate;
    completedEstimateHours?: ConnectorSyncFieldUpdate;
  };
}

/** A state a backlog item can move to when it is settled. */
export interface ConnectorSettleState {
  name: string;
  category: string;
  done: boolean;
}

export interface ConnectorSettleStatesRequest {
  sourceId: string;
}

export interface ConnectorSettleStatesResult {
  states: ConnectorSettleState[];
}

/** Only the fields the settle changed. */
export interface ConnectorSettleWriteRequest {
  sourceId: string;
  state?: string;
  priority?: ConnectorPriorityLevel;
}

/** The item's values in Azure DevOps after the write. */
export interface ConnectorSettleWriteResult {
  state?: string;
  stateCategory?: string;
  stateDone?: boolean;
  priority?: ConnectorPriorityLevel;
}

export interface ConnectorPluginSyncResult {
  items: ConnectorImportCandidateInput[];
  workItemUpdates?: ConnectorSyncWorkItemUpdate[];
}

// Code host capability. These types mirror packages/shared/code-host.ts in
// les-cabochons/ajour. Times are Unix milliseconds and a repository is
// "project/repository", such as "Fabrikam/api".

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

export interface CodeHostReviewRequestEvent {
  id: string;
  author: CodeHostUser;
  createdAt: number;
  includesViewer: boolean;
}

export interface CodeHostReviewFact {
  id: string;
  author: CodeHostUser;
  verdict: CodeHostReviewVerdict;
  submittedAt: number;
  mentionsViewer?: boolean;
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
  lastPushActor?: CodeHostUser;
  reviewRequests: CodeHostReviewRequest[];
  reviewRequestEvents?: CodeHostReviewRequestEvent[];
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

export type BacklogReaction =
  | "like"
  | "dislike"
  | "heart"
  | "hooray"
  | "laugh"
  | "confused"
  | "rocket"
  | "eyes";

/** A person in Azure DevOps, by identity id, the id comment authors carry. */
export interface BacklogPerson {
  id: string;
  displayName: string;
}

export interface BacklogListItemCommentsRequest {
  sourceId: string;
  /** 1 to 50. */
  limit: number;
  /** An `earlierCursor` returned before. */
  cursor?: string;
}

export interface BacklogComment {
  id: string;
  author: BacklogPerson;
  /** Markdown. Mentions are `[@Name](mention:<id>)`. */
  body: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, when the comment changed after it was posted. */
  updatedAt?: string;
  reactions?: {
    reaction: BacklogReaction;
    count: number;
    viewerReacted: boolean;
  }[];
  restrictedTo?: string;
}

export interface BacklogListItemCommentsResult {
  viewer: BacklogPerson;
  /** Oldest first, at most 50. */
  comments: BacklogComment[];
  total?: number;
  /** Set while earlier comments remain. */
  earlierCursor?: string;
}
