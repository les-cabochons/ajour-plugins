import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginConnection } from "@ajour/plugin-sdk";
import * as plugin from "../src/plugin.ts";
import { ALL_ACCESS, stubAzureFetch } from "./support/azure-ajour.ts";

/*
 * The rest of a review round from Deck (les-cabochons/ajour#785) on Azure
 * DevOps: a reply at the end of a thread and a thread resolved or
 * unresolved. Azure DevOps keeps no per-file viewed state, so the plugin
 * doesn't offer setFileViewed and Ajour keeps viewed marks on the computer.
 * Every request goes through the fake Ajour with the real plugin.json.
 */

const { replyToThread, setThreadResolved, getPullRequestConversation } = plugin;

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

const FIRST_TRY = Date.parse("2026-11-26T10:00:00Z");
const at = (minutes: number) => new Date(FIRST_TRY + minutes * 60_000).toISOString();

type Comment = { id: number; author?: typeof alice; content?: string; publishedDate?: string; commentType?: string; isDeleted?: boolean };

const opening: Comment = { id: 1, author: alice, content: "Why 410 only?", publishedDate: at(-60), commentType: "text" };

/** Azure DevOps with the pull request and thread 5, holding `comments`. */
function azure(options: { access?: string[]; comments?: Comment[]; status?: string } = {}) {
  const sent: Sent[] = [];
  const comments = options.comments ?? [opening];
  stubAzureFetch(
    async (input, init) => {
      const url = decodeURIComponent(input).replace(/\?.*$/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== "GET") sent.push({ method, url, ...(body !== undefined ? { body } : {}) });
      if (url.endsWith("/_apis/connectionData")) return json(connectionData);
      if (url.endsWith("/_apis/git/pullrequests/7")) return json(pullRequest);
      if (url === `${BASE}/iterations`) return json({ value: [{ id: 1, sourceRefCommit: { commitId: "abc123" } }] });
      if (url === `${BASE}/threads` && method === "GET")
        return json({
          value: [
            { id: 4, status: "active", comments: [{ ...opening, id: 1 }] },
            { id: 5, status: options.status ?? "active", comments },
          ],
        });
      if (url === `${BASE}/threads/5/comments` && method === "POST")
        return json({ id: comments.length + 1, ...body, author: viewerIdentity });
      if (url === `${BASE}/threads/5` && method === "PATCH") return json({ id: 5, status: body.status, comments });
      return json({ message: "not found" }, 404);
    },
    { access: options.access ?? ALL_ACCESS },
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("replyToThread", () => {
  it("adds a comment at the end of the thread, under its first one", async () => {
    const sent = azure();

    await expect(
      replyToThread!(connection(), { ...ref, threadId: "5", body: "Fixed in the next push.", submissionId: "reply_1" }),
    ).resolves.toEqual({ commentId: "5-2" });

    expect(sent).toEqual([
      {
        method: "POST",
        url: `${BASE}/threads/5/comments`,
        body: { parentCommentId: 1, content: "Fixed in the next push.", commentType: 1 },
      },
    ]);
  });

  it("says so when the pull request has no such thread", async () => {
    const sent = azure();

    await expect(replyToThread!(connection(), { ...ref, threadId: "9", body: "Hm." })).rejects.toThrow(
      "Azure DevOps could not find the review thread.",
    );
    expect(sent).toEqual([]);
  });

  it("is refused while the connection has Review pull requests off", async () => {
    const sent = azure({ access: WITHOUT_REVIEW });

    await expect(replyToThread!(connection(WITHOUT_REVIEW), { ...ref, threadId: "5", body: "Hm." })).rejects.toThrow(
      /reviewPullRequests/,
    );
    expect(sent).toEqual([]);
  });

  describe("a retry, with no mark to find", () => {
    const retry = { ...ref, threadId: "5", body: "Fixed.", submissionId: "reply_1", firstTriedAt: FIRST_TRY };

    it("can't tell, and posts nothing, when the thread holds a comment of the user's from around the first try on", async () => {
      // A clock two minutes ahead of Azure DevOps's still counts.
      const sent = azure({
        comments: [opening, { id: 2, author: viewerIdentity, content: "Fixed.", publishedDate: at(-1), commentType: "text" }],
      });

      await expect(replyToThread!(connection(), retry)).resolves.toEqual({ uncertain: true });
      expect(sent).toEqual([]);
    });

    it.each([
      ["someone else's", { id: 2, author: alice, content: "Fixed.", publishedDate: at(1), commentType: "text" }],
      ["the user's from before the first try", { id: 2, author: viewerIdentity, content: "Earlier.", publishedDate: at(-30), commentType: "text" }],
      ["the user's deleted one", { id: 2, author: viewerIdentity, content: "", publishedDate: at(1), commentType: "text", isDeleted: true }],
    ])("posts beside %s comment", async (_, existing) => {
      const sent = azure({ comments: [opening, existing] });

      await expect(replyToThread!(connection(), retry)).resolves.toEqual({ commentId: "5-3" });
      expect(sent).toHaveLength(1);
    });
  });
});

describe("setThreadResolved", () => {
  it.each([
    [true, "fixed"],
    [false, "active"],
  ] as const)("resolved %s sets the thread's status to %s", async (resolved, status) => {
    const sent = azure({ status: resolved ? "active" : "fixed" });

    await expect(setThreadResolved!(connection(), { ...ref, threadId: "5", resolved })).resolves.toEqual({ resolved });
    expect(sent).toEqual([{ method: "PATCH", url: `${BASE}/threads/5`, body: { status } }]);
  });

  it("is refused while the connection has Review pull requests off", async () => {
    const sent = azure({ access: WITHOUT_REVIEW });

    await expect(
      setThreadResolved!(connection(WITHOUT_REVIEW), { ...ref, threadId: "5", resolved: true }),
    ).rejects.toThrow(/reviewPullRequests/);
    expect(sent).toEqual([]);
  });
});

describe("viewed files", () => {
  it("are a host without per-file viewed state: no setFileViewed, and no viewed paths read", async () => {
    expect("setFileViewed" in plugin).toBe(false);
    azure();
    const conversation = await getPullRequestConversation!(connection(), ref);
    expect(conversation.viewedPaths).toEqual([]);
  });
});
