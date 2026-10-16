import { createAuthHeader } from "./azure-devops.js";
import { repositoryInScope, type PullRequestConfig } from "./pull-request-config.js";
import type {
  CodeHostCommentFact,
  CodeHostPullRequestFacts,
  CodeHostPullRequestRef,
  CodeHostReviewFact,
  CodeHostReviewRequest,
  CodeHostReviewRequestEvent,
  CodeHostReviewVerdict,
  CodeHostSyncResult,
  CodeHostUser,
} from "./contract.js";

const API_VERSION = "7.1";
const TEAMS_API_VERSION = "7.1-preview.3";
const POLICY_API_VERSION = "7.1-preview.1";
const PAGE_SIZE = 100;
const MAX_PULL_REQUESTS = 1000;
const DETAIL_CONCURRENCY = 4;
const BUILD_POLICY_TYPE = "0609b952-1397-4640-95ec-e00a01b2c241";
const STATUS_POLICY_TYPE = "cbdc66da-9728-4af8-aada-9a5a32e4a226";

/** Thrown for 404 and 403, so a pull request out of reach can be skipped. */
export class AzureReposNotFoundError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404,
  ) {
    super(message);
  }
}

export class AzureReposClient {
  private readonly authorization: string;

  constructor(
    private readonly organizationUrl: string,
    token: string,
  ) {
    this.authorization = createAuthHeader(token);
  }

  async get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(`${this.organizationUrl}${path}`);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", Authorization: this.authorization },
        redirect: "manual",
      });
    } catch (error) {
      throw new Error(
        `Azure DevOps request failed: ${error instanceof Error ? error.message : "network error"}.`,
      );
    }

    // A rejected token gets 401, or a 203 or a redirect to the sign-in page.
    const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
    if (response.status === 401 || response.status === 203 || (response.status >= 300 && response.status < 400)) {
      throw new Error(
        "Azure DevOps rejected the token. Check that it is valid, not expired, and allowed in this organization.",
      );
    }
    if (response.status === 403 || response.status === 404) {
      throw new AzureReposNotFoundError(await errorDetail(response, isJson), response.status);
    }
    if (!response.ok) {
      throw new Error(`Azure DevOps request failed (${response.status}): ${await errorDetail(response, isJson)}`);
    }
    if (!isJson) {
      throw new Error("Azure DevOps returned an unexpected response. Check the organization URL.");
    }
    return (await response.json()) as T;
  }

  /** The repositories the token can read, across the organization. Needs Code (Read). */
  async listRepositories() {
    try {
      return (
        await this.get<{ value: { id: string; project: { id: string } }[] }>("/_apis/git/repositories", {
          "api-version": API_VERSION,
        })
      ).value;
    } catch (error) {
      throw codeAccessError(error);
    }
  }

  async checkCodeAccess() {
    await this.listRepositories();
  }
}

function codeAccessError(error: unknown) {
  return error instanceof AzureReposNotFoundError
    ? new Error("Azure DevOps refused to list pull requests. Give the token the Code (Read) scope.")
    : error;
}

async function errorDetail(response: Response, isJson: boolean) {
  if (isJson) {
    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
    } catch {
      // Fall back to the status text.
    }
  }
  return response.statusText || "Request failed";
}

interface AzureIdentity {
  id: string;
  displayName?: string;
  uniqueName?: string;
  descriptor?: string;
  isContainer?: boolean;
}

interface AzureReviewer extends AzureIdentity {
  vote?: number;
  hasDeclined?: boolean;
}

export interface AzurePullRequest {
  pullRequestId: number;
  status: "active" | "completed" | "abandoned" | "notSet" | "all";
  title: string;
  isDraft?: boolean;
  creationDate: string;
  closedDate?: string;
  createdBy: AzureIdentity;
  reviewers?: AzureReviewer[];
  mergeStatus?: string;
  lastMergeSourceCommit?: { commitId: string };
  repository: { id: string; name: string; project: { id: string; name: string } };
}

