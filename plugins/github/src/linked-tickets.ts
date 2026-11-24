import type { GitHubClient } from "./github.ts";
import { splitRepository } from "./github.ts";
import type { CodeHostLinkedTicket, CodeHostLinkedTicketsResult, CodeHostPullRequestRef } from "./contract.ts";

/*
 * The tickets a pull request is linked to, for the summary Deck shows above
 * its guide (les-cabochons/ajour#789): the issues it closes, by a closing
 * keyword or a link the author added by hand, as GitHub lists them under
 * Development. One GraphQL query, up to Ajour's 50.
 */

const MAX_TICKETS = 50;
/** Ajour's limits on a ticket's body, title and link. */
const MAX_BODY = 65_536;
const MAX_TITLE = 1_000;
const MAX_URL = 2_000;

const LINKED_TICKETS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: ${MAX_TICKETS}) {
        nodes { number title body url state repository { nameWithOwner } }
      }
    }
  }
}`;

interface GitHubLinkedIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  repository: { nameWithOwner: string } | null;
}

type LinkedTicketsData = {
  repository: {
    pullRequest: { closingIssuesReferences: { nodes: (GitHubLinkedIssue | null)[] } | null } | null;
  } | null;
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** An http or https URL Ajour accepts, or nothing. */
function linkOf(value: string) {
  if (value.length > MAX_URL) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

const STATES: Record<string, string> = { OPEN: "Open", CLOSED: "Closed" };

function toTicket(issue: GitHubLinkedIssue | null): CodeHostLinkedTicket[] {
  if (!issue) return [];
  const title = issue.title.trim();
  const url = linkOf(issue.url);
  if (!title || !url || !Number.isInteger(issue.number) || issue.number < 1) return [];
  return [
    {
      number: issue.number,
      ...(issue.repository ? { repository: issue.repository.nameWithOwner } : {}),
      title: clip(title, MAX_TITLE),
      body: clip(issue.body ?? "", MAX_BODY),
      url,
      state: STATES[issue.state] ?? "Open",
    },
  ];
}

/** The issues the pull request closes or is linked to, in GitHub's order. */
export async function readLinkedTickets(
  client: GitHubClient,
  ref: CodeHostPullRequestRef,
): Promise<CodeHostLinkedTicketsResult> {
  const [owner, name] = splitRepository(ref.repository);
  const data = await client.query<LinkedTicketsData>(LINKED_TICKETS_QUERY, { owner, name, number: ref.number });
  const pullRequest = data.repository?.pullRequest;
  if (!pullRequest) throw new Error("GitHub could not find the pull request.");
  const nodes = pullRequest.closingIssuesReferences?.nodes ?? [];
  return { tickets: nodes.flatMap(toTicket).slice(0, MAX_TICKETS) };
}
