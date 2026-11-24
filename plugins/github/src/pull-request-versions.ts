import type { GitHubClient } from "./github.ts";
import {
  clip,
  notFound,
  readAll,
  time,
  variables,
  type Connection,
  type PullRequestOf,
} from "./pull-request-review.ts";
import type {
  CodeHostPullRequestRef,
  CodeHostVersion,
  CodeHostVersionCommit,
  CodeHostVersionsResult,
} from "./contract.ts";

/*
 * A pull request's versions for Deck's versions bar (les-cabochons/ajour#787).
 * GitHub keeps no record of a plain push, so the pushes come from the
 * timeline: a force push is a version of its own, at the commit it pushed,
 * and the commits listed between two other events (a review, a comment, a
 * force push) are one push. The last version is always the pull request's
 * head. GitHub doesn't say where an older head met the base branch, so the
 * versions carry no base: Deck reads an older version against the head's.
 */

const MAX_TIMELINE = 5_000;
const MAX_VERSIONS = 500;
const MAX_COMMITS = 250;
const MAX_HEADLINE = 1_000;
const MAX_AUTHOR = 240;

const COMMIT_FIELDS = `oid messageHeadline committedDate author { name }`;

const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: 100, after: $after, itemTypes: [
        PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, PULL_REQUEST_REVIEW, ISSUE_COMMENT
      ]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on PullRequestCommit { commit { ${COMMIT_FIELDS} } }
          ... on HeadRefForcePushedEvent { createdAt beforeCommit { oid } afterCommit { oid } }
          ... on PullRequestReview { submittedAt }
          ... on IssueComment { createdAt }
        }
      }
    }
  }
}`;

/** The head, and the last commits on it, which the last force push's version brought. */
const HEAD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: ${MAX_COMMITS}) { nodes { commit { ${COMMIT_FIELDS} } } }
    }
  }
}`;

interface GitHubCommit {
  oid: string;
  messageHeadline: string;
  committedDate: string;
  author: { name: string | null } | null;
}

type TimelineItem =
  | { __typename: "PullRequestCommit"; commit: GitHubCommit }
  | {
      __typename: "HeadRefForcePushedEvent";
      createdAt: string;
      beforeCommit: { oid: string } | null;
      afterCommit: { oid: string } | null;
    }
  | { __typename: "PullRequestReview"; submittedAt: string | null }
  | { __typename: "IssueComment"; createdAt: string };

const toCommit = (commit: GitHubCommit): CodeHostVersionCommit => ({
  sha: commit.oid,
  headline: clip(commit.messageHeadline, MAX_HEADLINE),
  authorName: clip(commit.author?.name ?? "", MAX_AUTHOR),
  createdAt: time(commit.committedDate),
});

/** A version being built: its commits come before its number. */
type Draft = Omit<CodeHostVersion, "number" | "commits"> & { commits: CodeHostVersionCommit[] };

/** The pull request's pushes, oldest first, numbered from 1, ending on its head. */
export async function readVersions(client: GitHubClient, ref: CodeHostPullRequestRef): Promise<CodeHostVersionsResult> {
  const vars = variables(ref);
  const head = await client.query<
    PullRequestOf<{ headRefOid: string; commits: { nodes: { commit: GitHubCommit }[] } }>
  >(HEAD_QUERY, vars);
  const pullRequest = head.repository?.pullRequest;
  if (!pullRequest) notFound();
  const items = await readAll<TimelineItem>(MAX_TIMELINE, async (after) => {
    const data = await client.query<PullRequestOf<{ timelineItems: Connection<TimelineItem> }>>(TIMELINE_QUERY, {
      ...vars,
      after,
    });
    return data.repository?.pullRequest?.timelineItems;
  });

  const drafts: Draft[] = [];
  /** The commits listed since the last event, pushed together. */
  let run: GitHubCommit[] = [];
  /** When the last event happened: a push listed after it came later. */
  let lastEventAt = 0;
  /** A force push no other event followed yet, which claims the commits it lists after it. */
  let forced: Draft | undefined;
  const closeRun = (closedAt?: number) => {
    if (!run.length) return;
    const commits = run.map(toCommit);
    if (forced && run.some((commit) => commit.oid === forced!.headSha)) {
      forced.commits.push(...commits);
    } else {
      const committedAt = Math.max(...commits.map((commit) => commit.createdAt));
      const pushedAt = Math.max(committedAt, lastEventAt);
      drafts.push({
        headSha: run.at(-1)!.oid,
        pushedAt: closedAt === undefined ? pushedAt : Math.min(pushedAt, closedAt),
        commits,
      });
    }
    run = [];
  };
  const event = (at: number) => {
    closeRun(at);
    forced = undefined;
    lastEventAt = Math.max(lastEventAt, at);
  };
  for (const item of items) {
    switch (item.__typename) {
      case "PullRequestCommit":
        run.push(item.commit);
        break;
      case "PullRequestReview":
        // A pending review is a draft nobody else sees.
        if (item.submittedAt) event(time(item.submittedAt));
        break;
      case "IssueComment":
        event(time(item.createdAt));
        break;
      case "HeadRefForcePushedEvent": {
        const at = time(item.createdAt);
        event(at);
        if (!item.afterCommit) break;
        forced = { headSha: item.afterCommit.oid, pushedAt: at, forced: true, commits: [] };
        drafts.push(forced);
        break;
      }
    }
  }
  closeRun();

  // The head's commits that no earlier version brought: a rewrite's, or a push the timeline missed.
  const seen = new Set(drafts.flatMap((draft) => draft.commits.map((commit) => commit.sha)));
  const unseen = pullRequest.commits.nodes.map((node) => toCommit(node.commit)).filter((commit) => !seen.has(commit.sha));
  const last = drafts.at(-1);
  if (!last || last.headSha !== pullRequest.headRefOid) {
    drafts.push({
      headSha: pullRequest.headRefOid,
      pushedAt: Math.max(lastEventAt, last?.pushedAt ?? 0, ...unseen.map((commit) => commit.createdAt)),
      commits: unseen,
    });
  } else if (last.forced && !last.commits.length) {
    last.commits.push(...unseen);
  }

  const versions = drafts.map(
    (draft, index): CodeHostVersion => ({
      number: index + 1,
      headSha: draft.headSha,
      pushedAt: draft.pushedAt,
      ...(draft.forced ? { forced: true } : {}),
      commits: draft.commits.slice(-MAX_COMMITS),
    }),
  );
  return { versions: versions.slice(-MAX_VERSIONS) };
}
