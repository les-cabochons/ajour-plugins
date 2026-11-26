import { afterEach, describe, expect, it, vi } from "vitest";
import { mergePullRequest, updatePullRequest } from "../src/plugin.ts";
import { installAjour, json, pluginConnection, type SeenRequest } from "./support/github-ajour.ts";

/*
 * The author's actions (les-cabochons/ajour#786): the title, draft and
 * ready, and the merge. Every request goes through the fake Ajour with the
 * real plugin.json, so the writes answer only while the connection turned
 * on "Review pull requests", as Ajour's broker does.
 */

const REVIEW = "reviewPullRequests";
const ref = { repository: "acme/api", number: 7 };
const connection = (access: readonly string[] = [REVIEW]) => pluginConnection({}, { access: [...access] });

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Pull {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  title: string;
  head: string;
  mergeCommit?: string;
}

/**
 * GitHub holding one pull request: REST reads, edits and merges it, and
 * GraphQL converts it to a draft or marks it ready. `merge` answers the
 * merge instead, after the pull request changed as it says.
 */
function gitHub(
  start: Partial<Pull> = {},
  options: {
    access?: readonly string[];
    merge?: (pull: Pull, request: SeenRequest) => { status: number; body: unknown };
    /** How many reads of the pull request fail before one answers. */
    failReads?: number;
  } = {},
) {
  const pull: Pull = { state: "open", merged: false, draft: false, title: "Stop retries on 410", head: "abc123", ...start };
  let failReads = options.failReads ?? 0;
  const rest = () => ({
    number: 7,
    node_id: "PR_node7",
    state: pull.state,
    merged: pull.merged,
    draft: pull.draft,
    title: pull.title,
    head: { sha: pull.head },
    merge_commit_sha: pull.mergeCommit ?? null,
  });
  const installed = installAjour(
    (request) => {
      if (request.host === "graphql") {
        const { query, variables } = request.body as { query: string; variables: { id: string } };
        if (variables.id !== "PR_node7") return json({ errors: [{ message: "Could not resolve to a node." }] });
        const mutation = query.includes("convertPullRequestToDraft") ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
        pull.draft = mutation === "convertPullRequestToDraft";
        return json({ data: { [mutation]: { pullRequest: { title: pull.title, isDraft: pull.draft } } } });
      }
      if (request.path === "/repos/acme/api/pulls/7" && request.method === "GET") {
        if (failReads > 0) {
          failReads -= 1;
          return json({ message: "Server Error" }, 500);
        }
        return json(rest());
      }
      if (request.path === "/repos/acme/api/pulls/7" && request.method === "PATCH") {
        pull.title = request.body.title ?? pull.title;
        return json(rest());
      }
      if (request.path === "/repos/acme/api/pulls/7/merge" && request.method === "PUT") {
        if (options.merge) {
          const answer = options.merge(pull, request);
          return json(answer.body, answer.status);
        }
        if (request.body.sha !== pull.head) {
          return json({ message: "Head branch was modified. Review and try the merge again." }, 409);
        }
        pull.merged = true;
        pull.state = "closed";
        pull.mergeCommit = "merge789";
        return json({ sha: "merge789", merged: true, message: "Pull Request successfully merged" });
      }
      return json({ message: "Not Found" }, 404);
    },
    { access: options.access ?? [REVIEW] },
  );
  return { pull, ...installed };
}

const labels = (requests: SeenRequest[]) => requests.map((request) => request.label);

