import { afterEach, describe, expect, it, vi } from "vitest";
import { readDescription, syncConnection, writeDescription } from "../src/plugin.ts";
import { installAjour, json, pluginConnection } from "./support/github-ajour.ts";

const ISSUE_URL = "https://github.com/acme/api/issues/7";
const REST_ISSUE = "/repos/acme/api/issues/7";

const connection = pluginConnection();

/** An issue as GitHub's GraphQL search returns it. */
function graphqlIssue(body: string) {
  return {
    id: "I_7",
    number: 7,
    url: ISSUE_URL,
    title: "Rate limits",
    body,
    state: "OPEN",
    stateReason: null,
    repository: { nameWithOwner: "acme/api" },
    assignees: { nodes: [{ login: "octocat" }] },
  };
}

interface Call {
  method: string;
  host: string | undefined;
  path: string;
  body?: Record<string, unknown>;
}

/**
 * GitHub with one issue, routed by derived host, method and path: GraphQL
 * search for a sync, REST for reading and updating the issue.
 */
function stubGitHub(body: string, options: { pullRequest?: boolean; patchStatus?: number } = {}) {
  const issue: Record<string, unknown> = {
    number: 7,
    html_url: options.pullRequest ? "https://github.com/acme/api/pull/7" : ISSUE_URL,
    body,
    ...(options.pullRequest ? { pull_request: { url: "https://api.github.com/repos/acme/api/pulls/7" } } : {}),
  };
  const { requests } = installAjour((request) => {
    if (request.host === "graphql") {
      return json({
        data: {
          search: {
            issueCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [graphqlIssue(issue.body as string)],
          },
        },
      });
    }
    if (request.path === REST_ISSUE && request.method === "GET") {
      return json(issue);
    }
    if (request.path === REST_ISSUE && request.method === "PATCH") {
      if (options.patchStatus) {
        return json({ message: "Resource not accessible by personal access token" }, options.patchStatus);
      }
      issue.body = request.body?.body;
      return json(issue);
    }
    return json({ message: "Not Found" }, 404);
  });
  const calls = requests as unknown as Call[];
  return {
    calls,
    requests,
    issue,
    patches: () => calls.filter((call) => call.method === "PATCH"),
  };
}

