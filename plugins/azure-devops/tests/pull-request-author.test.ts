import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginConnection } from "@ajour/plugin-sdk";
import { getPullRequestConversation, mergePullRequest, updatePullRequest } from "../src/plugin.ts";
import { ALL_ACCESS, stubAzureFetch } from "./support/azure-ajour.ts";

/*
 * The author's actions (les-cabochons/ajour#786): the title, draft and
 * publish, and completing the pull request with a merge strategy. Every
 * request goes through the fake Ajour with the real plugin.json, so the
 * writes answer only while the connection turned on "Review pull requests",
 * as Ajour's broker does.
 */

const ORG = "https://dev.azure.com/contoso";
const PROJECT = "44444444-4444-4444-4444-444444444444";
const BASE = `${ORG}/${PROJECT}/_apis/git/repositories/repo-1/pullRequests/7`;
const POLICIES = `${ORG}/${PROJECT}/_apis/git/policy/configurations`;
const MERGE_STRATEGY = "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab";
const alice = { id: "22222222-2222-2222-2222-222222222222", displayName: "Alice", uniqueName: "alice@contoso.com" };
const repository = { id: "repo-1", name: "api", project: { id: PROJECT, name: "Fabrikam Web" } };
const ref = { repository: "Fabrikam Web/api", number: 7 };
const connectionData = {
  authenticatedUser: {
    id: "11111111-1111-1111-1111-111111111111",
    providerDisplayName: "Viewer",
    properties: { Account: { $type: "System.String", $value: "viewer@contoso.com" } },
  },
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
  query?: Record<string, string>;
  body?: any;
}

interface Pull {
  status: "active" | "completed" | "abandoned";
  isDraft: boolean;
  title: string;
  head: string;
  mergeCommit?: string;
  /** Azure DevOps took the completion and is still merging. */
  queued?: boolean;
}

/**
 * Azure DevOps holding one pull request into main, the branch's policies,
 * and the threads and iterations a conversation reads. `complete` answers
 * the completion instead, after the pull request changed as it says.
 */
