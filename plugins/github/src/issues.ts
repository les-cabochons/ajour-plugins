import { repositoryInScope, type GitHubConfig } from "./config.js";
import type {
  ConnectorImportCandidateInput,
  ConnectorPluginConnection,
  ConnectorPluginSyncResult,
  ConnectorSettleState,
  ConnectorSettleWriteRequest,
  ConnectorSettleWriteResult,
  ConnectorSyncWorkItem,
} from "./contract.js";
import { GitHubClient } from "./github.js";

const SEARCH_PAGE_SIZE = 50;
const MAX_SEARCH_RESULTS = 1000;
const MAX_SEARCH_PAGES = MAX_SEARCH_RESULTS / SEARCH_PAGE_SIZE;
const TRACKED_BATCH_SIZE = 20;
const MAX_NOTE_LENGTH = 4000;

const OPEN = "Open";
const CLOSED = "Closed";
const CLOSED_NOT_PLANNED = "Closed as not planned";

/** The states a settle can move an issue to. GitHub issues have no priority. */
export const ISSUE_SETTLE_STATES: ConnectorSettleState[] = [
  { name: OPEN, category: "Open", done: false },
  { name: CLOSED, category: "Closed", done: true },
  { name: CLOSED_NOT_PLANNED, category: "Closed", done: true },
];

interface GitHubIssue {
  id: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | "DUPLICATE" | null;
  repository: { nameWithOwner: string };
  assignees: { nodes: { login: string }[] };
}

const ISSUE_FIELDS = `
  id number url title body state stateReason
  repository { nameWithOwner }
  assignees(first: 10) { nodes { login } }
`;

const SEARCH_QUERY = `query($q: String!, $after: String) {
  search(type: ISSUE, query: $q, first: ${SEARCH_PAGE_SIZE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { ${ISSUE_FIELDS} } }
  }
}`;

const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${ISSUE_FIELDS} } }
}`;

const CLOSE_MUTATION = `mutation($id: ID!, $reason: IssueClosedStateReason!) {
  closeIssue(input: { issueId: $id, stateReason: $reason }) { issue { ${ISSUE_FIELDS} } }
}`;

const REOPEN_MUTATION = `mutation($id: ID!) {
  reopenIssue(input: { issueId: $id }) { issue { ${ISSUE_FIELDS} } }
}`;

export interface IssueRef {
  repository: string;
  number: number;
}

/** Reads an issue URL of the connection's GitHub instance. */
export function parseIssueUrl(config: GitHubConfig, sourceId: string): IssueRef | null {
  let url: URL;
  try {
    url = new URL(sourceId);
  } catch {
    return null;
  }
  if (url.origin !== config.hostUrl) return null;
  const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(url.pathname);
  if (!match) return null;
  return { repository: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

function stateOf(issue: GitHubIssue) {
  if (issue.state === "OPEN") return { state: OPEN, stateCategory: "Open", stateDone: false };
  return {
    state: issue.stateReason === "NOT_PLANNED" ? CLOSED_NOT_PLANNED : CLOSED,
    stateCategory: "Closed",
    stateDone: true,
  };
}

function clamp(value: string, max: number) {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 3).trimEnd()}...`;
}

export function toCandidate(
  connection: Pick<ConnectorPluginConnection, "id" | "label" | "tenantLabel">,
  issue: GitHubIssue,
): ConnectorImportCandidateInput {
  const repository = issue.repository.nameWithOwner;
  const note = clamp(issue.body ?? "", MAX_NOTE_LENGTH);
  const assignees = issue.assignees.nodes.map((assignee) => assignee.login).join(", ");
  const { state, stateCategory, stateDone } = stateOf(issue);
  return {
    source: "github",
    connectionId: connection.id,
    connectionLabel: connection.label,
    tenantLabel: connection.tenantLabel,
    sourceId: issue.url,
    externalId: clamp(`${repository}#${issue.number}`, 120),
    sourceUrl: issue.url,
    title: clamp(issue.title, 240) || `#${issue.number}`,
    ...(note ? { note } : {}),
    projectName: clamp(repository, 120),
    workItemType: "Issue",
    state,
    stateCategory,
    stateDone,
    ...(assignees ? { assignedTo: clamp(assignees, 240) } : {}),
    depth: 0,
    selectable: !stateDone,
    selected: !stateDone,
    childCount: 0,
  };
}

