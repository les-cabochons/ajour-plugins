import type { PullRequestConfig } from "./pull-request-config.ts";
import {
  API_VERSION,
  AzureReposClient,
  BUILD_POLICY_TYPE,
  fetchTracked,
  fetchViewer,
  POLICY_API_VERSION,
  threadTime,
  threadType,
  time,
  toReviews,
  toUser,
  type AzureIteration,
  type AzurePolicyEvaluation,
  type AzurePullRequest,
  type AzureThread,
  type Viewer,
} from "./pull-requests.ts";
import type {
  CodeHostCheck,
  CodeHostCheckRunState,
  CodeHostChecksResult,
  CodeHostConversationResult,
  CodeHostLinkedTicket,
  CodeHostLinkedTicketsResult,
  CodeHostPullRequestRef,
  CodeHostReviewThread,
  CodeHostTimelineEvent,
} from "./contract.ts";

/*
 * What Deck's review page reads beside the diff (les-cabochons/ajour#783):
 * the conversation, from the pull request's threads and iterations, and its
 * checks, from the policy evaluations Azure DevOps shows as checks. And the
 * work items it is linked to, for the summary above the guide
 * (les-cabochons/ajour#789).
 */

const MAX_TIMELINE = 5_000;
const MAX_THREADS = 2_000;
const MAX_CHECKS = 500;
const MAX_BODY = 65_536;
const MAX_TEXT = 1_000;
const MAX_NAME = 500;
const MAX_URL = 2_000;

/** A code thread is resolved once its status is any of these. */
export const RESOLVED = new Set(["fixed", "wontFix", "closed", "byDesign"]);
/** System threads the timeline tells another way: votes as reviews, pushes as iterations. */
const TOLD_ELSEWHERE = new Set(["VoteUpdate", "RefUpdate"]);

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The pull request, found by its id, which is unique in the organization or collection. */
export async function findPullRequest(client: AzureReposClient, ref: CodeHostPullRequestRef) {
  const pullRequest = await fetchTracked(client, ref);
  if (!pullRequest) throw new Error("Azure DevOps could not find the pull request.");
  return pullRequest;
}

export function pullRequestPath(pullRequest: AzurePullRequest) {
  const { project, id: repositoryId } = pullRequest.repository;
  return `/${encodeURIComponent(project.id)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequest.pullRequestId}`;
}

/** A person's comments on a thread: no system messages, nothing deleted, nothing empty. */
function textComments(thread: AzureThread, viewer: Viewer) {
  return thread.comments.flatMap((comment) => {
    const createdAt = time(comment.publishedDate);
    const body = comment.content?.trim() ?? "";
    if (comment.isDeleted || comment.commentType === "system" || !body || createdAt === undefined) return [];
    const updatedAt = time(comment.lastUpdatedDate);
    return [
      {
        id: `${thread.id}-${comment.id}`,
        author: toUser(comment.author, viewer),
        body: clip(body, MAX_BODY),
        createdAt,
        ...(updatedAt !== undefined && updatedAt > createdAt ? { updatedAt } : {}),
      },
    ];
  });
}

/**
 * A code thread on its file: on the head's lines when it names right-side
 * lines, on the base's when it names left-side ones, and with no line when
 * it is about the whole file.
 */
function toThread(thread: AzureThread, viewer: Viewer): CodeHostReviewThread[] {
  const context = thread.threadContext;
  const path = context?.filePath?.replace(/^\/+/, "");
  const comments = textComments(thread, viewer);
  if (!path || path.length > 1_000 || comments.length === 0) return [];
  const right = context?.rightFileEnd?.line;
  const left = context?.leftFileEnd?.line;
  const side = right ? "head" : left ? "base" : "head";
  const line = right || left || undefined;
  const start = right ? context?.rightFileStart?.line : context?.leftFileStart?.line;
  return [
    {
      id: String(thread.id),
      path,
      side,
      ...(line ? { line } : {}),
      ...(line && start && start < line ? { startLine: start } : {}),
      resolved: RESOLVED.has(thread.status ?? ""),
      // Azure DevOps tracks a thread to the latest iteration, asked below, and
      // doesn't say when it couldn't.
      outdated: false,
      comments: comments.slice(0, 500),
    },
  ];
}

