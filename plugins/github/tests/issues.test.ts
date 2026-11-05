import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGitHubConfig } from "../src/config.ts";
import { pluginConnection, stubGitHub as stubGraphQL } from "./support/github-ajour.ts";
import { ISSUE_SETTLE_STATES, parseIssueUrl, syncIssues, writeIssueSettle } from "../src/issues.ts";

const config = buildGitHubConfig(pluginConnection({ exclude: "acme/legacy" }));
const connection = { id: "connection-1", label: "Work", tenantLabel: "Acme" };

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `I_${number}`,
    number,
    url: `https://github.com/acme/api/issues/${number}`,
    title: `Issue ${number}`,
    body: "  Steps to reproduce  ",
    state: "OPEN",
    stateReason: null,
    repository: { nameWithOwner: "acme/api" },
    assignees: { nodes: [{ login: "octocat" }] },
    ...overrides,
  };
}

function stubGitHub(handler: (call: { query: string; variables: Record<string, unknown> }) => unknown) {
  return stubGraphQL(handler).calls;
}

function searchResult(nodes: unknown[]) {
  return { search: { issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseIssueUrl", () => {
  it("reads issues of the connection's instance only", () => {
    expect(parseIssueUrl(config, "https://github.com/acme/api/issues/12")).toEqual({
      repository: "acme/api",
      number: 12,
    });
    expect(parseIssueUrl(config, "https://github.acme.com/acme/api/issues/12")).toBeNull();
    expect(parseIssueUrl(config, "https://github.com/acme/api/pull/12")).toBeNull();
    expect(parseIssueUrl(config, "not a url")).toBeNull();
  });
});

describe("syncIssues", () => {
  it("returns assigned open issues in scope and tracked issues that closed", async () => {
    const calls = stubGitHub((call) => {
      if (call.query.includes("search(")) {
        return searchResult([issue(1), issue(2, { repository: { nameWithOwner: "acme/legacy" }, url: "https://github.com/acme/legacy/issues/2" })]);
      }
      return {
        i0: { issue: issue(3, { state: "CLOSED", stateReason: "NOT_PLANNED" }) },
        i1: { issue: issue(4) },
      };
    });

    const result = await syncIssues(config, connection, [
      { localWorkItemId: "w1", sourceId: "https://github.com/acme/api/issues/1" },
      { localWorkItemId: "w3", sourceId: "https://github.com/acme/api/issues/3" },
      { localWorkItemId: "w4", sourceId: "https://github.com/acme/api/issues/4" },
      { localWorkItemId: "w5", sourceId: "https://dev.azure.com/contoso/_workitems/edit/5" },
    ]);

    expect(calls[0]?.variables.q).toBe("is:issue is:open assignee:@me archived:false");
    expect(calls[1]?.variables).toMatchObject({ o0: "acme", r0: "api", n0: 3, n1: 4 });
    expect(result.workItemUpdates).toEqual([]);
    expect(result.items).toEqual([
      {
        source: "github",
        connectionId: "connection-1",
        connectionLabel: "Work",
        tenantLabel: "Acme",
        sourceId: "https://github.com/acme/api/issues/1",
        externalId: "acme/api#1",
        sourceUrl: "https://github.com/acme/api/issues/1",
        title: "Issue 1",
        note: "Steps to reproduce",
        description: { text: "  Steps to reproduce" },
        projectName: "acme/api",
        workItemType: "Issue",
        state: "Open",
        stateCategory: "Open",
        stateDone: false,
        assignedTo: "octocat",
        depth: 0,
        selectable: true,
        selected: true,
        childCount: 0,
      },
      expect.objectContaining({
        sourceId: "https://github.com/acme/api/issues/3",
        state: "Closed as not planned",
        stateCategory: "Closed",
        stateDone: true,
        selectable: false,
      }),
    ]);
  });

  it("posts each query to the graphql host as JSON, with the headers the manifest lists and no credential", async () => {
    const { requests } = stubGraphQL(() => searchResult([issue(1)]));

    await syncIssues(config, connection, []);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      host: "graphql",
      method: "POST",
      path: "/graphql",
      contentType: "application/json",
      headers: { accept: "application/vnd.github+json", "user-agent": "ajour-github-plugin" },
      body: { variables: { q: "is:issue is:open assignee:@me archived:false" } },
    });
    expect(requests[0]!.query).toBeUndefined();
    expect(Object.keys(requests[0]!.headers).sort()).toEqual(["accept", "content-type", "user-agent"]);
  });

  it("refuses a search over GitHub's result limit", async () => {
    stubGitHub(() => ({ search: { ...searchResult([]).search, issueCount: 1001 } }));

    await expect(syncIssues(config, connection, [])).rejects.toThrow(/1,000/);
  });
});

describe("writeIssueSettle", () => {
  it("closes an open issue as not planned", async () => {
    const calls = stubGitHub((call) => {
      if (call.query.includes("closeIssue")) {
        return { closeIssue: { issue: issue(7, { state: "CLOSED", stateReason: "NOT_PLANNED" }) } };
      }
      return { repository: { issue: issue(7) } };
    });

    await expect(
      writeIssueSettle(config, { sourceId: "https://github.com/acme/api/issues/7", state: "Closed as not planned" }),
    ).resolves.toEqual({ state: "Closed as not planned", stateCategory: "Closed", stateDone: true });
    expect(calls[1]?.variables).toEqual({ id: "I_7", reason: "NOT_PLANNED" });
  });

  it("reopens a closed issue", async () => {
    const calls = stubGitHub((call) =>
      call.query.includes("reopenIssue")
        ? { reopenIssue: { issue: issue(7) } }
        : { repository: { issue: issue(7, { state: "CLOSED", stateReason: "COMPLETED" }) } },
    );

    await expect(
      writeIssueSettle(config, { sourceId: "https://github.com/acme/api/issues/7", state: "Open" }),
    ).resolves.toEqual({ state: "Open", stateCategory: "Open", stateDone: false });
    expect(calls).toHaveLength(2);
  });

  it("writes nothing for a priority alone, or a state the issue already has", async () => {
    const calls = stubGitHub(() => ({ repository: { issue: issue(7) } }));

    await writeIssueSettle(config, { sourceId: "https://github.com/acme/api/issues/7", priority: "high" });
    await writeIssueSettle(config, { sourceId: "https://github.com/acme/api/issues/7", state: "Open" });

    expect(calls.every((call) => !call.query.includes("mutation"))).toBe(true);
  });

  it("rejects unknown states and foreign items", async () => {
    await expect(
      writeIssueSettle(config, { sourceId: "https://github.com/acme/api/issues/7", state: "Done" }),
    ).rejects.toThrow(/not a GitHub issue state/);
    await expect(
      writeIssueSettle(config, { sourceId: "https://github.acme.com/acme/api/issues/7", state: "Open" }),
    ).rejects.toThrow(/not an issue/);
  });

  it("offers open and both closed states", () => {
    expect(ISSUE_SETTLE_STATES.map((state) => [state.name, state.done])).toEqual([
      ["Open", false],
      ["Closed", true],
      ["Closed as not planned", true],
    ]);
  });
});
