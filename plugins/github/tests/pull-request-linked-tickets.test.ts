import { afterEach, describe, expect, it, vi } from "vitest";
import { getLinkedTickets } from "../src/plugin.ts";
import { pluginConnection, stubGitHub, type GraphQLCall } from "./support/github-ajour.ts";

/*
 * The tickets a pull request is linked to, for Deck's summary
 * (les-cabochons/ajour#789). Every request goes through the fake Ajour with
 * the real plugin.json, so one the manifest does not declare is refused.
 */

const connection = pluginConnection();
const ref = { repository: "acme/api", number: 7 };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Answers the linked tickets query with `nodes` and the description `body`,
 * or a missing pull request, and the issues query by `issues`.
 */
function ticketsGitHub(
  nodes: unknown[] | null,
  { body = "", issues = () => ({}) }: { body?: string; issues?: (call: GraphQLCall) => unknown } = {},
) {
  return stubGitHub((call) => {
    if (call.query.includes("issueOrPullRequest")) return issues(call);
    return {
      repository: {
        pullRequest: nodes === null ? null : { body, closingIssuesReferences: { nodes } },
      },
    };
  });
}

const issue = (number: number, repository = "acme/api") => ({
  __typename: "Issue",
  number,
  title: `Issue ${number}`,
  body: "",
  url: `https://github.com/${repository}/issues/${number}`,
  state: "OPEN",
  repository: { nameWithOwner: repository },
});

describe("getLinkedTickets", () => {
  it("returns each issue the pull request closes or is linked to, with its title, body, link and state", async () => {
    const { calls } = ticketsGitHub([
      {
        number: 482,
        title: " Retries never stop on 410 ",
        body: "## Steps\n\nCall it twice.",
        url: "https://github.com/acme/api/issues/482",
        state: "OPEN",
        repository: { nameWithOwner: "acme/api" },
      },
      {
        number: 12,
        title: "Show the retries",
        body: null,
        url: "https://github.com/acme/web/issues/12",
        state: "CLOSED",
        repository: { nameWithOwner: "acme/web" },
      },
      // GitHub hides an issue the token can't read.
      null,
      { number: 13, title: "  ", body: "", url: "https://github.com/acme/api/issues/13", state: "OPEN", repository: null },
    ]);

    await expect(getLinkedTickets(connection, ref)).resolves.toEqual({
      tickets: [
        {
          number: 482,
          repository: "acme/api",
          title: "Retries never stop on 410",
          body: "## Steps\n\nCall it twice.",
          url: "https://github.com/acme/api/issues/482",
          state: "Open",
        },
        {
          number: 12,
          repository: "acme/web",
          title: "Show the retries",
          body: "",
          url: "https://github.com/acme/web/issues/12",
          state: "Closed",
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain("closingIssuesReferences(first: 50)");
    expect(calls[0]!.variables).toEqual({ owner: "acme", name: "api", number: 7 });
  });

  it("cuts a body longer than Ajour takes", async () => {
    ticketsGitHub([
      {
        number: 1,
        title: "Long",
        body: "x".repeat(70_000),
        url: "https://github.com/acme/api/issues/1",
        state: "OPEN",
        repository: { nameWithOwner: "acme/api" },
      },
    ]);

    const { tickets } = await getLinkedTickets(connection, ref);
    expect(tickets[0]!.body).toHaveLength(65_536);
  });

  it("returns no tickets when none is linked", async () => {
    const { calls } = ticketsGitHub([], { body: "Retries stop on 410." });

    await expect(getLinkedTickets(connection, ref)).resolves.toEqual({ tickets: [] });
    expect(calls).toHaveLength(1);
  });

  it("reads the issues a stacked pull request's description closes, which GitHub doesn't link off the default branch", async () => {
    const { calls } = ticketsGitHub([], {
      body: "Fixes #12, closes acme/web#3 and resolves #9.\n\nFixes #12 again. See #4.",
      issues: () => ({
        t0: { issueOrPullRequest: issue(12) },
        t1: { issueOrPullRequest: issue(3, "acme/web") },
        // A pull request's number isn't a ticket.
        t2: { issueOrPullRequest: { __typename: "PullRequest" } },
      }),
    });

    const { tickets } = await getLinkedTickets(connection, ref);

    expect(tickets.map((ticket) => `${ticket.repository}#${ticket.number}`)).toEqual(["acme/api#12", "acme/web#3"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.variables).toEqual({ o0: "acme", n0: "api", i0: 12, o1: "acme", n1: "web", i1: 3, o2: "acme", n2: "api", i2: 9 });
  });

  it("returns no tickets when the issues a description names can't be read", async () => {
    ticketsGitHub([], { body: "Fixes #12.", issues: () => new Error("Could not resolve to an issue or pull request.") });

    await expect(getLinkedTickets(connection, ref)).resolves.toEqual({ tickets: [] });
  });

  it("fails when GitHub doesn't find the pull request", async () => {
    ticketsGitHub(null);

    await expect(getLinkedTickets(connection, ref)).rejects.toThrow("GitHub could not find the pull request.");
  });
});
