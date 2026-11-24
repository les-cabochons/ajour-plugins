import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginConnection } from "@ajour/plugin-sdk";
import { getChecks, getPullRequestConversation } from "../src/plugin.ts";
import { ALL_ACCESS, stubAzureFetch } from "./support/azure-ajour.ts";

/*
 * What Deck's review page reads beside the diff (les-cabochons/ajour#783):
 * the conversation, from the pull request's threads and iterations, and the
 * checks, from its policy evaluations. Every request goes through the fake
 * Ajour with the real plugin.json, so one the manifest does not declare is
 * refused, as Ajour's broker does.
 */

const ORG = "https://dev.azure.com/contoso";
const VIEWER = "11111111-1111-1111-1111-111111111111";
const ALICE = "22222222-2222-2222-2222-222222222222";
const PROJECT = "44444444-4444-4444-4444-444444444444";
const BUILD_POLICY = "0609b952-1397-4640-95ec-e00a01b2c241";
const REVIEWERS_POLICY = "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd";

const viewerIdentity = { id: VIEWER, displayName: "Viewer", uniqueName: "viewer@contoso.com", descriptor: "aad.v" };
const alice = { id: ALICE, displayName: "Alice", uniqueName: "alice@contoso.com", descriptor: "aad.a" };
const repository = { id: "repo-1", name: "api", project: { id: PROJECT, name: "Fabrikam Web" } };
const ref = { repository: "Fabrikam Web/api", number: 7 };

const connectionData = {
  authenticatedUser: {
    id: VIEWER,
    providerDisplayName: "Viewer",
    properties: { Account: { $type: "System.String", $value: "viewer@contoso.com" } },
  },
};

const connection: PluginConnection = {
  id: "c1",
  pluginId: "azure_devops",
  label: "Work",
  tenantLabel: "Contoso",
  autoSync: true,
  autoSyncIntervalMinutes: 5,
  connectedAt: 1,
  access: ALL_ACCESS,
  config: { organizationUrl: ORG },
};

