import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginConnection } from "@ajour/plugin-sdk";
import { postComment, submitReview } from "../src/plugin.ts";
import { ALL_ACCESS, stubAzureFetch } from "./support/azure-ajour.ts";

/*
 * The writes of Deck's draft review (les-cabochons/ajour#784): a comment
 * posted at once as a thread, and a review submitted as its threads and the
 * reviewer's vote. Every request goes through the fake Ajour with the real
 * plugin.json, so the write endpoints answer only while the connection
 * turned on "Review pull requests", as Ajour's broker does.
 */

const ORG = "https://dev.azure.com/contoso";
const VIEWER = "11111111-1111-1111-1111-111111111111";
const ALICE = "22222222-2222-2222-2222-222222222222";
const PROJECT = "44444444-4444-4444-4444-444444444444";
const BASE = `${ORG}/${PROJECT}/_apis/git/repositories/repo-1/pullRequests/7`;

const viewerIdentity = { id: VIEWER, displayName: "Viewer", uniqueName: "viewer@contoso.com" };
const alice = { id: ALICE, displayName: "Alice", uniqueName: "alice@contoso.com" };
const repository = { id: "repo-1", name: "api", project: { id: PROJECT, name: "Fabrikam Web" } };
const ref = { repository: "Fabrikam Web/api", number: 7 };

const connectionData = {
  authenticatedUser: {
    id: VIEWER,
    providerDisplayName: "Viewer",
    properties: { Account: { $type: "System.String", $value: "viewer@contoso.com" } },
  },
};

const pullRequest = {
  pullRequestId: 7,
  status: "active",
  title: "Stop retries on 410",
  creationDate: "2026-11-01T10:00:00Z",
  createdBy: alice,
  reviewers: [],
  repository,
};

const WITHOUT_REVIEW = ALL_ACCESS.filter((choice) => choice !== "reviewPullRequests");