interface AzureProperty {
  $value?: unknown;
}

export interface AzureThread {
  id: number;
  publishedDate?: string;
  lastUpdatedDate?: string;
  isDeleted?: boolean;
  properties?: Record<string, AzureProperty | undefined>;
  identities?: Record<string, AzureIdentity | undefined>;
  comments: {
    id: number;
    author?: AzureIdentity;
    content?: string;
    publishedDate?: string;
    commentType?: string;
    isDeleted?: boolean;
  }[];
}

export interface AzureIteration {
  id: number;
  createdDate?: string;
  updatedDate?: string;
  author?: AzureIdentity;
  sourceRefCommit?: { commitId: string };
  push?: { date?: string; pushedBy?: AzureIdentity };
}

export interface AzurePolicyEvaluation {
  status?: string;
  configuration?: { isEnabled?: boolean; type?: { id?: string } };
}

export interface PullRequestDetails {
  threads: AzureThread[];
  iterations: AzureIteration[];
  /** Absent when the policy evaluations could not be read. */
  evaluations?: AzurePolicyEvaluation[];
}

export interface Viewer {
  id: string;
  user: CodeHostUser;
}

interface MappingContext {
  organizationUrl: string;
  viewer: Viewer;
  /** Lowercased ids of the viewer's teams, or empty when team requests are off. */
  viewerTeams: Set<string>;
}

function time(value: string | undefined) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const sameId = (left: string | undefined, right: string | undefined) =>
  left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();

const SERVICE_DESCRIPTOR = /^(svc|aadsp|s2s|acs)\./i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build services, service principals and other non-human accounts. */
export function isServiceIdentity(identity: AzureIdentity) {
  const uniqueName = identity.uniqueName ?? "";
  return (
    SERVICE_DESCRIPTOR.test(identity.descriptor ?? "") ||
    /^Build\\/i.test(uniqueName) ||
    GUID.test(uniqueName)
  );
}

/**
 * The login is the identity's unique name, such as an email. The viewer's own
 * identity always maps to the viewer's login, so Ajour recognizes own activity.
 */
export function toUser(identity: AzureIdentity | undefined, viewer: Viewer): CodeHostUser {
  if (!identity?.id) return { login: "unknown", isBot: false };
  if (sameId(identity.id, viewer.id)) return viewer.user;
  return {
    login: identity.uniqueName?.trim() || identity.id,
    ...(identity.displayName?.trim() ? { displayName: identity.displayName.trim() } : {}),
    isBot: isServiceIdentity(identity),
  };
}

interface ConnectionData {
  authenticatedUser?: {
    id?: string;
    providerDisplayName?: string;
    customDisplayName?: string;
    properties?: { Account?: AzureProperty };
  };
}

export async function fetchViewer(client: AzureReposClient): Promise<Viewer> {
  const data = await client.get<ConnectionData>("/_apis/connectionData");
  const user = data.authenticatedUser;
  if (!user?.id || !GUID.test(user.id)) {
    throw new Error("Azure DevOps did not name the token's account. Check the organization URL.");
  }
  const account = user.properties?.Account?.$value;
  const displayName = (user.customDisplayName || user.providerDisplayName)?.trim();
  return {
    id: user.id,
    user: {
      login: typeof account === "string" && account.trim() ? account.trim() : user.id,
      ...(displayName ? { displayName } : {}),
      isBot: false,
    },
  };
}

function propertyValue(thread: AzureThread, name: string) {
  return thread.properties?.[name]?.$value;
}

/** Resolves an identity property, whose value is a key into `thread.identities`. */
function threadIdentity(thread: AzureThread, name: string) {
  const key = propertyValue(thread, name);
  return key === undefined ? undefined : thread.identities?.[String(key)];
}

function voteVerdict(vote: number): CodeHostReviewVerdict | undefined {
  if (vote > 0) return "approved";
  if (vote < 0) return "changes_requested";
  if (vote === 0) return "dismissed";
  return undefined;
}