/** What a system thread says, as Azure DevOps phrased it, with its author's name. */
function systemEvent(thread: AzureThread): CodeHostTimelineEvent[] {
  const comment = thread.comments.find((entry) => entry.commentType === "system" && !entry.isDeleted);
  const text = comment?.content?.trim();
  const createdAt = threadTime(thread);
  if (!text || createdAt === undefined || TOLD_ELSEWHERE.has(threadType(thread) ?? "")) return [];
  return [{ kind: "event", id: `thread-${thread.id}`, text: clip(text, MAX_TEXT), createdAt }];
}

function iterationEvent(iteration: AzureIteration, viewer: Viewer): CodeHostTimelineEvent[] {
  const createdAt = time(iteration.push?.date) ?? time(iteration.createdDate);
  if (createdAt === undefined) return [];
  const pusher = iteration.push?.pushedBy ?? iteration.author;
  return [
    {
      kind: "event",
      id: `iteration-${iteration.id}`,
      ...(pusher?.id ? { actor: toUser(pusher, viewer) } : {}),
      text: `pushed iteration ${iteration.id}`,
      createdAt,
    },
  ];
}

/**
 * The pull request's conversation: its description, a timeline of its
 * opening, iterations, votes, comments on the whole pull request and system
 * messages, oldest first, and its code threads on the latest iteration.
 * Azure DevOps doesn't share which files the user marked viewed.
 */
export async function readConversation(
  config: PullRequestConfig,
  ref: CodeHostPullRequestRef,
): Promise<CodeHostConversationResult> {
  const client = new AzureReposClient(config.connectionId, config.savedOrganizationUrl);
  const [viewer, pullRequest] = await Promise.all([fetchViewer(client), findPullRequest(client, ref)]);
  const base = pullRequestPath(pullRequest);
  const iterations = (
    await client.get<{ value: AzureIteration[] }>(`${base}/iterations`, { "api-version": API_VERSION })
  ).value.sort((left, right) => left.id - right.id);
  const latest = iterations.at(-1)?.id;
  // Positions tracked to the latest iteration, against the target branch.
  const threads = (
    await client.get<{ value: AzureThread[] }>(`${base}/threads`, {
      "api-version": API_VERSION,
      ...(latest !== undefined ? { $iteration: latest, $baseIteration: 0 } : {}),
    })
  ).value.filter((thread) => !thread.isDeleted);

  const codeThreads = threads.filter((thread) => thread.threadContext?.filePath);
  const otherThreads = threads.filter((thread) => !thread.threadContext?.filePath);
  const createdAt = time(pullRequest.creationDate) ?? 0;
  const timeline: CodeHostTimelineEvent[] = [
    {
      kind: "event",
      id: `opened-${pullRequest.pullRequestId}`,
      actor: toUser(pullRequest.createdBy, viewer),
      text: "opened this pull request",
      createdAt,
    },
    ...iterations.flatMap((iteration) => iterationEvent(iteration, viewer)),
    ...toReviews(threads, viewer).map(
      (review): CodeHostTimelineEvent => ({
        kind: "review",
        id: review.id,
        author: review.author,
        verdict: review.verdict,
        body: "",
        createdAt: review.submittedAt,
      }),
    ),
    ...otherThreads.flatMap((thread) =>
      textComments(thread, viewer).map(
        (comment): CodeHostTimelineEvent => ({
          kind: "comment",
          id: comment.id,
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt,
        }),
      ),
    ),
    ...otherThreads.flatMap(systemEvent),
  ];
  timeline.sort((left, right) => left.createdAt - right.createdAt);

  return {
    description: clip(pullRequest.description ?? "", MAX_BODY),
    timeline: timeline.slice(0, MAX_TIMELINE),
    threads: codeThreads.flatMap((thread) => toThread(thread, viewer)).slice(0, MAX_THREADS),
    viewedPaths: [],
    // A branch policy may limit them; Azure DevOps refuses the merge then.
    mergeMethods: ["merge", "squash", "rebase"],
  };
}

function evaluationState(status: string | undefined): CodeHostCheckRunState {
  switch (status) {
    case "approved":
      return "success";
    case "rejected":
    case "broken":
      return "failure";
    case "notApplicable":
      return "skipped";
    default:
      // queued and running.
      return "pending";
  }
}

function buildUrl(config: PullRequestConfig, pullRequest: AzurePullRequest, evaluation: AzurePolicyEvaluation) {
  const buildId = evaluation.context?.buildId;
  if (evaluation.configuration?.type?.id?.toLowerCase() !== BUILD_POLICY_TYPE || !Number.isInteger(buildId)) {
    return undefined;
  }
  const url = `${config.organizationUrl}/${encodeURIComponent(pullRequest.repository.project.name)}/_build/results?buildId=${buildId}`;
  return url.length <= MAX_URL ? url : undefined;
}