function connection(access: string[] = ALL_ACCESS): PluginConnection {
  return {
    id: "c1",
    pluginId: "azure_devops",
    label: "Work",
    tenantLabel: "Contoso",
    autoSync: true,
    autoSyncIntervalMinutes: 5,
    connectedAt: 1,
    access,
    config: { organizationUrl: ORG },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Sent {
  method: string;
  url: string;
  body?: any;
}

/**
 * Azure DevOps with the pull request, the threads it already has, and a new
 * id for each thread posted. `failVote` refuses the vote once.
 */
function azure(options: { access?: string[]; threads?: unknown[]; failVote?: boolean } = {}) {
  const sent: Sent[] = [];
  let nextThread = 100;
  let failVote = options.failVote ?? false;
  stubAzureFetch(
    async (input, init) => {
      const url = decodeURIComponent(input).replace(/\?.*$/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== "GET") sent.push({ method, url, ...(body !== undefined ? { body } : {}) });
      if (url.endsWith("/_apis/connectionData")) return json(connectionData);
      if (url.endsWith("/_apis/git/pullrequests/7")) return json(pullRequest);
      if (url === `${BASE}/threads` && method === "GET") return json({ value: options.threads ?? [] });
      if (url === `${BASE}/threads` && method === "POST") {
        const id = nextThread++;
        return json({ id, comments: [{ id: 1, ...body.comments[0] }], ...body });
      }
      if (url === `${BASE}/reviewers/${VIEWER}` && method === "PUT") {
        if (failVote) {
          failVote = false;
          return json({ message: "TF401181: The pull request is locked." }, 409);
        }
        return json({ ...viewerIdentity, vote: body.vote });
      }
      return json({ message: "not found" }, 404);
    },
    { access: options.access ?? ALL_ACCESS },
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postComment", () => {
  it("posts a thread on the head's lines, from the first one", async () => {
    const sent = azure();

    await expect(
      postComment!(connection(), {
        ...ref,
        body: "Why 410 only?",
        anchor: { path: "src/retry.ts", side: "head", line: 14, startLine: 12, headSha: "abc123" },
      }),
    ).resolves.toEqual({ commentId: "100-1" });

    expect(sent).toEqual([
      {
        method: "POST",
        url: `${BASE}/threads`,
        body: {
          comments: [{ parentCommentId: 0, content: "Why 410 only?", commentType: 1 }],
          status: 1,
          threadContext: {
            filePath: "/src/retry.ts",
            rightFileStart: { line: 12, offset: 1 },
            rightFileEnd: { line: 14, offset: 1 },
          },
        },
      },
    ]);
  });

  it("posts a thread on the base's line, or on the whole pull request without an anchor", async () => {
    const sent = azure();

    await postComment!(connection(), {
      ...ref,
      body: "This went away.",
      anchor: { path: "src/old.ts", side: "base", line: 9, headSha: "abc123" },
    });
    await postComment!(connection(), { ...ref, body: "Thanks!" });

    expect(sent.map((request) => request.body)).toEqual([
      {
        comments: [{ parentCommentId: 0, content: "This went away.", commentType: 1 }],
        status: 1,
        threadContext: {
          filePath: "/src/old.ts",
          leftFileStart: { line: 9, offset: 1 },
          leftFileEnd: { line: 9, offset: 1 },
        },
      },
      { comments: [{ parentCommentId: 0, content: "Thanks!", commentType: 1 }], status: 1 },
    ]);
  });

  it("is refused while the connection has Review pull requests off", async () => {
    const sent = azure({ access: WITHOUT_REVIEW });

    await expect(postComment!(connection(WITHOUT_REVIEW), { ...ref, body: "Thanks!" })).rejects.toThrow(
      /reviewPullRequests/,
    );
    expect(sent).toEqual([]);
  });
});

describe("submitReview", () => {
  const comments = [
    { path: "src/retry.ts", side: "head" as const, line: 14, body: "Why 410 only?" },
    { path: "src/old.ts", side: "base" as const, line: 9, body: "This went away." },
  ];

  it.each([
    ["approve", 10],
    ["request_changes", -5],
  ] as const)("posts each comment and the summary, then votes %s as %i", async (verdict, vote) => {
    const sent = azure();

    await expect(
      submitReview!(connection(), { ...ref, headSha: "abc123", verdict, body: "A few things.", comments }),
    ).resolves.toEqual({ reviewId: `7-${VIEWER}` });

    expect(sent.map((request) => `${request.method} ${request.url.replace(BASE, "")}`)).toEqual([
      "POST /threads",
      "POST /threads",
      "POST /threads",
      `PUT /reviewers/${VIEWER}`,
    ]);
    expect(sent[0]!.body.threadContext.rightFileEnd).toEqual({ line: 14, offset: 1 });
    expect(sent[1]!.body.threadContext.leftFileEnd).toEqual({ line: 9, offset: 1 });
    expect(sent[2]!.body).toEqual({
      comments: [{ parentCommentId: 0, content: "A few things.", commentType: 1 }],
      status: 1,
    });
    expect(sent[3]!.body).toEqual({ vote });
  });

  it("leaves the vote as it is for a comment", async () => {
    const sent = azure();

    await submitReview!(connection(), { ...ref, headSha: "abc123", verdict: "comment", comments });

    expect(sent.map((request) => request.method)).toEqual(["POST", "POST"]);
  });

  it("posts again only what a failed submit left out, so Retry doesn't repeat a comment", async () => {
    // The first try posted the first comment, then the vote was refused.
    const sent = azure({
      failVote: true,
      threads: [],
    });
    await expect(
      submitReview!(connection(), { ...ref, headSha: "abc123", verdict: "approve", comments }),
    ).rejects.toThrow("Azure DevOps request failed (409): TF401181: The pull request is locked.");
    expect(sent).toHaveLength(3);

    const posted = sent
      .filter((request) => request.method === "POST")
      .map((request, index) => ({
        id: 100 + index,
        status: "active",
        threadContext: request.body.threadContext,
        comments: [{ id: 1, author: viewerIdentity, content: request.body.comments[0].content, commentType: "text" }],
      }));
    const retried = azure({ threads: [...posted, { id: 5, comments: [{ id: 1, author: alice, content: "Why 410 only?" }] }] });
    await submitReview!(connection(), { ...ref, headSha: "abc123", verdict: "approve", comments });

    expect(retried.map((request) => request.method)).toEqual(["PUT"]);
  });

  it("is refused while the connection has Review pull requests off", async () => {
    const sent = azure({ access: WITHOUT_REVIEW });

    await expect(
      submitReview!(connection(WITHOUT_REVIEW), { ...ref, headSha: "abc123", verdict: "approve", comments: [] }),
    ).rejects.toThrow(/reviewPullRequests/);
    expect(sent).toEqual([]);
  });
});