const MENTION = /@<([0-9a-f-]{36})>|data-vss-mention="version:[\d.]+,([0-9a-f-]{36})"/gi;

/** Whether the comment mentions the identity, as `@<id>` in Markdown or a mention link in HTML. */
export function mentions(content: string, identityId: string) {
  for (const match of content.matchAll(MENTION)) {
    if (sameId(match[1] ?? match[2], identityId)) return true;
  }
  return false;
}

function threadType(thread: AzureThread) {
  const value = propertyValue(thread, "CodeReviewThreadType");
  return typeof value === "string" ? value : undefined;
}

function threadTime(thread: AzureThread) {
  return time(thread.publishedDate) ?? time(thread.comments[0]?.publishedDate);
}

function toReviews(threads: AzureThread[], viewer: Viewer): CodeHostReviewFact[] {
  return threads.flatMap((thread): CodeHostReviewFact[] => {
    if (threadType(thread) !== "VoteUpdate") return [];
    const vote = Number(propertyValue(thread, "CodeReviewVoteResult"));
    const verdict = Number.isInteger(vote) ? voteVerdict(vote) : undefined;
    const submittedAt = threadTime(thread);
    const voter =
      threadIdentity(thread, "CodeReviewVotedByIdentity") ??
      legacyIdentity(thread, "CodeReviewVotedByTfId", "CodeReviewVotedByDisplayName");
    if (!verdict || submittedAt === undefined || !voter) return [];
    return [{ id: `vote-${thread.id}`, author: toUser(voter, viewer), verdict, submittedAt, mentionsViewer: false }];
  });
}

function legacyIdentity(thread: AzureThread, idName: string, displayNameName: string): AzureIdentity | undefined {
  const id = propertyValue(thread, idName);
  if (typeof id !== "string" || !id) return undefined;
  const displayName = propertyValue(thread, displayNameName);
  return { id, ...(typeof displayName === "string" ? { displayName } : {}) };
}

function toReviewRequestEvents(threads: AzureThread[], context: MappingContext): CodeHostReviewRequestEvent[] {
  return threads.flatMap((thread): CodeHostReviewRequestEvent[] => {
    if (threadType(thread) !== "ReviewersUpdate") return [];
    const createdAt = threadTime(thread);
    // Several additions in one update number their keys: AddedIdentity, AddedIdentity1, …
    const added = Object.keys(thread.properties ?? {})
      .filter((name) => name.startsWith("CodeReviewReviewersUpdatedAddedIdentity"))
      .flatMap((name) => threadIdentity(thread, name) ?? []);
    if (createdAt === undefined || added.length === 0) return [];
    const actor = threadIdentity(thread, "CodeReviewReviewersUpdatedByIdentity") ?? thread.comments[0]?.author;
    return [
      {
        id: `reviewers-${thread.id}`,
        author: toUser(actor, context.viewer),
        createdAt,
        includesViewer: added.some(
          (identity) => sameId(identity.id, context.viewer.id) || context.viewerTeams.has(identity.id.toLowerCase()),
        ),
      },
    ];
  });
}

function toComments(threads: AzureThread[], viewer: Viewer): CodeHostCommentFact[] {
  return threads
    .filter((thread) => !thread.isDeleted)
    .flatMap((thread) =>
      thread.comments.flatMap((comment): CodeHostCommentFact[] => {
        const createdAt = time(comment.publishedDate);
        if (comment.isDeleted || comment.commentType === "system" || createdAt === undefined) return [];
        return [
          {
            id: `${thread.id}-${comment.id}`,
            author: toUser(comment.author, viewer),
            createdAt,
            threadId: String(thread.id),
            mentionsViewer: mentions(comment.content ?? "", viewer.id),
          },
        ];
      }),
    )
    .sort((left, right) => left.createdAt - right.createdAt);
}

