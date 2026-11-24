import type { GitHubClient, PageInfo } from "./github.ts";
import { nextCursor, splitRepository, toUser, type GitHubActor } from "./github.ts";
import { withoutSubmissionMark } from "./pull-request-writes.ts";
import type {
  CodeHostCheck,
  CodeHostCheckRunState,
  CodeHostChecksResult,
  CodeHostConversationResult,
  CodeHostPullRequestRef,
  CodeHostReviewThread,
  CodeHostReviewVerdict,
  CodeHostTimelineEvent,
} from "./contract.ts";

/*
 * What Deck's review page reads beside the diff (les-cabochons/ajour#783):
 * the conversation, its description, timeline, review threads, viewed files
 * and merge methods, and the checks on the head. Each comes from GraphQL,
 * one connection at a time, page by page, up to Ajour's limits.
 */

const PAGE_SIZE = 100;
const MAX_TIMELINE = 5_000;
const MAX_THREADS = 2_000;
const MAX_THREAD_COMMENTS = 500;
const MAX_VIEWED = 3_000;
const MAX_CHECKS = 500;
/** Ajour's limits on a body and on an event's text. */
const MAX_BODY = 65_536;
const MAX_TEXT = 1_000;
const MAX_NAME = 500;
const MAX_URL = 2_000;

const ACTOR_FIELDS = `__typename login avatarUrl ... on User { name }`;
const COMMENT_FIELDS = `id body createdAt lastEditedAt author { ${ACTOR_FIELDS} }`;

const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequest(number: $number) { body createdAt author { ${ACTOR_FIELDS} } }
  }
}`;

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path diffSide line startLine isResolved isOutdated
          comments(first: ${PAGE_SIZE}) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
        }
      }
    }
  }
}`;

/** The rest of a long thread's comments, after its first page. */
const THREAD_COMMENTS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: ${PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${COMMENT_FIELDS} }
      }
    }
  }
}`;

const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: ${PAGE_SIZE}, after: $after, itemTypes: [
        ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT,
        RENAMED_TITLE_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, REVIEW_REQUESTED_EVENT,
        MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT
      ]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on IssueComment { id body createdAt author { ${ACTOR_FIELDS} } }
          ... on PullRequestReview { id state body submittedAt author { ${ACTOR_FIELDS} } }
          ... on PullRequestCommit { commit { oid messageHeadline committedDate author { name } } }
          ... on HeadRefForcePushedEvent { id createdAt actor { ${ACTOR_FIELDS} } }
          ... on RenamedTitleEvent { id createdAt previousTitle currentTitle actor { ${ACTOR_FIELDS} } }
          ... on ReadyForReviewEvent { id createdAt actor { ${ACTOR_FIELDS} } }
          ... on ConvertToDraftEvent { id createdAt actor { ${ACTOR_FIELDS} } }
          ... on ReviewRequestedEvent {
            id createdAt actor { ${ACTOR_FIELDS} }
            requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug organization { login } } }
          }
          ... on MergedEvent { id createdAt actor { ${ACTOR_FIELDS} } }
          ... on ClosedEvent { id createdAt actor { ${ACTOR_FIELDS} } }
          ... on ReopenedEvent { id createdAt actor { ${ACTOR_FIELDS} } }
        }
      }
    }
  }
}`;