const pullRequest = {
  pullRequestId: 7,
  status: "active",
  title: "Stop retries on 410",
  description: "## Why\n\nRetries stop on 410.",
  creationDate: "2026-11-01T10:00:00Z",
  createdBy: alice,
  reviewers: [],
  repository,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Answers a request by the first route whose key the URL contains. */
function stubFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  stubAzureFetch(async (input) => {
    const url = decodeURIComponent(input);
    calls.push(url);
    const key = Object.keys(routes).find((route) => url.includes(route));
    if (!key) return json({ message: "not found" }, 404);
    return json(routes[key]);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getPullRequestConversation", () => {
  const threads = [
    // A code thread on the head's lines 12 to 14, still open.
    {
      id: 10,
      status: "active",
      publishedDate: "2026-11-01T12:00:00Z",
      threadContext: { filePath: "/src/retry.ts", rightFileStart: { line: 12, offset: 1 }, rightFileEnd: { line: 14, offset: 4 } },
      comments: [
        { id: 1, author: alice, commentType: "text", publishedDate: "2026-11-01T12:00:00Z", content: "Why 410 only?" },
        { id: 2, author: viewerIdentity, commentType: "text", publishedDate: "2026-11-01T13:00:00Z", lastUpdatedDate: "2026-11-01T13:05:00Z", content: "It means gone." },
        { id: 3, author: alice, commentType: "text", isDeleted: true, publishedDate: "2026-11-01T13:10:00Z", content: "nvm" },
      ],
    },
    // A fixed thread on a removed line of the base.
    {
      id: 11,
      status: "fixed",
      publishedDate: "2026-11-01T11:00:00Z",
      threadContext: { filePath: "/src/old.ts", leftFileStart: { line: 3, offset: 1 }, leftFileEnd: { line: 3, offset: 9 } },
      comments: [{ id: 1, author: alice, commentType: "text", publishedDate: "2026-11-01T11:00:00Z", content: "Gone now." }],
    },
    // A comment on the whole file, and one on the whole pull request.
    {
      id: 12,
      status: "active",
      publishedDate: "2026-11-01T11:30:00Z",
      threadContext: { filePath: "/README.md" },
      comments: [{ id: 1, author: alice, commentType: "text", publishedDate: "2026-11-01T11:30:00Z", content: "Mention it here." }],
    },
    {
      id: 13,
      status: "active",
      publishedDate: "2026-11-01T14:00:00Z",
      comments: [{ id: 1, author: alice, commentType: "text", publishedDate: "2026-11-01T14:00:00Z", content: "Ready for another look." }],
    },
    // A vote, a push and another system message.
    {
      id: 14,
      publishedDate: "2026-11-01T15:00:00Z",
      properties: {
        CodeReviewThreadType: { $value: "VoteUpdate" },
        CodeReviewVoteResult: { $value: "10" },
        CodeReviewVotedByIdentity: { $value: "1" },
      },
      identities: { "1": viewerIdentity },
      comments: [{ id: 1, commentType: "system", publishedDate: "2026-11-01T15:00:00Z", content: "Viewer voted 10" }],
    },
    {
      id: 15,
      publishedDate: "2026-11-01T10:30:00Z",
      properties: { CodeReviewThreadType: { $value: "RefUpdate" } },
      comments: [{ id: 1, commentType: "system", publishedDate: "2026-11-01T10:30:00Z", content: "Alice updated the source branch" }],
    },
    {
      id: 16,
      publishedDate: "2026-11-01T10:40:00Z",
      properties: { CodeReviewThreadType: { $value: "ReviewersUpdate" } },
      comments: [{ id: 1, commentType: "system", publishedDate: "2026-11-01T10:40:00Z", content: "Alice added Viewer as a reviewer" }],
    },
    { id: 17, isDeleted: true, publishedDate: "2026-11-01T16:00:00Z", comments: [{ id: 1, author: alice, content: "deleted" }] },
  ];

  it("returns the description, a timeline oldest first, and each code thread on its lines", async () => {
    const calls = stubFetch({
      "_apis/connectionData": connectionData,
      "pullRequests/7/iterations": {
        value: [
          { id: 2, createdDate: "2026-11-01T10:30:00Z", author: alice, push: { date: "2026-11-01T10:30:00Z", pushedBy: alice } },
          { id: 1, createdDate: "2026-11-01T10:00:00Z", author: alice },
        ],
      },
      "pullRequests/7/threads": { value: threads },
      "_apis/git/pullrequests/7": pullRequest,
    });

    const conversation = await getPullRequestConversation(connection, ref);

    expect(conversation.description).toBe("## Why\n\nRetries stop on 410.");
    expect(conversation.viewedPaths).toEqual([]);
    expect(conversation.mergeMethods).toEqual(["merge", "squash", "rebase"]);
    expect(conversation.threads).toEqual([
      {
        id: "10",
        path: "src/retry.ts",
        side: "head",
        line: 14,
        startLine: 12,
        resolved: false,
        outdated: false,
        comments: [
          { id: "10-1", author: { login: "alice@contoso.com", displayName: "Alice", isBot: false }, body: "Why 410 only?", createdAt: Date.parse("2026-11-01T12:00:00Z") },
          {
            id: "10-2",
            author: { login: "viewer@contoso.com", displayName: "Viewer", isBot: false },
            body: "It means gone.",
            createdAt: Date.parse("2026-11-01T13:00:00Z"),
            updatedAt: Date.parse("2026-11-01T13:05:00Z"),
          },
        ],
      },
      { id: "11", path: "src/old.ts", side: "base", line: 3, resolved: true, outdated: false, comments: [expect.objectContaining({ body: "Gone now." })] },
      { id: "12", path: "README.md", side: "head", resolved: false, outdated: false, comments: [expect.objectContaining({ body: "Mention it here." })] },
    ]);
    expect(
      conversation.timeline.map((event) => [event.kind, "text" in event ? event.text : "body" in event ? event.body : event.headline]),
    ).toEqual([
      ["event", "opened this pull request"],
      ["event", "pushed iteration 1"],
      ["event", "pushed iteration 2"],
      ["event", "Alice added Viewer as a reviewer"],
      ["comment", "Ready for another look."],
      ["review", ""],
    ]);
    expect(conversation.timeline[0]).toMatchObject({ actor: { login: "alice@contoso.com" } });
    expect(conversation.timeline.at(-1)).toMatchObject({ kind: "review", verdict: "approved", author: { login: "viewer@contoso.com" } });
    // Thread positions are tracked to the latest iteration.
    expect(calls.find((url) => url.includes("/threads"))).toContain("$iteration=2&$baseIteration=0");
  });

  it("fails when Azure DevOps doesn't find the pull request", async () => {
    stubFetch({ "_apis/connectionData": connectionData });

    await expect(getPullRequestConversation(connection, ref)).rejects.toThrow("Azure DevOps could not find the pull request.");
  });
});

describe("getChecks", () => {
  it("returns each enabled policy with its state, a build linking to its run", async () => {
    const calls = stubFetch({
      "_apis/git/pullrequests/7": pullRequest,
      "_apis/policy/evaluations": {
        value: [
          { status: "approved", configuration: { isEnabled: true, type: { id: BUILD_POLICY, displayName: "Build" }, settings: { displayName: "CI build" } }, context: { buildId: 42 } },
          { status: "running", configuration: { isEnabled: true, type: { id: BUILD_POLICY, displayName: "Build" }, settings: { displayName: null } }, context: null },
          { status: "rejected", configuration: { isEnabled: true, type: { id: REVIEWERS_POLICY, displayName: "Minimum number of reviewers" }, settings: {} } },
          { status: "notApplicable", configuration: { isEnabled: true, type: { id: "x", displayName: "Work item linking" } } },
          { status: "queued", configuration: { isEnabled: false, type: { id: "y", displayName: "Turned off" } } },
          { status: "broken", configuration: { type: { id: "z", displayName: "Status" } } },
        ],
      },
    });

    await expect(getChecks(connection, ref)).resolves.toEqual({
      checks: [
        { name: "CI build", state: "success", url: `${ORG}/Fabrikam%20Web/_build/results?buildId=42` },
        { name: "Build", state: "pending" },
        { name: "Minimum number of reviewers", state: "failure" },
        { name: "Work item linking", state: "skipped" },
        { name: "Status", state: "failure" },
      ],
    });
    expect(calls.some((url) => url.includes(`artifactId=vstfs:///CodeReview/CodeReviewId/${PROJECT}/7`))).toBe(true);
  });
});
