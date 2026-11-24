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

/** A synced description, as the plugin converted it from Azure DevOps. */
export interface ConnectorSyncedDescription {
  /** Markdown, up to 64,000 characters. Mentions are `[@Name](mention:<id>)`. */
  text: string;
  /** What the conversion to Markdown dropped, such as "text colour". */
  lost?: string[];
  /** The source's text was longer, and it was cut. */
  cut?: boolean;
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
  /** The description cut to 4,000 characters, for Ajour before descriptions synced. */
  note?: string;
  /** The full description, synced both ways. */
  description?: ConnectorSyncedDescription;
  projectName?: string;
  workItemType: string;
  state?: string;
  /** The state's category for people, such as "In Progress". */
  stateCategory?: string;
  /** True for Completed and Removed. Ajour archives done items. */
  stateDone?: boolean;
  /** The assignee's name, for Ajour's review line and older Ajour. */
  assignedTo?: string;
  /**
   * Who the item is assigned to, by uniqueName, with each text at most 400
   * characters. Absent when unassigned.
   */
  assignee?: BacklogPerson;
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
  /** Set on settled items: report the comments posted after it (ISO 8601). */
  commentsSince?: string;
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

/**
 * The item types Ajour's connection form asks about: those of the
 * connection's synced items, each with one of its items, then the types the
 * saved fields by type name, without one.
 */
export interface ConnectorItemTypesRequest {
  types: { name: string; sourceId?: string }[];
}

/** One work item type: its icon, its fields, and the fields to propose for each estimate field, best first. */
export interface ConnectorItemType {
  name: string;
  iconSvg?: string;
  fields?: { name: string; id?: string }[];
  suggestions?: Record<string, string[]>;
}

export interface ConnectorItemTypesResult {
  types: ConnectorItemType[];
}

/** Only the fields the settle changed. */
export interface ConnectorSettleWriteRequest {
  sourceId: string;
  state?: string;
  priority?: ConnectorPriorityLevel;
  /** A uniqueName, the id `searchAssignees` returns, assigns; null unassigns. */
  assignee?: string | null;
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
  /** The user, in the id space of comment authors. Needed with `commentFacts`. */
  viewer?: BacklogPerson;
  /** New comments on the settled items, so someone else's comment returns one. */
  commentFacts?: BacklogItemCommentFacts[];
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
  /** The branch the pull request merges into, such as `main`. */
  baseRef?: string;
  lastPushedAt: number;
  lastPushActor?: CodeHostUser;
  reviewRequests: CodeHostReviewRequest[];
  reviewRequestEvents?: CodeHostReviewRequestEvent[];
  reviews: CodeHostReviewFact[];
  comments: CodeHostCommentFact[];
  checks: "none" | "pending" | "success" | "failure";
  mergeability: "mergeable" | "conflicting" | "unknown";
  /** Each reviewer's current vote, one per reviewer, at most 100. */
  approvals?: CodeHostApproval[];
}

export interface CodeHostSyncRequest {
  tracked: CodeHostPullRequestRef[];
}

export interface CodeHostSyncResult {
  viewer: CodeHostUser;
  instanceUrl?: string;
  pullRequests: CodeHostPullRequestFacts[];
}

/** A changed file. Deck reads only its path, previous path and status. */
export interface CodeHostChangedFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied";
  additions: number;
  deletions: number;
  /** Unified diff hunks. Ajour builds its own diff, so the plugin leaves it out. */
  patch?: string;
  binary: boolean;
}

export type CodeHostContentRequest = CodeHostPullRequestRef;

export interface CodeHostContentResult {
  headSha: string;
  /** The commit the diff starts from: the latest iteration's common commit. */
  baseSha: string;
  /** At most 3,000. */
  files: CodeHostChangedFile[];
}

export interface CodeHostFileContentRequest {
  repository: string;
  sha: string;
  path: string;
}