async function searchAssignedIssues(client: GitHubClient) {
  const issues: GitHubIssue[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const data: {
      search: {
        issueCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: (GitHubIssue | Record<string, never>)[];
      };
    } = await client.query(SEARCH_QUERY, { q: "is:issue is:open assignee:@me archived:false", after });
    if (data.search.issueCount > MAX_SEARCH_RESULTS) {
      throw new Error(
        "More than 1,000 open issues are assigned to you, GitHub search's limit. The sync was not applied.",
      );
    }
    issues.push(...data.search.nodes.filter((node): node is GitHubIssue => "id" in node));
    const { hasNextPage, endCursor } = data.search.pageInfo;
    if (!hasNextPage) return issues;
    if (!endCursor || endCursor === after) throw new Error("GitHub returned an incomplete pagination cursor.");
    after = endCursor;
  }
  throw new Error("GitHub search still has more results at its 1,000-result limit. The sync was not applied.");
}

async function fetchIssues(client: GitHubClient, refs: IssueRef[]) {
  const issues: GitHubIssue[] = [];
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
      return `i${index}: repository(owner: $o${index}, name: $r${index}) { issue(number: $n${index}) { ${ISSUE_FIELDS} } }`;
    });
    let data: Record<string, { issue: GitHubIssue | null } | null>;
    try {
      data = await client.query(`query(${declarations.join(", ")}) { ${selections.join("\n")} }`, variables);
    } catch {
      // A repository the token can no longer see fails the whole batch.
      // Retry one at a time so the others still report.
      if (batch.length > 1) {
        for (const ref of batch) issues.push(...(await fetchIssues(client, [ref])));
      }
      continue;
    }
    for (const entry of Object.values(data)) {
      if (entry?.issue) issues.push(entry.issue);
    }
  }
  return issues;
}

/**
 * Open issues assigned to the viewer that pass the connection's filters, plus
 * every issue Ajour tracks that closed, so Ajour archives it. GitHub issues
 * have no estimates, so there are no work item updates.
 */
export async function syncIssues(
  config: GitHubConfig,
  connection: Pick<ConnectorPluginConnection, "id" | "label" | "tenantLabel">,
  workItems: ConnectorSyncWorkItem[],
): Promise<ConnectorPluginSyncResult> {
  const client = new GitHubClient(config.apiUrl, config.token);
  const assigned = (await searchAssignedIssues(client)).filter((issue) =>
    repositoryInScope(config, issue.repository.nameWithOwner),
  );
  const found = new Set(assigned.map((issue) => issue.url));
  const missing = workItems.flatMap((workItem) => {
    const ref = found.has(workItem.sourceId) ? null : parseIssueUrl(config, workItem.sourceId);
    return ref ? [ref] : [];
  });
  const closed = (await fetchIssues(client, missing)).filter((issue) => issue.state === "CLOSED");

  return {
    items: [...assigned, ...closed].map((issue) => toCandidate(connection, issue)),
    workItemUpdates: [],
  };
}

function requireIssueRef(config: GitHubConfig, sourceId: string) {
  const ref = parseIssueUrl(config, sourceId);
  if (!ref) {
    throw new Error("This item is not an issue of the connection's GitHub instance.");
  }
  return ref;
}

async function fetchIssue(client: GitHubClient, ref: IssueRef) {
  const [owner = "", name = ""] = ref.repository.split("/");
  const data = await client.query<{ repository: { issue: GitHubIssue | null } | null }>(ISSUE_QUERY, {
    owner,
    name,
    number: ref.number,
  });
  const issue = data.repository?.issue;
  if (!issue) throw new Error(`GitHub could not find issue ${ref.repository}#${ref.number}.`);
  return issue;
}

export async function listIssueSettleStates(config: GitHubConfig, sourceId: string) {
  requireIssueRef(config, sourceId);
  return { states: ISSUE_SETTLE_STATES };
}

/** Opens or closes the issue. A priority alone writes nothing: GitHub issues have none. */
export async function writeIssueSettle(
  config: GitHubConfig,
  request: ConnectorSettleWriteRequest,
): Promise<ConnectorSettleWriteResult> {
  const ref = requireIssueRef(config, request.sourceId);
  if (request.state !== undefined && !ISSUE_SETTLE_STATES.some((state) => state.name === request.state)) {
    throw new Error(`"${request.state}" is not a GitHub issue state.`);
  }

  const client = new GitHubClient(config.apiUrl, config.token);
  let issue = await fetchIssue(client, ref);
  const target = request.state;
  if (target !== undefined && target !== stateOf(issue).state) {
    try {
      if (target === OPEN) {
        issue = (await client.query<{ reopenIssue: { issue: GitHubIssue } }>(REOPEN_MUTATION, { id: issue.id }))
          .reopenIssue.issue;
      } else {
        issue = (
          await client.query<{ closeIssue: { issue: GitHubIssue } }>(CLOSE_MUTATION, {
            id: issue.id,
            reason: target === CLOSED_NOT_PLANNED ? "NOT_PLANNED" : "COMPLETED",
          })
        ).closeIssue.issue;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`GitHub could not update the issue. The token needs write access to issues. ${detail}`);
    }
  }
  return stateOf(issue);
}
