// Ajour plugin API version 4. These types mirror packages/shared/code-host.ts
// and packages/shared/connectors.ts in les-cabochons/ajour. Times are Unix
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
export interface CodeHostSubmitReviewRequest extends CodeHostPullRequestRef, CodeHostSubmission {
  headSha: string;
  verdict: "approve" | "request_changes" | "comment";
  body?: string;
  comments: (CodeHostLineAnchor & { body: string })[];
}

/**
 * A write's name across tries and restarts. Ajour runs the writes that share
 * one a connection at a time.
 */
export interface CodeHostSubmission {
  /**
   * Names this post across tries and restarts. On a retry the plugin first
   * finds what an earlier try left and sends only what the code host
   * doesn't hold yet, so Retry after a lost answer posts nothing twice.
   * Letters, digits, `-` and `_`, at most 100.
   */
  submissionId?: string;
  /**
   * Set on a retry only: when the first try with this `submissionId` was
   * sent, in Unix milliseconds, by this computer's clock. A hint only, as
   * the clocks may disagree: the plugin looks for what that try posted
   * whatever its time, and treats an unmarked post of the user's from
   * around then on as maybe it.
   */
  firstTriedAt?: number;
}

/**
 * A retry the code host can't settle: something the user posted since the
 * first try may be it, but nothing there names this submission. The user
 * decides whether to post again, as a new submission.
 */
export interface CodeHostUncertainResult {
  uncertain: true;
}

export type CodeHostSubmitReviewResult = { reviewId: string } | CodeHostUncertainResult;

/** A single comment: on the conversation, or on lines when `anchor` is set. */
export interface CodeHostPostCommentRequest extends CodeHostPullRequestRef, CodeHostSubmission {
  body: string;
  anchor?: CodeHostLineAnchor & { headSha: string };
}

export interface CodeHostCommentResult {
  commentId: string;
}

export type CodeHostPostCommentResult = CodeHostCommentResult | CodeHostUncertainResult;

/** A reply at the end of a review thread, named like a comment. */
export interface CodeHostReplyRequest extends CodeHostPullRequestRef, CodeHostSubmission {
  threadId: string;
  body: string;
}

export interface CodeHostResolveThreadRequest extends CodeHostPullRequestRef {
  threadId: string;
  resolved: boolean;
}

export interface CodeHostResolveThreadResult {
  resolved: boolean;
}

export interface CodeHostSetFileViewedRequest extends CodeHostPullRequestRef {
  path: string;
  viewed: boolean;
  /**
   * The head the user viewed the file at. Marking it viewed is refused once
   * the pull request moved on, so the code host never shows as viewed code
   * the user didn't read.
   */
  headSha: string;
}

export interface CodeHostSetFileViewedResult {
  viewed: boolean;
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
  /** The commit the diff starts from: the merge base of the base branch and the head. */
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

// Connector capability. These types mirror packages/shared/connectors.ts in
// les-cabochons/ajour.

/** Ajour's priority levels. A source value that maps to no level has no priority. */
export type ConnectorPriorityLevel = "urgent" | "high" | "medium" | "low";

/** A synced description, as GitHub holds it. */
export interface ConnectorSyncedDescription {
  /** Markdown, up to 64,000 characters. */
  text: string;
  /** What Ajour's copy cannot keep, such as "line endings Ajour cannot keep". */
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
  /** True for a closed issue. Ajour archives done items. */
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

/** The issue's values in GitHub after the write. */
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

export interface BacklogReadDescriptionRequest {
  sourceId: string;
}

export interface BacklogReadDescriptionResult {
  /** The issue's current description. */
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
  /** `conflict` when the issue no longer held `expected`, and nothing was written. */
  outcome: "written" | "conflict";
  /** The description after the write, or as it is in a conflict. */
  description: ConnectorSyncedDescription;
}