function azure(
  start: Partial<Pull> = {},
  options: {
    access?: string[];
    policies?: unknown[] | "refused";
    complete?: (pull: Pull, body: any) => Response;
  } = {},
) {
  const pull: Pull = { status: "active", isDraft: false, title: "Stop retries on 410", head: "abc123", ...start };
  const sent: Sent[] = [];
  const answer = () => ({
    pullRequestId: 7,
    status: pull.status,
    isDraft: pull.isDraft,
    title: pull.title,
    creationDate: "2026-11-01T10:00:00Z",
    createdBy: alice,
    reviewers: [],
    targetRefName: "refs/heads/main",
    lastMergeSourceCommit: { commitId: pull.head },
    ...(pull.mergeCommit ? { lastMergeCommit: { commitId: pull.mergeCommit } } : {}),
    ...(pull.queued ? { mergeStatus: "queued" } : {}),
    repository,
  });
  stubAzureFetch(
    async (input, init) => {
      const [address, search = ""] = decodeURIComponent(input).split("?");
      const url = address!;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({
        method,
        url,
        ...(url === POLICIES ? { query: Object.fromEntries(new URLSearchParams(search)) } : {}),
        ...(body !== undefined ? { body } : {}),
      });
      if (url.endsWith("/_apis/connectionData")) return json(connectionData);
      if (url.endsWith("/_apis/git/pullrequests/7")) return json(answer());
      if (url === `${BASE}/threads`) return json({ value: [] });
      if (url === `${BASE}/iterations`) return json({ value: [] });
      if (url === POLICIES) {
        if (options.policies === "refused") return json({ message: "TF401027: You need the Git 'Read' permission." }, 403);
        return json({ value: options.policies ?? [] });
      }
      if (url === BASE && method === "PATCH") {
        if (body.status === "completed") {
          if (options.complete) return options.complete(pull, body);
          if (body.lastMergeSourceCommit?.commitId !== pull.head) {
            return json({ message: "TF401192: The pull request's source branch was updated." }, 409);
          }
          pull.status = "completed";
          pull.mergeCommit = "merge789";
          return json(answer());
        }
        if (body.title !== undefined) pull.title = body.title;
        if (body.isDraft !== undefined) pull.isDraft = body.isDraft;
        return json(answer());
      }
      return json({ message: "not found" }, 404);
    },
    { access: options.access ?? ALL_ACCESS },
  );
  return { pull, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const writes = (sent: Sent[]) => sent.filter((request) => request.method !== "GET");

describe("updatePullRequest", () => {
  it("edits the title, and answers with the title and draft state Azure DevOps holds", async () => {
    const { sent } = azure();

    await expect(updatePullRequest!(connection(), { ...ref, title: "Stop retrying on 410 and 404" })).resolves.toEqual({
      title: "Stop retrying on 410 and 404",
      draft: false,
    });
    expect(writes(sent)).toEqual([{ method: "PATCH", url: BASE, body: { title: "Stop retrying on 410 and 404" } }]);
  });

  it.each([
    [false, true],
    [true, false],
  ])("turns a pull request whose draft state is %s to %s", async (from, to) => {
    const { sent, pull } = azure({ isDraft: from });

    await expect(updatePullRequest!(connection(), { ...ref, draft: to })).resolves.toEqual({
      title: "Stop retries on 410",
      draft: to,
    });
    expect(writes(sent)).toEqual([{ method: "PATCH", url: BASE, body: { isDraft: to } }]);
    expect(pull.isDraft).toBe(to);
  });

  it("sends the title and the draft state in one update", async () => {
    const { sent } = azure({ isDraft: true });

    await updatePullRequest!(connection(), { ...ref, title: "Ready now", draft: false });
    expect(writes(sent)).toEqual([{ method: "PATCH", url: BASE, body: { title: "Ready now", isDraft: false } }]);
  });

  it("is refused while the connection has Review pull requests off", async () => {
    const { sent } = azure({}, { access: WITHOUT_REVIEW });

    await expect(updatePullRequest!(connection(WITHOUT_REVIEW), { ...ref, title: "New" })).rejects.toThrow(
      /reviewPullRequests/,
    );
    expect(writes(sent)).toEqual([]);
  });
});

describe("mergePullRequest", () => {
  it.each([
    ["merge", "noFastForward"],
    ["squash", "squash"],
  ] as const)("completes with %s as Azure DevOps's %s, at the head the user saw, with the commit message", async (method, strategy) => {
    const { sent } = azure();

    await expect(
      mergePullRequest!(connection(), {
        ...ref,
        method,
        headSha: "abc123",
        commitTitle: "Merged PR 7: Stop retries on 410",
        commitMessage: "Retries stop at the first 410.",
      }),
    ).resolves.toEqual({ mergeCommitSha: "merge789" });
    expect(writes(sent)).toEqual([
      {
        method: "PATCH",
        url: BASE,
        body: {
          status: "completed",
          lastMergeSourceCommit: { commitId: "abc123" },
          completionOptions: {
            mergeStrategy: strategy,
            mergeCommitMessage: "Merged PR 7: Stop retries on 410\n\nRetries stop at the first 410.",
          },
        },
      },
    ]);
  });

  it("rebases and fast-forwards with no commit message, which a rebase has no commit for", async () => {
    const { sent } = azure();

    await mergePullRequest!(connection(), { ...ref, method: "rebase", headSha: "abc123", commitTitle: "Ignored" });
    expect(writes(sent)[0]!.body.completionOptions).toEqual({ mergeStrategy: "rebase" });
  });

  it("answers without a merge commit while Azure DevOps is still completing it", async () => {
    azure({}, { complete: (pull) => json({ ...pullAnswer(pull), status: "active", mergeStatus: "queued" }) });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).resolves.toEqual({});
  });

  it.each([
    ["conflicts", "Azure DevOps couldn't merge it: the source and target branches conflict."],
    ["rejectedByPolicy", "Azure DevOps couldn't merge it: a branch policy refused the merge."],
    ["failure", "Azure DevOps couldn't merge it."],
  ])("fails when Azure DevOps answers the completion with %s", async (mergeStatus, message) => {
    azure({}, { complete: (pull) => json({ ...pullAnswer(pull), status: "active", mergeStatus }) });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).rejects.toThrow(
      message,
    );
  });

  it("answers without a merge commit when a lost answer left the completion queued", async () => {
    azure({}, {
      complete: (current) => {
        current.queued = true;
        return json({ message: "TF400898: An internal error occurred." }, 500);
      },
    });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).resolves.toEqual({});
  });

  it("refuses a head the pull request moved on from, and completes nothing", async () => {
    const { sent } = azure({ head: "newer" });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).rejects.toThrow(
      "The pull request has new commits since you read it. Refresh to review them before merging.",
    );
    expect(writes(sent)).toEqual([]);
  });

  it("refuses a push that lands between the check and the completion, as Azure DevOps does with the head", async () => {
    const { pull } = azure({}, {
      complete: (current, body) => {
        current.head = "newer";
        return body.lastMergeSourceCommit.commitId === current.head
          ? json(pullAnswer(current))
          : json({ message: "TF401192: The pull request's source branch was updated." }, 409);
      },
    });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).rejects.toThrow(
      "Azure DevOps request failed (409): TF401192: The pull request's source branch was updated.",
    );
    expect(pull.status).toBe("active");
  });

  it("refuses a draft, which Azure DevOps can't complete", async () => {
    const { sent } = azure({ isDraft: true });

    await expect(mergePullRequest!(connection(), { ...ref, method: "merge", headSha: "abc123" })).rejects.toThrow(
      "This pull request is a draft. Publish it to merge it.",
    );
    expect(writes(sent)).toEqual([]);
  });

  it("refuses an abandoned pull request", async () => {
    azure({ status: "abandoned" });

    await expect(mergePullRequest!(connection(), { ...ref, method: "merge", headSha: "abc123" })).rejects.toThrow(
      "This pull request was abandoned.",
    );
  });

  it("answers a retry after a lost answer with the merge Azure DevOps already made, and completes nothing again", async () => {
    const { sent } = azure({ status: "completed", mergeCommit: "merge789" });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).resolves.toEqual({
      mergeCommitSha: "merge789",
    });
    expect(writes(sent)).toEqual([]);
  });

  it("says a pull request completed at another head was merged without the user's merge", async () => {
    azure({ status: "completed", head: "newer", mergeCommit: "merge789" });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).rejects.toThrow(
      "This pull request was already merged, with commits you didn't read.",
    );
  });

  it("finds the merge Azure DevOps made when its answer failed", async () => {
    const { sent } = azure({}, {
      complete: (current) => {
        current.status = "completed";
        current.mergeCommit = "merge789";
        return json({ message: "TF400898: An internal error occurred." }, 500);
      },
    });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).resolves.toEqual({
      mergeCommitSha: "merge789",
    });
    expect(sent.filter((request) => request.url.endsWith("/_apis/git/pullrequests/7"))).toHaveLength(2);
  });

  it("keeps Azure DevOps's reason when the completion failed and nothing merged", async () => {
    azure({}, {
      complete: () => json({ message: "TF402455: Pushes to this branch are not permitted; you must use a pull request." }, 400),
    });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).rejects.toThrow(
      "Azure DevOps request failed (400): TF402455",
    );
  });

  it("is refused while the connection has Review pull requests off", async () => {
    const { sent } = azure({}, { access: WITHOUT_REVIEW });

    await expect(
      mergePullRequest!(connection(WITHOUT_REVIEW), { ...ref, method: "squash", headSha: "abc123" }),
    ).rejects.toThrow(/reviewPullRequests/);
    expect(writes(sent)).toEqual([]);
  });
});