async function syncedDescription(body: string) {
  stubGitHub(body);
  const result = await syncConnection(connection, []);
  return result.items[0]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("descriptions a sync sends", () => {
  it("sends the body as written, mentions and GitHub-only syntax included, beside the old note", async () => {
    const body = [
      "Steps for @octocat and @acme/backend:",
      "",
      "- [ ] Reproduce",
      "- [x] Write a test",
      "",
      "> [!NOTE]",
      "> Rate limits apply per token.",
      "",
      "<details><summary>Logs</summary>",
      "",
      "```",
      "429 Too Many Requests",
      "```",
      "</details>",
    ].join("\n");

    const candidate = await syncedDescription(body);

    expect(candidate.description).toEqual({ text: body });
    expect(candidate.note).toBe(body);
  });

  it("gives Ajour Unix line endings, without the blank lines and spaces around the text", async () => {
    const candidate = await syncedDescription("\r\n\r\n  Indented first line\r\nSecond line  \r\n\r\n");

    expect(candidate.description).toEqual({ text: "  Indented first line\nSecond line" });
  });

  it("names mixed line endings as lost, since a write would make them one kind", async () => {
    const candidate = await syncedDescription("First\r\nSecond\nThird");

    expect(candidate.description).toEqual({
      text: "First\nSecond\nThird",
      lost: ["line endings Ajour cannot keep"],
    });
  });

  it("cuts a body longer than Ajour stores at 64,000 characters, never inside a character", async () => {
    const candidate = await syncedDescription(`${"a".repeat(63_999)}😀 and more`);

    expect(candidate.description).toEqual({ text: "a".repeat(63_999), cut: true });
    expect(candidate.note).toHaveLength(4000);
  });

  it("sends an empty description for an issue without a body", async () => {
    const candidate = await syncedDescription("");

    expect(candidate.description).toEqual({ text: "" });
    expect(candidate.note).toBeUndefined();
  });
});

describe("readDescription", () => {
  it("returns the issue's current body as a sync sends it", async () => {
    const { calls } = stubGitHub("Now with @octocat\r\n");

    await expect(readDescription(connection, { sourceId: ISSUE_URL })).resolves.toEqual({
      description: { text: "Now with @octocat" },
    });
    expect(calls).toMatchObject([{ method: "GET", host: "rest", path: REST_ISSUE }]);
  });

  it("refuses a pull request, which is not a backlog item", async () => {
    stubGitHub("A pull request body", { pullRequest: true });

    await expect(readDescription(connection, { sourceId: ISSUE_URL })).rejects.toThrow(/pull request/);
  });

  it("refuses an item of another GitHub instance without calling it", async () => {
    const { calls } = stubGitHub("Body");

    await expect(
      readDescription(connection, { sourceId: "https://github.acme.com/acme/api/issues/7" }),
    ).rejects.toThrow(/not an issue/);
    expect(calls).toEqual([]);
  });
});

describe("writeDescription", () => {
  it("writes the text as it is, reading the issue just before", async () => {
    const { calls, requests, issue } = stubGitHub("Steps\n\n- [ ] Reproduce");

    await expect(
      writeDescription(connection, {
        sourceId: ISSUE_URL,
        text: "Steps for @octocat\n\n- [x] Reproduce",
        expected: "Steps\n\n- [ ] Reproduce",
      }),
    ).resolves.toEqual({ outcome: "written", description: { text: "Steps for @octocat\n\n- [x] Reproduce" } });
    expect(calls).toMatchObject([
      { method: "GET", host: "rest", path: REST_ISSUE },
      { method: "PATCH", host: "rest", path: REST_ISSUE, body: { body: "Steps for @octocat\n\n- [x] Reproduce" } },
    ]);
    const [read, write] = requests;
    expect(write).toMatchObject({
      contentType: "application/json",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ajour-github-plugin" },
    });
    expect(read!.contentType).toBeUndefined();
    expect(read!.body).toBeUndefined();
    expect(issue.body).toBe("Steps for @octocat\n\n- [x] Reproduce");
  });

  it("keeps the body's line endings and the blank lines around it", async () => {
    const { patches } = stubGitHub("\r\nFirst\r\nSecond\r\n\r\n");

    await writeDescription(connection, { sourceId: ISSUE_URL, text: "First\nChanged", expected: "First\nSecond" });

    expect(patches()[0]?.body).toEqual({ body: "\r\nFirst\r\nChanged\r\n\r\n" });
  });

  describe("puts the whitespace the read trims back where it was, or refuses", () => {
    const NBSP = String.fromCharCode(0xa0);

    /** The body written for `text` over an issue whose body is `source`, or why the write refused. */
    async function written(source: string, text: string) {
      const { patches } = stubGitHub(source);
      const read = await readDescription(connection, { sourceId: ISSUE_URL });
      try {
        await writeDescription(connection, { sourceId: ISSUE_URL, text, expected: read.description.text });
      } catch (error) {
        expect(patches()).toEqual([]);
        return { refused: (error as Error).message };
      }
      return patches()[0]?.body?.body;
    }

    const ambiguous = { refused: expect.stringMatching(/cannot tell which "Keep" line.*Edit the description in GitHub\.$/) };

    it.each([
      ["unchanged", "A\nKeep  \n", "A\nKeep", "A\nKeep  \n"],
      ["append after a tab", "A\nKeep\t", "A\nKeep\nNext", "A\nKeep\t\nNext"],
      ["append after a non-breaking space", `A\nKeep${NBSP}`, "A\nKeep\nNext", `A\nKeep${NBSP}\nNext`],
      // GitHub renders a newline in an issue as a line break, so the spaces change nothing.
      ["append after two spaces", "First\nKeep  \n", "First\nKeep\nNext", "First\nKeep  \nNext\n"],
      ["append after a blank line", "A\nKeep  ", "A\nKeep\n\nNext", "A\nKeep  \n\nNext"],
      ["prepend", "\n \nA\nKeep  ", "Intro\nA\nKeep", "\n \nIntro\nA\nKeep  "],
      ["prepend and append", "A\nKeep\t", "Intro\nA\nKeep\nNext", "Intro\nA\nKeep\t\nNext"],
      ["a duplicate added before", "A\nKeep  ", "Keep\nA\nKeep", "Keep\nA\nKeep  "],
      ["a duplicate added after", "A\nKeep\t", "A\nKeep\nKeep", ambiguous],
      ["duplicates added before and after", "A\nKeep  ", "Intro\nA\nKeep\nNext\nKeep", ambiguous],
      ["the last line swapped", "A\nKeep\t", "Keep\nA", ambiguous],
      ["the last line moved", "A\nB\nKeep  ", "Keep\nA\nB", "Keep\nA\nB"],
      ["the last line edited", "A\nKeep  \n\n", "A\nKept", "A\nKept\n\n"],
      ["the last line deleted", "A\nKeep  \n", "A", "A\n"],
      ["an earlier line edited", "A\nKeep \t\n", "B\nKeep", "B\nKeep \t\n"],
      ["trailing blank lines", "A\n\n \n", "A\nNext", "A\nNext\n\n \n"],
      ["a whitespace-only body", " \n\n", "Hello", "Hello"],
      ["the text emptied", "\nA  \n", "", ""],
      ["uniform Windows line endings", "A\r\nKeep\t\r\n", "A\nKeep\nNext", "A\r\nKeep\t\r\nNext\r\n"],
      ["mixed line endings", "A\r\nB\nC", "A", { refused: expect.stringMatching(/line endings Ajour cannot keep/) }],
    ])("%s", async (_case, source, text, expected) => {
      await expect(written(source, text)).resolves.toEqual(expected);
    });

    it("refuses rather than diff an edit past 4,000,000 line pairs", async () => {
      const lines = (prefix: string) => Array.from({ length: 2100 }, (_, index) => `${prefix}${index}`).join("\n");

      await expect(written(`${lines("old")}\nKeep\t`, `${lines("new")}\nKeep`)).resolves.toEqual({
        refused: expect.stringMatching(/edit this large.*Edit the description in GitHub\.$/),
      });
    });

    it("diffs a rewrite of 1,900 lines quickly", async () => {
      const lines = (prefix: string) => Array.from({ length: 1900 }, (_, index) => `${prefix}${index}`).join("\n");
      const started = performance.now();

      await expect(written(`${lines("old")}\nKeep\t`, `${lines("new")}\nKeep`)).resolves.toBe(`${lines("new")}\nKeep\t`);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  it("answers a conflict and writes nothing when the issue changed since Ajour read it", async () => {
    const { patches } = stubGitHub("Edited by a colleague");

    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text: "Mine", expected: "Original" }),
    ).resolves.toEqual({ outcome: "conflict", description: { text: "Edited by a colleague" } });
    expect(patches()).toEqual([]);
  });

  it("refuses text over GitHub's 65,536 characters once written, and writes nothing", async () => {
    const { patches } = stubGitHub("a\r\nb");
    const text = "line\n".repeat(12_000).trimEnd();

    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text, expected: "a\nb" }),
    ).rejects.toThrow("This description is too long for GitHub: 71,998 of 65,536 characters.");
    expect(patches()).toEqual([]);
  });

  it("counts characters as GitHub does, so a character made of two code units counts once", async () => {
    const { patches } = stubGitHub("");
    const text = "😀".repeat(32_000);

    await writeDescription(connection, { sourceId: ISSUE_URL, text, expected: "" });

    expect(patches()).toHaveLength(1);
  });

  it("refuses a cut description, and mixed line endings unless the user allowed that loss", async () => {
    stubGitHub(`${"a".repeat(64_001)}`);
    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text: "Short", expected: "a".repeat(64_000) }),
    ).rejects.toThrow(/longer than Ajour keeps/);

    const mixed = stubGitHub("First\r\nSecond\nThird");
    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text: "First", expected: "First\nSecond\nThird" }),
    ).rejects.toThrow(/line endings Ajour cannot keep/);
    expect(mixed.patches()).toEqual([]);

    await writeDescription(connection, {
      sourceId: ISSUE_URL,
      text: "First",
      expected: "First\nSecond\nThird",
      allowedLoss: ["line endings Ajour cannot keep"],
    });
    expect(mixed.patches()[0]?.body).toEqual({ body: "First" });
  });

  it("never writes a pull request's body", async () => {
    const { patches } = stubGitHub("A pull request body", { pullRequest: true });

    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text: "Mine", expected: "A pull request body" }),
    ).rejects.toThrow(/pull request/);
    expect(patches()).toEqual([]);
  });

  it("names the permission when GitHub refuses the write", async () => {
    stubGitHub("Body", { patchStatus: 403 });

    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text: "Mine", expected: "Body" }),
    ).rejects.toThrow(
      "GitHub request failed (403): Resource not accessible by personal access token. Writing a description needs the token's Issues permission set to Read and write.",
    );
  });
});
