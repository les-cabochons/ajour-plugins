import { repositoryInScope, type GitHubConfig } from "./config.js";
import type {
  CodeHostCommentFact,
  CodeHostPullRequestFacts,
  CodeHostPullRequestRef,
  CodeHostReviewFact,
  CodeHostReviewRequest,
  CodeHostReviewVerdict,
  CodeHostSyncResult,
  CodeHostUser,
} from "./contract.js";

const SEARCH_PAGE_SIZE = 25;
const MAX_SEARCH_RESULTS = 1000;
const MAX_SEARCH_PAGES = MAX_SEARCH_RESULTS / SEARCH_PAGE_SIZE;
const TRACKED_BATCH_SIZE = 20;

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export class GitHubClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
  ) {}

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "ajour-github-plugin",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 401) {
      throw new Error("GitHub rejected the token. Check that it is valid and not expired.");
    }
    if (!response.ok) {
      throw new Error(`GitHub request failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors?.length) {
      throw new Error(`GitHub: ${payload.errors.map((error) => error.message).join(" ")}`);
    }
    if (!payload.data) {
      throw new Error("GitHub returned no data.");
    }
    return payload.data;
  }
}

interface GitHubActor {
  __typename: string;
  login: string;
  avatarUrl?: string;
  name?: string | null;
}

interface GitHubComment {
  id: string;
  createdAt: string;
  body: string;
  author: GitHubActor | null;
}

interface GitHubPullRequest {
  id: string;
  number: number;
  url: string;
  title: string;
  isDraft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  headRefOid: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  repository: { nameWithOwner: string };
  author: GitHubActor | null;
  commits: {
    nodes: { commit: { statusCheckRollup: { state: string } | null } }[];
  };
  timelineItems: {
    nodes: (
      | { __typename: "PullRequestCommit"; commit: { committedDate: string } }
      | { __typename: "HeadRefForcePushedEvent"; createdAt: string }
    )[];
  };
  reviewRequests: {
    nodes: {
      requestedReviewer:
        | { __typename: "User" | "Bot" | "Mannequin"; login: string }
        | { __typename: "Team"; slug: string; organization: { login: string } }
        | null;
    }[];
  };
  reviews: {
    nodes: {
      id: string;
      state: string;
      submittedAt: string | null;
      author: GitHubActor | null;
    }[];
  };
  comments: { nodes: GitHubComment[] };
  reviewThreads: {
    nodes: { id: string; comments: { nodes: GitHubComment[] } }[];
  };
}

const ACTOR_FIELDS = `__typename login avatarUrl ... on User { name }`;

const PULL_REQUEST_FIELDS = `
  id number url title isDraft state createdAt updatedAt closedAt headRefOid mergeable
  repository { nameWithOwner }
  author { ${ACTOR_FIELDS} }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  timelineItems(last: 1, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]) {
    nodes {
      __typename
      ... on PullRequestCommit { commit { committedDate } }
      ... on HeadRefForcePushedEvent { createdAt }
    }
  }
  reviewRequests(first: 50) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login }
        ... on Bot { login }
        ... on Mannequin { login }
        ... on Team { slug organization { login } }
      }
    }
  }
  reviews(last: 100) { nodes { id state submittedAt author { ${ACTOR_FIELDS} } } }
  comments(last: 100) { nodes { id createdAt body author { ${ACTOR_FIELDS} } } }
  reviewThreads(last: 50) {
    nodes { id comments(last: 30) { nodes { id createdAt body author { ${ACTOR_FIELDS} } } } }
  }