/** A reviewer who has not voted nor declined is still asked to review. */
function toReviewRequests(pullRequest: AzurePullRequest, context: MappingContext): CodeHostReviewRequest[] {
  return (pullRequest.reviewers ?? [])
    .filter((reviewer) => (reviewer.vote ?? 0) === 0 && !reviewer.hasDeclined)
    .map((reviewer) =>
      reviewer.isContainer
        ? {
            kind: "team" as const,
            name: reviewer.displayName?.trim() || reviewer.id,
            includesViewer: context.viewerTeams.has(reviewer.id.toLowerCase()),
          }
        : {
            kind: "user" as const,
            name: toUser(reviewer, context.viewer).login,
            includesViewer: sameId(reviewer.id, context.viewer.id),
          },
    );
}

export function checkState(evaluations: AzurePolicyEvaluation[] | undefined): CodeHostPullRequestFacts["checks"] {
  const statuses = (evaluations ?? [])
    .filter((evaluation) => {
      const type = evaluation.configuration?.type?.id?.toLowerCase();
      return (
        evaluation.configuration?.isEnabled !== false &&
        (type === BUILD_POLICY_TYPE || type === STATUS_POLICY_TYPE) &&
        evaluation.status !== "notApplicable"
      );
    })
    .map((evaluation) => evaluation.status);
  if (statuses.some((status) => status === "rejected" || status === "broken")) return "failure";
  if (statuses.some((status) => status === "queued" || status === "running")) return "pending";
  if (statuses.some((status) => status === "approved")) return "success";
  return "none";
}

function mergeability(status: string | undefined): CodeHostPullRequestFacts["mergeability"] {
  if (status === "succeeded") return "mergeable";
  if (status === "conflicts") return "conflicting";
  return "unknown";
}

export function webUrl(organizationUrl: string, pullRequest: AzurePullRequest) {
  const { repository } = pullRequest;
  return `${organizationUrl}/${encodeURIComponent(repository.project.name)}/_git/${encodeURIComponent(repository.name)}/pullrequest/${pullRequest.pullRequestId}`;
}

const lastN = <T>(items: T[], count: number) => items.slice(Math.max(0, items.length - count));

export function toPullRequestFacts(
  pullRequest: AzurePullRequest,
  details: PullRequestDetails,
  context: MappingContext,
): CodeHostPullRequestFacts {
  const createdAt = time(pullRequest.creationDate) ?? 0;
  const closedAt = pullRequest.status === "active" ? undefined : time(pullRequest.closedDate);
  const iterations = [...details.iterations].sort((left, right) => left.id - right.id);
  const lastIteration = iterations.at(-1);
  const pusher = lastIteration?.push?.pushedBy ?? lastIteration?.author;
  const lastPushedAt =
    time(lastIteration?.push?.date) ?? time(lastIteration?.createdDate) ?? createdAt;
  const reviews = lastN(toReviews(details.threads, context.viewer), 500);
  const comments = lastN(toComments(details.threads, context.viewer), 2000);
  const updatedAt = Math.max(
    createdAt,
    closedAt ?? 0,
    lastPushedAt,
    ...details.threads.map((thread) => time(thread.lastUpdatedDate) ?? 0),
    ...iterations.map((iteration) => time(iteration.updatedDate) ?? 0),
  );
  const repository = pullRequest.repository;

  return {
    id: String(pullRequest.pullRequestId),
    repository: `${repository.project.name}/${repository.name}`,
    number: pullRequest.pullRequestId,
    url: webUrl(context.organizationUrl, pullRequest),
    title: pullRequest.title.trim() || `Pull request ${pullRequest.pullRequestId}`,
    author: toUser(pullRequest.createdBy, context.viewer),
    state: pullRequest.status === "active" ? "open" : pullRequest.status === "completed" ? "merged" : "closed",
    draft: pullRequest.isDraft === true,
    createdAt,
    updatedAt,
    ...(closedAt !== undefined ? { closedAt } : {}),
    viewerIsAuthor: sameId(pullRequest.createdBy.id, context.viewer.id),
    headSha:
      pullRequest.lastMergeSourceCommit?.commitId ?? lastIteration?.sourceRefCommit?.commitId ?? "unknown",
    lastPushedAt,
    ...(pusher?.id ? { lastPushActor: toUser(pusher, context.viewer) } : {}),
    reviewRequests: lastN(toReviewRequests(pullRequest, context), 100),
    reviewRequestEvents: lastN(toReviewRequestEvents(details.threads, context), 500),
    reviews,
    comments,
    checks: checkState(details.evaluations),
    mergeability: mergeability(pullRequest.mergeStatus),
  };
}