describe("updatePullRequest", () => {
  it("edits the title, and answers with the title and draft state GitHub holds", async () => {
    const { requests } = gitHub();

    await expect(updatePullRequest!(connection(), { ...ref, title: "Stop retrying on 410 and 404" })).resolves.toEqual({
      title: "Stop retrying on 410 and 404",
      draft: false,
    });
    expect(requests).toMatchObject([
      { label: "PATCH rest /repos/acme/api/pulls/7", body: { title: "Stop retrying on 410 and 404" } },
    ]);
  });

  it("converts a ready pull request to a draft", async () => {
    const { requests, pull } = gitHub();

    await expect(updatePullRequest!(connection(), { ...ref, draft: true })).resolves.toEqual({
      title: "Stop retries on 410",
      draft: true,
    });
    expect(labels(requests)).toEqual(["GET rest /repos/acme/api/pulls/7", "POST graphql /graphql"]);
    expect(requests[1]!.body).toMatchObject({ variables: { id: "PR_node7" } });
    expect(requests[1]!.body.query).toContain("convertPullRequestToDraft");
    expect(pull.draft).toBe(true);
  });

  it("marks a draft ready for review", async () => {
    const { requests, pull } = gitHub({ draft: true });

    await expect(updatePullRequest!(connection(), { ...ref, draft: false })).resolves.toEqual({
      title: "Stop retries on 410",
      draft: false,
    });
    expect(requests[1]!.body.query).toContain("markPullRequestReadyForReview");
    expect(pull.draft).toBe(false);
  });

  it("edits the title and marks it ready together", async () => {
    const { requests } = gitHub({ draft: true });

    await expect(updatePullRequest!(connection(), { ...ref, title: "Ready now", draft: false })).resolves.toEqual({
      title: "Ready now",
      draft: false,
    });
    expect(labels(requests)).toEqual(["PATCH rest /repos/acme/api/pulls/7", "POST graphql /graphql"]);
  });

  it("sends nothing more when the draft state already is the one asked for", async () => {
    const { requests } = gitHub({ draft: true });

    await expect(updatePullRequest!(connection(), { ...ref, draft: true })).resolves.toEqual({
      title: "Stop retries on 410",
      draft: true,
    });
    expect(labels(requests)).toEqual(["GET rest /repos/acme/api/pulls/7"]);
  });

  it("is refused while the connection has Review pull requests off, the draft state too", async () => {
    const { requests } = gitHub({}, { access: [] });

    await expect(updatePullRequest!(connection([]), { ...ref, title: "New" })).rejects.toThrow(/reviewPullRequests/);
    await expect(updatePullRequest!(connection([]), { ...ref, draft: true })).rejects.toThrow(/Review pull requests/);
    expect(requests).toEqual([]);
  });
});