/** A text file's content is at most 5,000,000 characters. */
export type CodeHostFileContentResult =
  | { kind: "text"; content: string }
  | { kind: "binary" }
  | { kind: "missing" };

/** One reviewer's current vote. `rejected` is Azure DevOps's Reject; `none` is asked, with no vote yet. */
export type CodeHostApprovalVote = "approved" | "changes_requested" | "rejected" | "none";

export interface CodeHostApproval {
  /** A person, or a team or group asked to review. */
  reviewer: CodeHostUser;
  vote: CodeHostApprovalVote;
  /** The code host's policy requires this reviewer's approval. */
  required?: boolean;
}

export type CodeHostDiffSide = "base" | "head";

export interface CodeHostThreadComment {
  id: string;
  author: CodeHostUser;
  /** Markdown, at most 65,536 characters. */
  body: string;
  createdAt: number;
  updatedAt?: number;
}

export interface CodeHostReviewThread {
  id: string;
  path: string;
  side: CodeHostDiffSide;
  /** Absent when the thread no longer maps to a line of the latest diff. */
  line?: number;
  startLine?: number;
  resolved: boolean;
  outdated: boolean;
  /** 1 to 500. */
  comments: CodeHostThreadComment[];
}

export type CodeHostTimelineEvent =
  | { kind: "comment"; id: string; author: CodeHostUser; body: string; createdAt: number }
  | {
      kind: "review";
      id: string;
      author: CodeHostUser;
      verdict: CodeHostReviewVerdict;
      body: string;
      createdAt: number;
    }
  | { kind: "commit"; sha: string; headline: string; authorName: string; createdAt: number }
  /** Any other event, already phrased, such as "renamed the title". 1 to 1,000 characters. */
  | { kind: "event"; id: string; actor?: CodeHostUser; text: string; createdAt: number };

export type CodeHostConversationRequest = CodeHostPullRequestRef;

export interface CodeHostConversationResult {
  /** Markdown, at most 65,536 characters. */
  description: string;
  /** Oldest first, at most 5,000. */
  timeline: CodeHostTimelineEvent[];
  /** At most 2,000. */
  threads: CodeHostReviewThread[];
  /** At most 3,000. */
  viewedPaths: string[];
  mergeMethods: ("merge" | "squash" | "rebase")[];
}

/** `skipped` is skipped, neutral or not applicable: neither passed nor failed. */
export type CodeHostCheckRunState = "pending" | "success" | "failure" | "skipped";

export interface CodeHostCheck {
  /** 1 to 500 characters. */
  name: string;
  state: CodeHostCheckRunState;
  /** An http or https URL, at most 2,000 characters. */
  url?: string;
}

export type CodeHostChecksRequest = CodeHostPullRequestRef;

/** The checks on the pull request's head, at most 500. */
export interface CodeHostChecksResult {
  checks: CodeHostCheck[];
}

/** A comment anchored to lines of the diff at `headSha`. */
export interface CodeHostLineAnchor {
  path: string;
  side: CodeHostDiffSide;
  line: number;
  startLine?: number;
}

/** A review, sent at once with its verdict and its line comments (at most 500). */
export interface CodeHostSubmitReviewRequest extends CodeHostPullRequestRef {
  headSha: string;
  verdict: "approve" | "request_changes" | "comment";
  body?: string;
  comments: (CodeHostLineAnchor & { body: string })[];
  /**
   * Names this review across tries and restarts. A try with the identity of
   * an earlier one sends only what the code host doesn't hold yet, so Retry
   * after an uncertain failure posts nothing twice.
   */
  submissionId?: string;
}

export interface CodeHostSubmitReviewResult {
  reviewId: string;
}

/** A single comment: on the conversation, or on lines when `anchor` is set. */
export interface CodeHostPostCommentRequest extends CodeHostPullRequestRef {
  body: string;
  anchor?: CodeHostLineAnchor & { headSha: string };
}

