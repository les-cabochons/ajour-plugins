import { afterEach, describe, expect, it, vi } from "vitest";
import { getFileContent, getPullRequestContent } from "../src/plugin.ts";
import { installAjour, json, pluginConnection, type SeenRequest } from "./support/github-ajour.ts";

/*
 * What Deck reads to build a pull request's diff (les-cabochons/ajour#779):
 * the changed files and their statuses, and each file's text at a commit.
 * Every request goes through the fake Ajour with the real plugin.json, so a
 * request the manifest does not declare is refused, as Ajour's broker does.
 */

const connection = pluginConnection();
const ref = { repository: "acme/api", number: 7 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function file(overrides: Record<string, unknown>) {
  return { status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-a\n+b", ...overrides };
}

/** The pull request, its merge base and its files, as GitHub's REST API answers them. */
function pullRequestRoutes(files: unknown[][], mergeBase: unknown = { sha: "merge-base" }) {
  return (request: SeenRequest) => {
    if (request.path === "/repos/acme/api/pulls/7") {
      return json({ number: 7, head: { sha: "head-sha" }, base: { sha: "base-tip" } });
    }
    if (request.path === "/repos/acme/api/compare/base-tip...head-sha") {
      return json({ merge_base_commit: mergeBase, commits: [] });
    }
    if (request.path === "/repos/acme/api/pulls/7/files") {
      return json(files[Number(request.query?.page ?? 1) - 1] ?? []);
    }
    return json({ message: "Not Found" }, 404);
  };
}

describe("getPullRequestContent", () => {
  it("lists the changed files with their statuses, from the merge base to the head", async () => {
    const { requests } = installAjour(
      pullRequestRoutes([
        [
          file({ filename: "src/api.ts" }),
          file({ filename: "src/new.ts", status: "added", additions: 3, deletions: 0 }),
          file({ filename: "src/old.ts", status: "removed", additions: 0, deletions: 4 }),
          file({ filename: "src/moved.ts", previous_filename: "src/before.ts", status: "renamed", additions: 0, deletions: 0, changes: 0, patch: undefined }),
          file({ filename: "src/mode.sh", status: "changed", additions: 0, deletions: 0, changes: 0, patch: undefined }),
          file({ filename: "assets/logo.png", additions: 0, deletions: 0, changes: 0, patch: undefined }),
        ],
      ]),
    );

    await expect(getPullRequestContent(connection, ref)).resolves.toEqual({
      headSha: "head-sha",
      baseSha: "merge-base",
      files: [
        { path: "src/api.ts", status: "modified", additions: 1, deletions: 1, binary: false },
        { path: "src/new.ts", status: "added", additions: 3, deletions: 0, binary: false },
        { path: "src/old.ts", status: "removed", additions: 0, deletions: 4, binary: false },
        { path: "src/moved.ts", previousPath: "src/before.ts", status: "renamed", additions: 0, deletions: 0, binary: false },
        { path: "src/mode.sh", status: "modified", additions: 0, deletions: 0, binary: false },
        { path: "assets/logo.png", status: "modified", additions: 0, deletions: 0, binary: true },
      ],
    });
    expect(requests.map((request) => request.label)).toEqual([
      "GET rest /repos/acme/api/pulls/7",
      "GET rest /repos/acme/api/compare/base-tip...head-sha",
      "GET rest /repos/acme/api/pulls/7/files",
    ]);
    // The second page of a comparison holds no files, only the merge base.
    expect(requests[1]?.query).toEqual({ per_page: 1, page: 2 });
    expect(requests[2]?.query).toEqual({ per_page: 100, page: 1 });
  });

  it("reads every page of files, up to GitHub's 3,000", async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => file({ filename: `src/f${start + index}.ts` }));
    const { requests } = installAjour(pullRequestRoutes([page(0, 100), page(100, 100), page(200, 5)]));

    const content = await getPullRequestContent(connection, ref);

    expect(content.files).toHaveLength(205);
    expect(content.files[204]?.path).toBe("src/f204.ts");
    expect(requests.filter((request) => request.path.endsWith("/files")).map((request) => request.query?.page)).toEqual([1, 2, 3]);
  });

  it("starts from the base branch's tip when GitHub names no merge base", async () => {
    installAjour(pullRequestRoutes([[file({ filename: "src/api.ts" })]], null));

    await expect(getPullRequestContent(connection, ref)).resolves.toMatchObject({ baseSha: "base-tip" });
  });

  it("names the repository segments encoded, and fails with GitHub's message when the pull request is gone", async () => {
    const { requests } = installAjour(() => json({ message: "Not Found" }, 404));

    await expect(getPullRequestContent(connection, { repository: "acme/my api", number: 7 })).rejects.toThrow(
      "GitHub request failed (404): Not Found.",
    );
    expect(requests[0]?.path).toBe("/repos/acme/my%20api/pulls/7");
  });
});

describe("getFileContent", () => {
  function contents(respond: (request: SeenRequest) => ReturnType<typeof json>) {
    return installAjour((request) => {
      if (!request.path.startsWith("/repos/acme/api/contents/")) return json({ message: "Not Found" }, 404);
      return respond(request);
    });
  }

  it("reads a file's text at the commit, raw", async () => {
    const { requests } = contents(() => ({ status: 200, body: "export const a = 1;\n" }));

    await expect(
      getFileContent(connection, { repository: "acme/api", sha: "head-sha", path: "src/a b/c#d.ts" }),
    ).resolves.toEqual({ kind: "text", content: "export const a = 1;\n" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      label: "GET rest /repos/acme/api/contents/src/a%20b/c%23d.ts",
      query: { ref: "head-sha" },
      headers: { accept: "application/vnd.github.raw+json" },
    });
  });

  it("answers binary for a file with a NUL byte", async () => {
    contents(() => ({ status: 200, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) }));

    await expect(
      getFileContent(connection, { repository: "acme/api", sha: "head-sha", path: "assets/logo.png" }),
    ).resolves.toEqual({ kind: "binary" });
  });

  it("answers binary for a file longer than Ajour reads, 5,000,000 characters", async () => {
    contents(() => ({ status: 200, body: "a".repeat(5_000_001) }));

    await expect(
      getFileContent(connection, { repository: "acme/api", sha: "head-sha", path: "data/big.csv" }),
    ).resolves.toEqual({ kind: "binary" });
  });

  it("answers missing when the file is not at that commit", async () => {
    contents(() => json({ message: "Not Found" }, 404));

    await expect(
      getFileContent(connection, { repository: "acme/api", sha: "base-sha", path: "src/new.ts" }),
    ).resolves.toEqual({ kind: "missing" });
  });

  it("fails with a plain message when the token is rejected", async () => {
    contents(() => ({ status: 401, body: "" }));

    await expect(
      getFileContent(connection, { repository: "acme/api", sha: "head-sha", path: "src/a.ts" }),
    ).rejects.toThrow("GitHub rejected the token. Check that it is valid and not expired.");
  });
});