describe("mergePullRequest", () => {
  it.each(["merge", "squash"] as const)(
    "merges with %s at the head the user saw, with the commit title",
    async (method) => {
      const { requests } = gitHub();

      await expect(
        mergePullRequest!(connection(), {
          ...ref,
          method,
          headSha: "abc123",
          commitTitle: "Stop retries on 410 (#7)",
          commitMessage: "Retries stop at the first 410.",
        }),
      ).resolves.toEqual({ mergeCommitSha: "merge789" });
      expect(requests).toMatchObject([
        { label: "GET rest /repos/acme/api/pulls/7" },
        {
          label: "PUT rest /repos/acme/api/pulls/7/merge",
          body: {
            merge_method: method,
            sha: "abc123",
            commit_title: "Stop retries on 410 (#7)",
            commit_message: "Retries stop at the first 410.",
          },
        },
      ]);
    },
  );

  it("rebases with no commit title, which a rebase has no commit for", async () => {
    const { requests } = gitHub();

    await expect(
      mergePullRequest!(connection(), { ...ref, method: "rebase", headSha: "abc123", commitTitle: "Ignored" }),
    ).resolves.toEqual({ mergeCommitSha: "merge789" });
    expect(requests[1]!.body).toEqual({ merge_method: "rebase", sha: "abc123" });
  });

  it("refuses a head the pull request moved on from, and merges nothing", async () => {
    const { requests } = gitHub({ head: "newer" });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).rejects.toThrow(
      "The pull request has new commits since you read it. Refresh to review them before merging.",
    );
    expect(labels(requests)).toEqual(["GET rest /repos/acme/api/pulls/7"]);
  });

  it("refuses a push that lands between the check and the merge, as GitHub does with the head", async () => {
    const { pull } = gitHub({}, {
      merge: (current, request) => {
        current.head = "newer";
        return request.body.sha === current.head
          ? { status: 200, body: { sha: "merge789", merged: true } }
          : { status: 409, body: { message: "Head branch was modified. Review and try the merge again." } };
      },
    });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).rejects.toThrow(
      "GitHub request failed (409): Head branch was modified. Review and try the merge again.",
    );
    expect(pull.merged).toBe(false);
  });

  it("refuses a draft, which GitHub can't merge", async () => {
    const { requests } = gitHub({ draft: true });

    await expect(mergePullRequest!(connection(), { ...ref, method: "merge", headSha: "abc123" })).rejects.toThrow(
      "This pull request is a draft. Mark it ready for review to merge it.",
    );
    expect(requests).toHaveLength(1);
  });

  it("refuses a closed pull request", async () => {
    gitHub({ state: "closed" });

    await expect(mergePullRequest!(connection(), { ...ref, method: "merge", headSha: "abc123" })).rejects.toThrow(
      "This pull request is closed.",
    );
  });

  it("answers a retry after a lost answer with the merge GitHub already made, and merges nothing again", async () => {
    const { requests } = gitHub({ state: "closed", merged: true, mergeCommit: "merge789" });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).resolves.toEqual({
      mergeCommitSha: "merge789",
    });
    expect(labels(requests)).toEqual(["GET rest /repos/acme/api/pulls/7"]);
  });

  it("says a pull request merged at another head was merged without the user's merge", async () => {
    gitHub({ state: "closed", merged: true, head: "newer", mergeCommit: "merge789" });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).rejects.toThrow(
      "This pull request was already merged, with commits you didn't read.",
    );
  });

  it("finds the merge GitHub made when its answer failed", async () => {
    const { requests } = gitHub({}, {
      merge: (current) => {
        // GitHub merged, then the answer was lost.
        current.merged = true;
        current.state = "closed";
        current.mergeCommit = "merge789";
        return { status: 502, body: { message: "Bad Gateway" } };
      },
    });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).resolves.toEqual({
      mergeCommitSha: "merge789",
    });
    expect(labels(requests)).toEqual([
      "GET rest /repos/acme/api/pulls/7",
      "PUT rest /repos/acme/api/pulls/7/merge",
      "GET rest /repos/acme/api/pulls/7",
    ]);
  });

  it("keeps GitHub's reason when the merge failed and nothing merged", async () => {
    gitHub({}, { merge: () => ({ status: 405, body: { message: "Pull Request is not mergeable" } }) });

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).rejects.toThrow(
      "GitHub request failed (405): Pull Request is not mergeable.",
    );
  });

  it("keeps the merge's reason when the look after it fails too", async () => {
    gitHub({}, { merge: () => ({ status: 405, body: { message: "Pull Request is not mergeable" } }) });
    // The read before the merge answers; the one after fails.
    let reads = 0;
    const fake = (globalThis as unknown as { ajour: { http: (request: { method: string; path: string }) => Promise<unknown> } }).ajour;
    const http = fake.http.bind(fake);
    fake.http = async (request) => {
      if (request.method === "GET" && reads++ > 0) throw new Error("offline");
      return await http(request);
    };

    await expect(mergePullRequest!(connection(), { ...ref, method: "squash", headSha: "abc123" })).rejects.toThrow(
      "GitHub request failed (405): Pull Request is not mergeable.",
    );
  });

  it("is refused while the connection has Review pull requests off", async () => {
    const { requests } = gitHub({}, { access: [] });

    await expect(mergePullRequest!(connection([]), { ...ref, method: "squash", headSha: "abc123" })).rejects.toThrow(
      /reviewPullRequests/,
    );
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  });
});