/** The pull request as Azure DevOps answers it, for a custom completion. */
function pullAnswer(pull: Pull) {
  return {
    pullRequestId: 7,
    status: pull.status,
    isDraft: pull.isDraft,
    title: pull.title,
    creationDate: "2026-11-01T10:00:00Z",
    createdBy: alice,
    targetRefName: "refs/heads/main",
    lastMergeSourceCommit: { commitId: pull.head },
    ...(pull.mergeCommit ? { lastMergeCommit: { commitId: pull.mergeCommit } } : {}),
    repository,
  };
}

describe("the merge methods a conversation offers", () => {
  const policy = (settings: Record<string, unknown>, fields: Record<string, unknown> = {}) => ({
    isEnabled: true,
    isBlocking: true,
    type: { id: MERGE_STRATEGY },
    settings: { ...settings, scope: [{ repositoryId: "repo-1", refName: "refs/heads/main", matchKind: "exact" }] },
    ...fields,
  });
  const methods = async () => (await getPullRequestConversation!(connection(), ref)).mergeMethods;

  it("reads the merge strategy policy on the target branch", async () => {
    const { sent } = azure({}, { policies: [policy({ allowSquash: true, allowRebase: true })] });

    await expect(methods()).resolves.toEqual(["squash", "rebase"]);
    expect(sent.find((request) => request.url === POLICIES)?.query).toEqual({
      repositoryId: "repo-1",
      refName: "refs/heads/main",
      policyType: MERGE_STRATEGY,
      "api-version": "7.1",
    });
  });

  it.each([
    [{ allowNoFastForward: true }, ["merge"]],
    [{ allowSquash: true }, ["squash"]],
    [{ allowRebase: true }, ["rebase"]],
    // Semi-linear merges have no method in Deck.
    [{ allowRebaseMerge: true }, []],
    // The policy's older form: squash only, or a merge commit only.
    [{ useSquashMerge: true }, ["squash"]],
    [{ useSquashMerge: false }, ["merge"]],
  ] as const)("maps %j to %j", async (settings, expected) => {
    azure({}, { policies: [policy(settings)] });

    await expect(methods()).resolves.toEqual(expected);
  });

  it("offers every method without a policy, or with one that's off or deleted", async () => {
    azure({}, {
      policies: [policy({ allowSquash: true }, { isEnabled: false }), policy({ allowSquash: true }, { isDeleted: true })],
    });

    await expect(methods()).resolves.toEqual(["merge", "squash", "rebase"]);
  });

  it("leaves out policies on another repository or branch, whatever Azure DevOps answers", async () => {
    const scoped = (scope: Record<string, unknown>) => ({
      ...policy({ allowSquash: true }),
      settings: { allowSquash: true, scope: [scope] },
    });
    azure({}, {
      policies: [
        scoped({ repositoryId: "repo-2", refName: "refs/heads/main", matchKind: "exact" }),
        scoped({ repositoryId: "repo-1", refName: "refs/heads/release", matchKind: "exact" }),
        scoped({ repositoryId: "repo-1", refName: "refs/heads/rel", matchKind: "prefix" }),
      ],
    });

    await expect(methods()).resolves.toEqual(["merge", "squash", "rebase"]);
  });

  it("counts a policy on a branch prefix, or on the whole project", async () => {
    const scoped = (settings: Record<string, unknown>, scope: Record<string, unknown>) => ({
      ...policy({}),
      settings: { ...settings, scope: [scope] },
    });
    azure({}, {
      policies: [
        scoped({ allowSquash: true, allowRebase: true }, { repositoryId: "REPO-1", refName: "refs/heads/ma", matchKind: "Prefix" }),
        scoped({ allowNoFastForward: true, allowSquash: true }, { repositoryId: null, refName: null }),
      ],
    });

    await expect(methods()).resolves.toEqual(["squash"]);
  });

  it("offers only what every policy on the branch allows", async () => {
    azure({}, {
      policies: [policy({ allowSquash: true, allowRebase: true }), policy({ allowNoFastForward: true, allowSquash: true })],
    });

    await expect(methods()).resolves.toEqual(["squash"]);
  });

  it("offers every method when the policies can't be read, and Azure DevOps refuses the others at the merge", async () => {
    azure({}, { policies: "refused" });

    await expect(methods()).resolves.toEqual(["merge", "squash", "rebase"]);
  });
});
