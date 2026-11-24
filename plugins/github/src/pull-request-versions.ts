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
 * force push) are one push. A review names the commit it reviewed, so a push
 * ends there: GitHub lists a commit by its date, and one committed before a
 * review may have been pushed after it. A push listed after an event is dated
 * after it, so a review never covers a push that came later. The last
 * version is always the pull request's
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
          ... on PullRequestReview { submittedAt commit { oid } }
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
  | { __typename: "PullRequestReview"; submittedAt: string | null; commit: { oid: string } | null }
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
  let lastEventAt: number | undefined;
  /** A force push no other event followed yet, which claims the commits it lists after it. */
  let forced: Draft | undefined;
  /** Adds a version, or more commits to the last one when it ends on the same head. */
  const addDraft = (draft: Draft) => {
    const last = drafts.at(-1);
    if (last?.headSha === draft.headSha) {
      last.commits.push(...draft.commits);
      return last;
    }
    drafts.push(draft);
    return draft;
  };
  /**
   * Ends the run's push at `closedAt`: all of it, or up to `reviewed`, the
   * commit a review names, when the run holds it. A run after that commit,
   * or one whose commits all came after the commit reviewed, stays open.
   */
  const closeRun = (closedAt?: number, reviewed?: string) => {
    if (!run.length) return;
    let ended = run;
    if (reviewed !== undefined) {
      const at = run.findIndex((commit) => commit.oid === reviewed);
      if (at < 0 && drafts.some((draft) => draft.headSha === reviewed)) return;
      if (at >= 0) ended = run.slice(0, at + 1);
    }
    run = run.slice(ended.length);
    const commits = ended.map(toCommit);
    if (forced && ended.some((commit) => commit.oid === forced!.headSha)) {
      forced.commits.push(...commits);
      return;
    }
    const committedAt = Math.max(...commits.map((commit) => commit.createdAt));
    const after = lastEventAt === undefined ? committedAt : Math.max(committedAt, lastEventAt + 1);
    addDraft({
      headSha: ended.at(-1)!.oid,
      pushedAt: closedAt === undefined ? after : Math.min(after, closedAt),
      commits,
    });
  };
  const event = (at: number, reviewed?: string) => {
    closeRun(at, reviewed);
    forced = undefined;
    lastEventAt = Math.max(lastEventAt ?? at, at);
  };
  for (const item of items) {
    switch (item.__typename) {
      case "PullRequestCommit":
        run.push(item.commit);
        break;
      case "PullRequestReview":
        // A pending review is a draft nobody else sees.
        if (item.submittedAt) event(time(item.submittedAt), item.commit?.oid);
        break;
      case "IssueComment":
        event(time(item.createdAt));
        break;
      case "HeadRefForcePushedEvent": {
        const at = time(item.createdAt);
        event(at);
        if (!item.afterCommit) break;
        // A rebased commit GitHub listed before its force push, by its date, is the same version.
        const pushed = addDraft({ headSha: item.afterCommit.oid, pushedAt: at, forced: true, commits: [] });
        pushed.forced = true;
        pushed.pushedAt = at;
        forced = pushed;
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
      pushedAt: Math.max(
        lastEventAt === undefined ? 0 : lastEventAt + 1,
        last?.pushedAt ?? 0,
        ...unseen.map((commit) => commit.createdAt),
      ),
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