`;

const VIEWER_QUERY = `query { viewer { ${ACTOR_FIELDS} } }`;

const TEAMS_QUERY = `query($login: String!, $after: String) {
  viewer {
    organizations(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { login teams(first: 100, userLogins: [$login]) {
        pageInfo { hasNextPage endCursor }
        nodes { slug }
      } }
    }
  }
}`;

const ORGANIZATION_TEAMS_QUERY = `query($organization: String!, $login: String!, $after: String) {
  organization(login: $organization) {
    teams(first: 100, userLogins: [$login], after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { slug }
    }
  }
}`;

const SEARCH_QUERY = `query($q: String!, $after: String) {
  search(type: ISSUE, query: $q, first: ${SEARCH_PAGE_SIZE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PULL_REQUEST_FIELDS} } }
  }
}`;

function time(value: string) {
  return Date.parse(value);
}

function toUser(actor: GitHubActor | null): CodeHostUser {
  if (!actor) {
    // GitHub shows deleted accounts as "ghost".
    return { login: "ghost", isBot: false };
  }
  return {
    login: actor.login,
    ...(actor.name ? { displayName: actor.name } : {}),
    isBot: actor.__typename === "Bot" || actor.login.endsWith("[bot]"),
    ...(actor.avatarUrl ? { avatarUrl: actor.avatarUrl } : {}),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentions(body: string, login: string) {
  return new RegExp(`(^|[^\\w/-])@${escapeRegExp(login)}(?![\\w-])`, "i").test(body);
}

const VERDICTS: Record<string, CodeHostReviewVerdict> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

function checkState(state: string | undefined): CodeHostPullRequestFacts["checks"] {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

interface MappingContext {
  viewer: CodeHostUser;
  /** Complete "org/team" membership snapshot, or empty when team requests are off. */
  viewerTeams: Set<string>;
  includeTeamRequests: boolean;
}

export function toPullRequestFacts(
  pullRequest: GitHubPullRequest,
  context: MappingContext,
): CodeHostPullRequestFacts {
  const viewerLogin = context.viewer.login.toLowerCase();
  const author = toUser(pullRequest.author);

  const reviewRequests: CodeHostReviewRequest[] = pullRequest.reviewRequests.nodes.flatMap(
    ({ requestedReviewer: reviewer }): CodeHostReviewRequest[] => {
      if (!reviewer) {
        return [];
      }
      if (reviewer.__typename !== "Team") {
        return [
          {
            kind: "user",
            name: reviewer.login,
            includesViewer: reviewer.login.toLowerCase() === viewerLogin,
          },
        ];
      }
      const name = `${reviewer.organization.login}/${reviewer.slug}`;
      const viewerIsMember = context.viewerTeams.has(name.toLowerCase());
      return [
        {
          kind: "team",
          name,
          includesViewer: context.includeTeamRequests && viewerIsMember,
        },
      ];
    },
  );

  const reviews: CodeHostReviewFact[] = pullRequest.reviews.nodes.flatMap((review) => {
    const verdict = VERDICTS[review.state];
    // Pending reviews are drafts nobody else can see.
    if (!verdict || !review.submittedAt) {
      return [];
    }
    return [{ id: review.id, author: toUser(review.author), verdict, submittedAt: time(review.submittedAt) }];
  });

  const toComment = (comment: GitHubComment, threadId?: string): CodeHostCommentFact => ({
    id: comment.id,
    author: toUser(comment.author),
    createdAt: time(comment.createdAt),
    ...(threadId ? { threadId } : {}),
    mentionsViewer: mentions(comment.body, context.viewer.login),
  });
  const comments = [
    ...pullRequest.comments.nodes.map((comment) => toComment(comment)),
    ...pullRequest.reviewThreads.nodes.flatMap((thread) =>
      thread.comments.nodes.map((comment) => toComment(comment, thread.id)),
    ),
  ].sort((left, right) => left.createdAt - right.createdAt);

  const lastPush = pullRequest.timelineItems.nodes[0];
  const lastPushedAt = lastPush
    ? time(lastPush.__typename === "PullRequestCommit" ? lastPush.commit.committedDate : lastPush.createdAt)
    : time(pullRequest.createdAt);

  return {
    id: pullRequest.id,
    repository: pullRequest.repository.nameWithOwner,
    number: pullRequest.number,
    url: pullRequest.url,
    title: pullRequest.title,
    author,
    state: pullRequest.state === "OPEN" ? "open" : pullRequest.state === "MERGED" ? "merged" : "closed",
    draft: pullRequest.isDraft,
    createdAt: time(pullRequest.createdAt),
    updatedAt: time(pullRequest.updatedAt),
    ...(pullRequest.closedAt ? { closedAt: time(pullRequest.closedAt) } : {}),
    viewerIsAuthor: author.login.toLowerCase() === viewerLogin,
    headSha: pullRequest.headRefOid,
    lastPushedAt,
    reviewRequests,
    reviews,
    comments,
    checks: checkState(pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.state),
    mergeability:
      pullRequest.mergeable === "MERGEABLE"
        ? "mergeable"
        : pullRequest.mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
  };
}

export async function fetchViewer(client: GitHubClient) {
  const data = await client.query<{ viewer: GitHubActor }>(VIEWER_QUERY);
  return toUser(data.viewer);
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}
interface TeamsPage {
  nodes: { slug: string }[];
  pageInfo: PageInfo;
}

function nextCursor(page: PageInfo, previous: string | null) {
  if (!page.hasNextPage) return null;
  if (!page.endCursor || page.endCursor === previous)
    throw new Error("GitHub returned an incomplete pagination cursor.");
  return page.endCursor;
}

async function fetchViewerTeams(client: GitHubClient, login: string): Promise<Set<string>> {
  const memberships = new Set<string>();
  try {
    let after: string | null = null;
    do {
      const data: {
        viewer: { organizations: { nodes: { login: string; teams: TeamsPage }[]; pageInfo: PageInfo } };
      } = await client.query(TEAMS_QUERY, { login, after });
      for (const organization of data.viewer.organizations.nodes) {
        let teams = organization.teams;
        let teamAfter: string | null = null;
        while (true) {
          for (const team of teams.nodes) memberships.add(`${organization.login}/${team.slug}`.toLowerCase());
          teamAfter = nextCursor(teams.pageInfo, teamAfter);
          if (!teamAfter) break;
          const next = await client.query<{ organization: { teams: TeamsPage } | null }>(
            ORGANIZATION_TEAMS_QUERY,
            { organization: organization.login, login, after: teamAfter },
          );
          if (!next.organization) throw new Error("GitHub could not read an organization.");
          teams = next.organization.teams;
        }
      }
      after = nextCursor(data.viewer.organizations.pageInfo, after);
    } while (after);
    return memberships;
  } catch {
    throw new Error(
      "GitHub could not verify team membership. Grant organization members read access (read:org for classic tokens), or turn off Include team review requests.",
    );
  }
}

async function search(client: GitHubClient, query: string) {
  const pullRequests: GitHubPullRequest[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const data: {
      search: {
        issueCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: (GitHubPullRequest | Record<string, never>)[];
      };
    } = await client.query(SEARCH_QUERY, { q: query, after });
    if (data.search.issueCount > MAX_SEARCH_RESULTS)
      throw new Error(
        "GitHub search exceeds its 1,000-result limit. The sync was not applied; reduce the number of matching open pull requests.",
      );
    pullRequests.push(...data.search.nodes.filter((node): node is GitHubPullRequest => "id" in node));
    after = nextCursor(data.search.pageInfo, after);
    if (!after) return pullRequests;
  }
  throw new Error(
    "GitHub search still has more results at its 1,000-result limit. The sync was not applied.",
  );
}

async function fetchTracked(client: GitHubClient, refs: CodeHostPullRequestRef[]) {
  const pullRequests: GitHubPullRequest[] = [];
  for (let start = 0; start < refs.length; start += TRACKED_BATCH_SIZE) {
    const batch = refs.slice(start, start + TRACKED_BATCH_SIZE);
    const variables: Record<string, unknown> = {};
    const declarations: string[] = [];
    const selections = batch.map((ref, index) => {
      const [owner = "", name = ""] = ref.repository.split("/");
      variables[`o${index}`] = owner;
      variables[`r${index}`] = name;
      variables[`n${index}`] = ref.number;
      declarations.push(`$o${index}: String!`, `$r${index}: String!`, `$n${index}: Int!`);
      return `p${index}: repository(owner: $o${index}, name: $r${index}) {
        pullRequest(number: $n${index}) { ${PULL_REQUEST_FIELDS} }
      }`;
    });
    let data: Record<string, { pullRequest: GitHubPullRequest | null } | null>;
    try {
      data = await client.query(`query(${declarations.join(", ")}) { ${selections.join("\n")} }`, variables);
    } catch {
      // A repository the token can no longer see fails the whole batch.
      // Retry one at a time so the others still report.
      if (batch.length === 1) {
        continue;
      }
      pullRequests.push(...(await fetchTrackedOneByOne(client, batch)));
      continue;
    }
    for (const entry of Object.values(data)) {
      if (entry?.pullRequest) {
        pullRequests.push(entry.pullRequest);
      }
    }
  }
  return pullRequests;
}

async function fetchTrackedOneByOne(client: GitHubClient, refs: CodeHostPullRequestRef[]) {
  const pullRequests: GitHubPullRequest[] = [];
  for (const ref of refs) {
    pullRequests.push(...(await fetchTracked(client, [ref])));
  }
  return pullRequests;
}

function refKey(repository: string, number: number) {
  return `${repository.toLowerCase()}#${number}`;
}