export interface CodeHostCommentResult {
  commentId: string;
}

/** A commit a version brought. */
export interface CodeHostVersionCommit {
  sha: string;
  headline: string;
  authorName: string;
  createdAt: number;
}

/** One version of a pull request: a push on GitHub, an iteration on Azure DevOps. */
export interface CodeHostVersion {
  /** From 1, in push order. */
  number: number;
  headSha: string;
  /** Where this head met the target branch. Absent when the code host doesn't say. */
  baseSha?: string;
  pushedAt: number;
  /** The push rewrote the branch. */
  forced?: boolean;
  /** At most 250, oldest first. */
  commits: CodeHostVersionCommit[];
}

/** At most 500 versions, oldest first; the last is the pull request's head. */
export interface CodeHostVersionsResult {
  versions: CodeHostVersion[];
  /** What the code host calls a version. A push when absent. */
  versionName?: "push" | "iteration";
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

/**
 * A person in Azure DevOps. Comment authors and mentions carry the identity
 * id; assignees carry the uniqueName, which `System.AssignedTo` takes.
 */
export interface BacklogPerson {
  id: string;
  displayName: string;
  /** Under the name in Ajour's suggestions, to tell people apart. */
  email?: string;
}

/** A comment without its text, for a settled item. */
export interface BacklogCommentFact {
  id: string;
  author: BacklogPerson;
  /** ISO 8601. */
  createdAt: string;
  mentionsViewer?: boolean;
}

export interface BacklogItemCommentFacts {
  localWorkItemId: string;
  /** At most 50. */
  comments: BacklogCommentFact[];
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

export interface BacklogPostItemCommentRequest {
  sourceId: string;
  /** Markdown. Mentions are `[@Name](mention:<id>)`. */
  body: string;
}

export interface BacklogPostItemCommentResult {
  comment: BacklogComment;
}

export interface BacklogEditItemCommentRequest {
  sourceId: string;
  commentId: string;
  /** Markdown. Mentions are `[@Name](mention:<id>)`. */
  body: string;
}

export interface BacklogDeleteItemCommentRequest {
  sourceId: string;
  commentId: string;
}

export interface BacklogSetItemCommentReactionRequest {
  sourceId: string;
  commentId: string;
  reaction: BacklogReaction;
  reacted: boolean;
}

export interface BacklogSetItemCommentReactionResult {
  reactions: NonNullable<BacklogComment["reactions"]>;
}

export interface BacklogSearchItemPeopleRequest {
  sourceId: string;
  /** Empty after a bare @, which asks for the item's own people. */
  query: string;
  /** 1 to 20. */
  limit: number;
}

export interface BacklogSearchItemPeopleResult {
  /** In the id space of `mention:<id>`. */
  people: BacklogPerson[];
}

export interface BacklogSearchAssigneesRequest {
  sourceId: string;
  /** Empty for the item's likely assignees, which need only Work Items (Read). */
  query: string;
  /** 1 to 20. */
  limit: number;
}

export interface BacklogSearchAssigneesResult {
  /** At most 20, by uniqueName, the id `writeSettle` takes as `assignee`. */
  people: BacklogPerson[];
}

export interface BacklogReadDescriptionRequest {
  sourceId: string;
}

export interface BacklogReadDescriptionResult {
  /** The work item's current description. */
  description: ConnectorSyncedDescription;
}

export interface BacklogWriteDescriptionRequest {
  sourceId: string;
  /** The Markdown to write. */
  text: string;
  /** The text `readDescription` returned just before. */
  expected: string;
  /** The `lost` names the user saw and saved anyway. */
  allowedLoss?: string[];
}

export interface BacklogWriteDescriptionResult {
  /** `conflict` when the item no longer held `expected`, and nothing was written. */
  outcome: "written" | "conflict";
  /** The description after the write, or as it is in a conflict. */
  description: ConnectorSyncedDescription;
}
