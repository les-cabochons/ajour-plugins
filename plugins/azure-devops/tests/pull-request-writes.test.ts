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

/** The pull request's iterations: the user reviewed the second, its latest. */
const ITERATIONS = [
  { id: 1, sourceRefCommit: { commitId: "first" } },
  { id: 2, sourceRefCommit: { commitId: "abc123" } },
];
/** A push after the user read it. */
const PUSHED = [...ITERATIONS, { id: 3, sourceRefCommit: { commitId: "newer" } }];

/**
 * Azure DevOps with the pull request, its iterations, the threads it already
 * has, and a new id for each thread posted. `failVote` refuses the vote
 * once; `failThread` refuses that thread post (0 is the first) once.
 * `pushAfterReads` lands a push once the iterations were read that many
 * times.
 */
function azure(
  options: {
    access?: string[];
    threads?: unknown[];
    iterations?: unknown[];
    failVote?: boolean;
    failThread?: number;
    pushAfterReads?: number;
  } = {},
) {
  const sent: Sent[] = [];
  let nextThread = 100;
  let posts = 0;
  let iterationReads = 0;
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
      if (url === `${BASE}/iterations`) {
        const pushed = options.pushAfterReads !== undefined && iterationReads++ >= options.pushAfterReads;
        return json({ value: pushed ? PUSHED : (options.iterations ?? ITERATIONS) });
      }
      if (url === `${BASE}/threads` && method === "POST") {
        if (posts++ === options.failThread) return json({ message: "TF400898: An internal error occurred." }, 500);
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
    const sent = azure({ iterations: PUSHED });

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
          // The iteration the user reviewed, not the newer one, against the
          // common commit: equal iterations name it as the left side.
          pullRequestThreadContext: {
            iterationContext: { firstComparingIteration: 2, secondComparingIteration: 2 },
          },
        },
      },
    ]);
  });

  it("refuses lines of a head no iteration has, posting nothing", async () => {
    const sent = azure();

    await expect(
      postComment!(connection(), {
        ...ref,
        body: "Here.",
        anchor: { path: "src/retry.ts", side: "head", line: 14, headSha: "gone" },
      }),
    ).rejects.toThrow("The pull request has new commits since you read it.");
    expect(sent).toEqual([]);
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
        // The base's line in the common commit, not in the first iteration.
        pullRequestThreadContext: {
          iterationContext: { firstComparingIteration: 2, secondComparingIteration: 2 },
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

describe("postComment with a submission", () => {
  const SUBMISSION = "comment_submission_1";
  const MARK = { "Ajour.ReviewSubmission": { $type: "System.String", $value: SUBMISSION } };
  const comment = {
    ...ref,
    body: "Why 410 only?",
    anchor: { path: "src/retry.ts", side: "head" as const, line: 14, headSha: "abc123" },
    submissionId: SUBMISSION,
  };
  const thread = (author: typeof viewerIdentity, properties?: unknown) => ({
    id: 5,
    status: "active",
    ...(properties ? { properties } : {}),
    comments: [{ id: 3, author, content: "Why 410 only?", commentType: "text" }],
  });

  it("marks its thread with its submission", async () => {
    const sent = azure();

    await postComment!(connection(), comment);

    expect(sent.map((request) => request.body.properties)).toEqual([MARK]);
  });

  it("on a retry, finds the thread an earlier try left and posts nothing", async () => {
    const sent = azure({ threads: [thread(viewerIdentity, MARK)] });

    await expect(postComment!(connection(), { ...comment, firstTriedAt: Date.now() - 60_000 })).resolves.toEqual({
      commentId: "5-3",
    });
    expect(sent).toEqual([]);
  });

  it.each([
    ["someone else's thread of the submission", thread(alice, MARK)],
    ["the user's thread of another one", thread(viewerIdentity, { "Ajour.ReviewSubmission": { $type: "System.String", $value: "other" } })],
  ])("on a retry, posts beside %s", async (_, existing) => {
    const sent = azure({ threads: [existing] });

    await postComment!(connection(), { ...comment, firstTriedAt: Date.now() - 60_000 });

    expect(sent.map((request) => request.method)).toEqual(["POST"]);
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

  const SUBMISSION = "draft_review_submission_1";
  const MARK = { "Ajour.ReviewSubmission": { $type: "System.String", $value: SUBMISSION } };

  /** The threads `sent` posted, as Azure DevOps lists them back. */
  function listed(sent: Sent[]) {
    return sent
      .filter((request) => request.method === "POST" && request.body.properties)
      .map((request, index) => ({
        id: 100 + index,
        status: "active",
        publishedDate: new Date(Date.now() - 60_000).toISOString(),
        properties: request.body.properties,
        ...(request.body.threadContext ? { threadContext: request.body.threadContext } : {}),
        comments: [{ id: 1, author: viewerIdentity, content: request.body.comments[0].content, commentType: "text" }],
      }));
  }

  it("marks each thread with the submission it belongs to", async () => {
    const sent = azure();

    await submitReview!(connection(), {
      ...ref,
      headSha: "abc123",
      verdict: "comment",
      body: "A few things.",
      comments,
      submissionId: SUBMISSION,
    });

    expect(sent.map((request) => request.body.properties)).toEqual([MARK, MARK, MARK]);
  });

  it("after a failed vote, Retry with the same submission only votes, even past 15 minutes", async () => {
    const sent = azure({ failVote: true });
    const review = { ...ref, headSha: "abc123", verdict: "approve" as const, comments, submissionId: SUBMISSION };
    await expect(submitReview!(connection(), review)).rejects.toThrow(
      "Azure DevOps request failed (409): TF401181: The pull request is locked.",
    );
    expect(sent).toHaveLength(3);

    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const retried = azure({ threads: listed(sent).map((thread) => ({ ...thread, publishedDate: hourAgo })) });
    await submitReview!(connection(), review);

    expect(retried.map((request) => request.method)).toEqual(["PUT"]);
  });

  it("after a thread failed half way, Retry posts the rest and votes", async () => {
    const sent = azure({ failThread: 1 });
    const review = {
      ...ref,
      headSha: "abc123",
      verdict: "approve" as const,
      body: "A few things.",
      comments,
      submissionId: SUBMISSION,
    };
    await expect(submitReview!(connection(), review)).rejects.toThrow("TF400898");

    const retried = azure({ threads: listed(sent.filter((_, index) => index !== 1)) });
    await submitReview!(connection(), review);

    expect(retried.map((request) => request.body?.comments?.[0]?.content ?? request.method)).toEqual([
      "This went away.",
      "A few things.",
      "PUT",
    ]);
  });

  it("posts two comments of one submission on the same lines once each", async () => {
    const twice = [comments[0]!, { ...comments[0]!, body: "And 429?" }];
    const sent = azure({ failThread: 1 });
    const review = { ...ref, headSha: "abc123", verdict: "comment" as const, comments: twice, submissionId: SUBMISSION };
    await expect(submitReview!(connection(), review)).rejects.toThrow("TF400898");

    const retried = azure({ threads: listed(sent.filter((_, index) => index !== 1)) });
    await submitReview!(connection(), review);

    expect(retried.map((request) => request.body.comments[0].content)).toEqual(["And 429?"]);
  });

  it.each([
    ["another submission", { "Ajour.ReviewSubmission": { $type: "System.String", $value: "another" } }, 14],
    ["no submission", undefined, 14],
    // The same submission, on lines 12 to 14: the draft is on line 14 alone.
    ["a range ending on the same line", MARK, 12],
  ])("posts a draft beside a recent thread of the user's with the same words, from %s", async (_, properties, start) => {
    const sent = azure({
      threads: [
        {
          id: 5,
          status: "active",
          publishedDate: new Date(Date.now() - 60_000).toISOString(),
          ...(properties ? { properties } : {}),
          threadContext: {
            filePath: "/src/retry.ts",
            rightFileStart: { line: start, offset: 1 },
            rightFileEnd: { line: 14, offset: 1 },
          },
          comments: [{ id: 1, author: viewerIdentity, content: "Why 410 only?", commentType: "text" }],
        },
      ],
    });

    await submitReview!(connection(), {
      ...ref,
      headSha: "abc123",
      verdict: "comment",
      comments: [comments[0]!],
      submissionId: SUBMISSION,
    });

    expect(sent.map((request) => request.method)).toEqual(["POST"]);
  });

  it("without a submission, posts every comment", async () => {
    const sent = azure({ threads: listed([]) });

    await submitReview!(connection(), { ...ref, headSha: "abc123", verdict: "comment", comments });

    expect(sent.map((request) => request.method)).toEqual(["POST", "POST"]);
    expect(sent[0]!.body.properties).toBeUndefined();
  });

  it.each(["approve", "request_changes"] as const)(
    "refuses to vote %s with no comments on a head no iteration has",
    async (verdict) => {
      const sent = azure();

      await expect(
        submitReview!(connection(), { ...ref, headSha: "gone", verdict, comments: [] }),
      ).rejects.toThrow("The pull request has new commits since you read it.");
      expect(sent).toEqual([]);
    },
  );

  it("refuses to approve an iteration that isn't the latest, posting nothing", async () => {
    const sent = azure({ iterations: PUSHED });

    await expect(
      submitReview!(connection(), { ...ref, headSha: "abc123", verdict: "approve", body: "Ship it.", comments }),
    ).rejects.toThrow("The pull request has new commits since you read it. Open it again to approve its latest changes.");
    expect(sent).toEqual([]);
  });

  it("sends no approval when a push lands while its comments post, and says the comments went", async () => {
    const sent = azure({ pushAfterReads: 1 });

    await expect(
      submitReview!(connection(), { ...ref, headSha: "abc123", verdict: "approve", body: "Ship it.", comments }),
    ).rejects.toThrow(
      "New commits arrived while your review was sending: your comments were posted, your vote wasn't. Review the new commits.",
    );
    expect(sent.map((request) => request.method)).toEqual(["POST", "POST", "POST"]);
  });

  it("after that refusal, Retry with the same submission posts nothing and asks to open it again", async () => {
    const threads = comments.map((comment, index) => ({
      id: 100 + index,
      comments: [{ id: 1, author: { id: VIEWER } }],
      threadContext: {
        filePath: `/${comment.path}`,
        ...(comment.side === "head"
          ? { rightFileStart: { line: comment.line }, rightFileEnd: { line: comment.line } }
          : { leftFileStart: { line: comment.line }, leftFileEnd: { line: comment.line } }),
      },
      properties: { "Ajour.ReviewSubmission": { $type: "System.String", $value: "sub-1" } },
    }));
    const sent = azure({ iterations: PUSHED, threads });

    await expect(
      submitReview!(connection(), {
        ...ref,
        headSha: "abc123",
        verdict: "approve",
        comments,
        submissionId: "sub-1",
        firstTriedAt: 1,
      }),
    ).rejects.toThrow("Open it again to approve its latest changes.");
    expect(sent).toEqual([]);
  });

  it("sends no approval without comments when a push lands before the vote", async () => {
    const sent = azure({ pushAfterReads: 1 });

    await expect(
      submitReview!(connection(), { ...ref, headSha: "abc123", verdict: "approve", comments: [] }),
    ).rejects.toThrow("New commits arrived while your review was sending, so your vote wasn't. Review the new commits.");
    expect(sent).toEqual([]);
  });

  it("still waits for the author when a push lands while its comments post", async () => {
    const sent = azure({ pushAfterReads: 1 });

    await submitReview!(connection(), { ...ref, headSha: "abc123", verdict: "request_changes", comments });

    expect(sent.map((request) => request.method)).toEqual(["POST", "POST", "PUT"]);
  });

  it("comments, or waits for the author, on an iteration that isn't the latest", async () => {
    const sent = azure({ iterations: PUSHED });

    await submitReview!(connection(), { ...ref, headSha: "abc123", verdict: "request_changes", comments });

    expect(sent.map((request) => request.method)).toEqual(["POST", "POST", "PUT"]);
    expect(sent[0]!.body.pullRequestThreadContext.iterationContext).toEqual({
      firstComparingIteration: 2,
      secondComparingIteration: 2,
    });
  });

  it("is refused while the connection has Review pull requests off", async () => {
    const sent = azure({ access: WITHOUT_REVIEW });

    await expect(
      submitReview!(connection(WITHOUT_REVIEW), { ...ref, headSha: "abc123", verdict: "approve", comments: [] }),
    ).rejects.toThrow(/reviewPullRequests/);
    expect(sent).toEqual([]);
  });
});