function toCheck(
  config: PullRequestConfig,
  pullRequest: AzurePullRequest,
  evaluation: AzurePolicyEvaluation,
): CodeHostCheck[] {
  if (evaluation.configuration?.isEnabled === false) return [];
  const name = (evaluation.configuration?.settings?.displayName || evaluation.configuration?.type?.displayName || "").trim();
  if (!name) return [];
  const url = buildUrl(config, pullRequest, evaluation);
  return [{ name: clip(name, MAX_NAME), state: evaluationState(evaluation.status), ...(url ? { url } : {}) }];
}

/**
 * The pull request's policies, as Azure DevOps lists them under its checks:
 * builds, statuses, reviewers, linked work items and the rest. A build links
 * to its last run.
 */
export async function readChecks(config: PullRequestConfig, ref: CodeHostPullRequestRef): Promise<CodeHostChecksResult> {
  const client = new AzureReposClient(config.connectionId, config.savedOrganizationUrl);
  const pullRequest = await findPullRequest(client, ref);
  const { project } = pullRequest.repository;
  const evaluations = await client.get<{ value: AzurePolicyEvaluation[] }>(
    `/${encodeURIComponent(project.id)}/_apis/policy/evaluations`,
    {
      artifactId: `vstfs:///CodeReview/CodeReviewId/${project.id}/${pullRequest.pullRequestId}`,
      "api-version": POLICY_API_VERSION,
    },
  );
  return {
    checks: evaluations.value.flatMap((evaluation) => toCheck(config, pullRequest, evaluation)).slice(0, MAX_CHECKS),
  };
}

const MAX_TICKETS = 50;
const MAX_TITLE = 1_000;
const MAX_STATE = 100;
/**
 * The fields a linked work item is read with. The read is behind Read the
 * backlog, which is always on, and needs the token's Work Items (Read): a
 * token with only Code (Read) fails it, and Deck says the tickets couldn't
 * be read.
 */
const TICKET_FIELDS = ["System.Title", "System.State", "System.Description", "System.TeamProject"];

interface AzureWorkItem {
  id: number;
  fields?: Record<string, unknown>;
}

const textField = (item: AzureWorkItem, name: string) => {
  const value = item.fields?.[name];
  return typeof value === "string" ? value : "";
};

function toTicket(config: PullRequestConfig, item: AzureWorkItem | null): CodeHostLinkedTicket[] {
  if (!item || !Number.isInteger(item.id) || item.id < 1) return [];
  const title = textField(item, "System.Title").trim();
  const state = textField(item, "System.State").trim();
  const project = textField(item, "System.TeamProject").trim();
  if (!title || !state || !project) return [];
  const url = `${config.organizationUrl}/${encodeURIComponent(project)}/_workitems/edit/${item.id}`;
  if (url.length > MAX_URL) return [];
  return [
    {
      number: item.id,
      title: clip(title, MAX_TITLE),
      body: clip(textField(item, "System.Description"), MAX_BODY),
      url,
      state: clip(state, MAX_STATE),
    },
  ];
}

/**
 * The work items the pull request is linked to, in its order: its work item
 * refs, then their title, state and description in one read. A work item
 * the token can't read is left out.
 */
export async function readLinkedTickets(
  config: PullRequestConfig,
  ref: CodeHostPullRequestRef,
): Promise<CodeHostLinkedTicketsResult> {
  const client = new AzureReposClient(config.connectionId, config.savedOrganizationUrl);
  const pullRequest = await findPullRequest(client, ref);
  const refs = await client.get<{ value: { id: string }[] }>(`${pullRequestPath(pullRequest)}/workitems`, {
    "api-version": API_VERSION,
  });
  const ids = [
    ...new Set(refs.value.map((linked) => Number(linked.id)).filter((id) => Number.isInteger(id) && id > 0)),
  ].slice(0, MAX_TICKETS);
  if (!ids.length) return { tickets: [] };
  const items = await client.get<{ value: (AzureWorkItem | null)[] }>("/_apis/wit/workitems", {
    ids: ids.join(","),
    fields: TICKET_FIELDS.join(","),
    errorPolicy: "omit",
    "api-version": API_VERSION,
  });
  const byId = new Map(items.value.flatMap((item) => (item ? [[item.id, item] as const] : [])));
  return { tickets: ids.flatMap((id) => toTicket(config, byId.get(id) ?? null)) };
}