async function fetchViewerTeams(client: AzureReposClient): Promise<Set<string>> {
  const teams = new Set<string>();
  try {
    for (let skip = 0; ; skip += PAGE_SIZE) {
      const page = await client.get<{ value: { id: string }[] }>("/_apis/teams", {
        $mine: true,
        $top: PAGE_SIZE,
        $skip: skip,
        "api-version": TEAMS_API_VERSION,
      });
      for (const team of page.value) teams.add(team.id.toLowerCase());
      if (page.value.length < PAGE_SIZE) return teams;
    }
  } catch {
    throw new Error(
      "Azure DevOps could not list your teams. Give the token the Project and Team (Read) scope, or turn off Include team review requests.",
    );
  }
}

const TOO_MANY_PULL_REQUESTS = `More than ${MAX_PULL_REQUESTS} open pull requests match. The sync was not applied; narrow the connection with Only these projects or repositories.`;

/** Every active pull request under `scope` ("" for the organization, or "/{projectId}") that matches. */
async function listActive(client: AzureReposClient, scope: string, criteria: Record<string, string>) {
  const pullRequests: AzurePullRequest[] = [];
  for (let skip = 0; skip <= MAX_PULL_REQUESTS; skip += PAGE_SIZE) {
    const page = await client
      .get<{ value: AzurePullRequest[] }>(`${scope}/_apis/git/pullrequests`, {
        "searchCriteria.status": "active",
        ...criteria,
        $top: PAGE_SIZE,
        $skip: skip,
        "api-version": API_VERSION,
      })
      .catch((error: unknown) => {
        throw codeAccessError(error);
      });
    pullRequests.push(...page.value);
    if (page.value.length < PAGE_SIZE) return pullRequests;
  }
  throw new Error(TOO_MANY_PULL_REQUESTS);
}

/**
 * Searches pull requests across the organization. Microsoft documents the
 * pull request list per project only, though its own tools list them for the
 * whole organization. A 404 from the organization-wide list, whether it is
 * not routed or not visible to the token, makes the search run once per
 * project among the repositories the token can read.
 */
export class PullRequestSearch {
  /** Undefined when the organization-wide list works. */
  private projectIds?: Promise<string[] | undefined>;

  constructor(private readonly client: AzureReposClient) {}

  async run(criteria: Record<string, string>) {
    const projectIds = await this.resolveProjects();
    if (!projectIds) return await listActive(this.client, "", criteria);
    const pullRequests: AzurePullRequest[] = [];
    for (const projectId of projectIds) {
      pullRequests.push(...(await listActive(this.client, `/${encodeURIComponent(projectId)}`, criteria)));
      if (pullRequests.length > MAX_PULL_REQUESTS) throw new Error(TOO_MANY_PULL_REQUESTS);
    }
    return pullRequests;
  }

  private resolveProjects() {
    this.projectIds ??= (async () => {
      try {
        await this.client.get("/_apis/git/pullrequests", { $top: 1, "api-version": API_VERSION });
        return undefined;
      } catch (error) {
        if (!(error instanceof AzureReposNotFoundError && error.status === 404)) throw codeAccessError(error);
      }
      const repositories = await this.client.listRepositories();
      return Array.from(new Set(repositories.map((repository) => repository.project.id)));
    })();
    return this.projectIds;
  }
}