const FILES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: ${PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`;

const CHECKS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: ${PAGE_SIZE}, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion detailsUrl url }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

interface GitHubThreadComment {
  id: string;
  body: string;
  createdAt: string;
  lastEditedAt: string | null;
  author: GitHubActor | null;
}

interface GitHubThread {
  id: string;
  path: string;
  diffSide: "LEFT" | "RIGHT";
  line: number | null;
  startLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: Connection<GitHubThreadComment>;
}

type GitHubReviewer =
  | { __typename: "User" | "Bot" | "Mannequin"; login: string }
  | { __typename: "Team"; slug: string; organization: { login: string } }
  | null;

type GitHubTimelineItem =
  | { __typename: "IssueComment"; id: string; body: string; createdAt: string; author: GitHubActor | null }
  | { __typename: "PullRequestReview"; id: string; state: string; body: string; submittedAt: string | null; author: GitHubActor | null }
  | { __typename: "PullRequestCommit"; commit: { oid: string; messageHeadline: string; committedDate: string; author: { name: string | null } | null } }
  | { __typename: "RenamedTitleEvent"; id: string; createdAt: string; previousTitle: string; currentTitle: string; actor: GitHubActor | null }
  | { __typename: "ReviewRequestedEvent"; id: string; createdAt: string; actor: GitHubActor | null; requestedReviewer: GitHubReviewer }
  | {
      __typename:
        | "HeadRefForcePushedEvent"
        | "ReadyForReviewEvent"
        | "ConvertToDraftEvent"
        | "MergedEvent"
        | "ClosedEvent"
        | "ReopenedEvent";
      id: string;
      createdAt: string;
      actor: GitHubActor | null;
    };

type GitHubCheckContext =
  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null; detailsUrl: string | null; url: string | null }
  | { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null };

export interface Connection<T> {
  pageInfo: PageInfo;
  nodes: T[];
}

const VERDICTS: Record<string, CodeHostReviewVerdict> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

/** What each event says, after its actor's name. */
const EVENT_TEXT: Record<string, string> = {
  HeadRefForcePushedEvent: "force-pushed the branch",
  ReadyForReviewEvent: "marked this pull request ready for review",
  ConvertToDraftEvent: "marked this pull request as a draft",
  MergedEvent: "merged this pull request",
  ClosedEvent: "closed this pull request",
  ReopenedEvent: "reopened this pull request",
};

export function time(value: string) {
  return Date.parse(value);
}

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The pull request's variables, its owner, name and number. */
export function variables(ref: CodeHostPullRequestRef) {
  const [owner, name] = splitRepository(ref.repository);
  return { owner, name, number: ref.number };
}

/** Every node of one connection, page by page, up to `max`. */
export async function readAll<T>(
  max: number,
  read: (after: string | null) => Promise<Connection<T> | null | undefined>,
): Promise<T[]> {
  const nodes: T[] = [];
  let after: string | null = null;
  while (nodes.length < max) {
    const page: Connection<T> | null | undefined = await read(after);
    if (!page) break;
    nodes.push(...page.nodes);
    after = nextCursor(page.pageInfo, after);
    if (!after) break;
  }
  return nodes.slice(0, max);
}

export type PullRequestOf<T> = { repository: { pullRequest: T | null } | null };

export function notFound(): never {
  throw new Error("GitHub could not find the pull request.");
}

function toThread(thread: GitHubThread): CodeHostReviewThread[] {
  const comments = thread.comments.nodes.map((comment) => ({
    id: comment.id,
    author: toUser(comment.author),
    body: clip(comment.body, MAX_BODY),
    createdAt: time(comment.createdAt),
    ...(comment.lastEditedAt ? { updatedAt: time(comment.lastEditedAt) } : {}),
  }));
  if (comments.length === 0 || thread.path.length > 1_000) return [];
  const line = thread.line ?? undefined;
  const startLine = line !== undefined && thread.startLine && thread.startLine < line ? thread.startLine : undefined;
  return [
    {
      id: thread.id,
      path: thread.path,
      side: thread.diffSide === "LEFT" ? "base" : "head",
      ...(line !== undefined ? { line } : {}),
      ...(startLine !== undefined ? { startLine } : {}),
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
      comments: comments.slice(0, 500),
    },
  ];
}

function reviewerName(reviewer: GitHubReviewer) {
  if (!reviewer) return undefined;
  return reviewer.__typename === "Team" ? `${reviewer.organization.login}/${reviewer.slug}` : reviewer.login;
}

function toTimelineEvent(item: GitHubTimelineItem): CodeHostTimelineEvent[] {
  switch (item.__typename) {
    case "IssueComment":
      return [{ kind: "comment", id: item.id, author: toUser(item.author), body: clip(item.body, MAX_BODY), createdAt: time(item.createdAt) }];
    case "PullRequestReview": {
      const verdict = VERDICTS[item.state];
      // A pending review is a draft nobody else sees.
      if (!verdict || !item.submittedAt) return [];
      // Without the line naming the submission Ajour sent it as.
      const body = clip(withoutSubmissionMark(item.body), MAX_BODY);
      return [{ kind: "review", id: item.id, author: toUser(item.author), verdict, body, createdAt: time(item.submittedAt) }];
    }
    case "PullRequestCommit":
      return [
        {
          kind: "commit",
          sha: item.commit.oid,
          headline: clip(item.commit.messageHeadline, MAX_TEXT),
          authorName: clip(item.commit.author?.name ?? "", 240),
          createdAt: time(item.commit.committedDate),
        },
      ];
    case "RenamedTitleEvent":
      return [
        {
          kind: "event",
          id: item.id,
          ...(item.actor ? { actor: toUser(item.actor) } : {}),
          text: clip(`renamed the title from “${item.previousTitle}” to “${item.currentTitle}”`, MAX_TEXT),
          createdAt: time(item.createdAt),
        },
      ];
    case "ReviewRequestedEvent": {
      const name = reviewerName(item.requestedReviewer);
      return [
        {
          kind: "event",
          id: item.id,
          ...(item.actor ? { actor: toUser(item.actor) } : {}),
          text: clip(name ? `requested a review from ${name}` : "requested a review", MAX_TEXT),
          createdAt: time(item.createdAt),
        },
      ];
    }
    default: {
      const text = EVENT_TEXT[item.__typename];
      if (!text) return [];
      return [
        { kind: "event", id: item.id, ...(item.actor ? { actor: toUser(item.actor) } : {}), text, createdAt: time(item.createdAt) },
      ];
    }
  }
}

/** A thread with the comments past its first page too, up to Ajour's 500. */
async function withAllComments(client: GitHubClient, thread: GitHubThread): Promise<GitHubThread> {
  if (!thread.comments.pageInfo?.hasNextPage) return thread;
  const first = thread.comments.nodes;
  const rest = await readAll(MAX_THREAD_COMMENTS - first.length, async (after) =>
    (
      await client.query<{ node: { comments?: Connection<GitHubThreadComment> } | null }>(THREAD_COMMENTS_QUERY, {
        id: thread.id,
        after: after ?? thread.comments.pageInfo.endCursor,
      })
    ).node?.comments,
  );
  return { ...thread, comments: { ...thread.comments, nodes: [...first, ...rest] } };
}

/**
 * The pull request's conversation: its description, its timeline oldest
 * first, opening with the pull request itself, its review threads, the files
 * the user marked viewed and the repository's merge methods.
 */
export async function readConversation(
  client: GitHubClient,
  ref: CodeHostPullRequestRef,
): Promise<CodeHostConversationResult> {
  const vars = variables(ref);
  const head = await client.query<{
    repository: {
      mergeCommitAllowed: boolean;
      squashMergeAllowed: boolean;
      rebaseMergeAllowed: boolean;
      pullRequest: { body: string; createdAt: string; author: GitHubActor | null } | null;
    } | null;
  }>(PULL_REQUEST_QUERY, vars);
  const repository = head.repository;
  const pullRequest = repository?.pullRequest;
  if (!repository || !pullRequest) notFound();

  const page = <T, K extends string>(query: string, key: K) =>
    async (after: string | null) =>
      (await client.query<PullRequestOf<Record<K, Connection<T>>>>(query, { ...vars, after })).repository?.pullRequest?.[key];
  const [threads, items, files] = await Promise.all([
    readAll(MAX_THREADS, page<GitHubThread, "reviewThreads">(THREADS_QUERY, "reviewThreads")),
    readAll(MAX_TIMELINE - 1, page<GitHubTimelineItem, "timelineItems">(TIMELINE_QUERY, "timelineItems")),
    readAll(MAX_VIEWED, page<{ path: string; viewerViewedState: string }, "files">(FILES_QUERY, "files")),
  ]);

  const opened: CodeHostTimelineEvent = {
    kind: "event",
    id: `opened-${ref.number}`,
    ...(pullRequest.author ? { actor: toUser(pullRequest.author) } : {}),
    text: "opened this pull request",
    createdAt: time(pullRequest.createdAt),
  };
  return {
    description: clip(pullRequest.body ?? "", MAX_BODY),
    timeline: [opened, ...items.flatMap(toTimelineEvent)].sort((left, right) => left.createdAt - right.createdAt),
    threads: (await Promise.all(threads.map((thread) => withAllComments(client, thread)))).flatMap(toThread),
    viewedPaths: files.filter((file) => file.viewerViewedState === "VIEWED" && file.path.length <= 1_000).map((file) => file.path),
    mergeMethods: [
      ...(repository.mergeCommitAllowed ? (["merge"] as const) : []),
      ...(repository.squashMergeAllowed ? (["squash"] as const) : []),
      ...(repository.rebaseMergeAllowed ? (["rebase"] as const) : []),
    ],
  };
}

function checkRunState(status: string, conclusion: string | null): CodeHostCheckRunState {
  if (status !== "COMPLETED") return "pending";
  switch (conclusion) {
    case "SUCCESS":
      return "success";
    case "NEUTRAL":
    case "SKIPPED":
    // GitHub marks a run stale when it never completed; it won't finish now.
    case "STALE":
      return "skipped";
    default:
      // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE.
      return "failure";
  }
}

function statusState(state: string): CodeHostCheckRunState {
  if (state === "SUCCESS") return "success";
  if (state === "FAILURE" || state === "ERROR") return "failure";
  return "pending";
}

/** An http or https URL Ajour accepts, or nothing. */
function linkOf(value: string | null | undefined) {
  if (!value || value.length > MAX_URL) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function toCheck(context: GitHubCheckContext): CodeHostCheck[] {
  const name = (context.__typename === "CheckRun" ? context.name : context.context).trim();
  if (!name) return [];
  const state =
    context.__typename === "CheckRun" ? checkRunState(context.status, context.conclusion) : statusState(context.state);
  const url = linkOf(context.__typename === "CheckRun" ? (context.detailsUrl ?? context.url) : context.targetUrl);
  return [{ name: clip(name, MAX_NAME), state, ...(url ? { url } : {}) }];
}

/** Every check run and commit status on the pull request's head, as GitHub lists them. */
export async function readChecks(client: GitHubClient, ref: CodeHostPullRequestRef): Promise<CodeHostChecksResult> {
  const vars = variables(ref);
  const contexts = await readAll<GitHubCheckContext>(MAX_CHECKS, async (after) => {
    const data = await client.query<
      PullRequestOf<{
        commits: { nodes: { commit: { statusCheckRollup: { contexts: Connection<GitHubCheckContext> } | null } }[] };
      }>
    >(CHECKS_QUERY, { ...vars, after });
    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) notFound();
    return pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
  });
  return { checks: contexts.flatMap(toCheck) };
}