/**
 * Open pull requests that pass the connection's filters, plus every tracked
 * pull request that closed, so Ajour sees it close. A tracked pull request
 * missing from the result is out of the filters or out of reach.
 */
export async function syncPullRequests(
  config: GitHubConfig,
  tracked: CodeHostPullRequestRef[],
): Promise<CodeHostSyncResult> {
  const client = new GitHubClient(config.apiUrl, config.token);
  const viewer = await fetchViewer(client);
  const viewerTeams = config.includeTeamRequests
    ? await fetchViewerTeams(client, viewer.login)
    : new Set<string>();

  const base = "is:pr is:open archived:false";
  const requestedQuery = config.includeTeamRequests ? "review-requested:@me" : "user-review-requested:@me";
  const [authored, requested, reviewed] = await Promise.all([
    search(client, `${base} author:@me`),
    search(client, `${base} ${requestedQuery}`),
    search(client, `${base} reviewed-by:@me -author:@me`),
  ]);

  const found = new Map<string, GitHubPullRequest>();
  for (const pullRequest of [...authored, ...requested, ...reviewed]) {
    found.set(refKey(pullRequest.repository.nameWithOwner, pullRequest.number), pullRequest);
  }
  const missing = tracked.filter((ref) => !found.has(refKey(ref.repository, ref.number)));
  for (const pullRequest of await fetchTracked(client, missing)) {
    found.set(refKey(pullRequest.repository.nameWithOwner, pullRequest.number), pullRequest);
  }

  const context: MappingContext = {
    viewer,
    viewerTeams,
    includeTeamRequests: config.includeTeamRequests,
  };
  const pullRequests = Array.from(found.values())
    .filter(
      (pullRequest) =>
        pullRequest.state !== "OPEN" ||
        (repositoryInScope(config, pullRequest.repository.nameWithOwner) &&
          !(config.hideDrafts && pullRequest.isDraft)),
    )
    .map((pullRequest) => toPullRequestFacts(pullRequest, context));

  if (pullRequests.length > MAX_SEARCH_RESULTS)
    throw new Error(
      "The combined pull request list exceeds Ajour's 1,000-item limit. Narrow the connection's repository scope.",
    );
  return { viewer, instanceUrl: config.hostUrl, pullRequests };
}