async function fetchTracked(client: AzureReposClient, ref: CodeHostPullRequestRef) {
  try {
    return await client.get<AzurePullRequest>(`/_apis/git/pullrequests/${ref.number}`, {
      "api-version": API_VERSION,
    });
  } catch (error) {
    // A pull request the token can no longer see drops out of the result.
    if (error instanceof AzureReposNotFoundError) return undefined;
    throw error;
  }
}

async function fetchDetails(client: AzureReposClient, pullRequest: AzurePullRequest): Promise<PullRequestDetails> {
  const { project, id: repositoryId } = pullRequest.repository;
  const base = `/${encodeURIComponent(project.id)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequest.pullRequestId}`;
  const artifactId = `vstfs:///CodeReview/CodeReviewId/${project.id}/${pullRequest.pullRequestId}`;
  const [threads, iterations, evaluations] = await Promise.all([
    client.get<{ value: AzureThread[] }>(`${base}/threads`, { "api-version": API_VERSION }),
    client.get<{ value: AzureIteration[] }>(`${base}/iterations`, { "api-version": API_VERSION }),
    // Checks are optional facts: without policy access they read as none.
    client
      .get<{ value: AzurePolicyEvaluation[] }>(`/${encodeURIComponent(project.id)}/_apis/policy/evaluations`, {
        artifactId,
        "api-version": POLICY_API_VERSION,
      })
      .then((page) => page.value)
      .catch(() => undefined),
  ]);
  return { threads: threads.value, iterations: iterations.value, ...(evaluations ? { evaluations } : {}) };
}

async function mapConcurrently<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(map))));
  }
  return results;
}

/**
 * Open pull requests the viewer wrote or reviews, directly or through a team,
 * that pass the connection's filters, plus every tracked pull request that
 * closed, so Ajour sees it close. A tracked pull request missing from the
 * result is out of the filters or out of reach.
 */
export async function syncPullRequests(
  config: PullRequestConfig,
  tracked: CodeHostPullRequestRef[],
): Promise<CodeHostSyncResult> {
  const client = new AzureReposClient(config.organizationUrl, config.token);
  const viewer = await fetchViewer(client);
  const viewerTeams = config.includeTeamRequests ? await fetchViewerTeams(client) : new Set<string>();

  const search = new PullRequestSearch(client);
  const results = await Promise.all([
    search.run({ "searchCriteria.creatorId": viewer.id }),
    search.run({ "searchCriteria.reviewerId": viewer.id }),
    ...Array.from(viewerTeams, (teamId) => search.run({ "searchCriteria.reviewerId": teamId })),
  ]);

  const found = new Map<number, AzurePullRequest>();
  for (const pullRequest of results.flat()) found.set(pullRequest.pullRequestId, pullRequest);
  const missing = tracked.filter((ref) => !found.has(ref.number));
  for (const pullRequest of await mapConcurrently(missing, DETAIL_CONCURRENCY, (ref) => fetchTracked(client, ref))) {
    if (pullRequest) found.set(pullRequest.pullRequestId, pullRequest);
  }

  const selected = Array.from(found.values()).filter(
    (pullRequest) =>
      pullRequest.status !== "active" ||
      (repositoryInScope(config, pullRequest.repository.project.name, pullRequest.repository.name) &&
        !(config.hideDrafts && pullRequest.isDraft)),
  );
  if (selected.length > MAX_PULL_REQUESTS) {
    throw new Error(
      `The combined pull request list exceeds Ajour's ${MAX_PULL_REQUESTS}-item limit. Narrow the connection with Only these projects or repositories.`,
    );
  }

  const context: MappingContext = { organizationUrl: config.organizationUrl, viewer, viewerTeams };
  const pullRequests = await mapConcurrently(selected, DETAIL_CONCURRENCY, async (pullRequest) =>
    toPullRequestFacts(pullRequest, await fetchDetails(client, pullRequest), context),
  );
  return { viewer: viewer.user, instanceUrl: config.organizationUrl, pullRequests };
}
