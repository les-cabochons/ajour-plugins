import { afterEach, describe, expect, it, vi } from "vitest";
import { getFileContent, getPullRequestContent } from "../src/plugin.ts";
import { label, pluginConnection, READ_ONLY_ACCESS, serveFixture } from "./support/azure-ajour.ts";
import {
  BASE_1,
  BASE_2,
  change,
  createAzureFixture,
  HEAD_1,
  HEAD_2,
  LIMITS_HEAD_1,
  PROJECT,
  PROJECT_ID,
} from "./support/azure-fixture.ts";

/*
 * What Deck reads to build an Azure DevOps pull request's diff
 * (les-cabochons/ajour#780): the latest iteration's changes against its
 * common commit, and each file's text at a commit. Every request goes
 * through the fake Ajour with the real plugin.json, so a request the
 * manifest doesn't declare, or one behind an access choice that is off, is
 * refused as Ajour's broker refuses it. Behind it, the stateful fixture
 * answers as Azure DevOps lays out its REST API.
 */

const ORGANIZATION = "https://dev.azure.com/contoso";
const connection = pluginConnection();
const readOnly = pluginConnection({}, { access: READ_ONLY_ACCESS });
const ref = { repository: `${PROJECT}/api`, number: 12 };
const PULL_REQUEST = `/${PROJECT_ID}/_apis/git/repositories/repo-1/pullRequests/12`;
const ITEMS = `/${PROJECT}/_apis/git/repositories/api/items`;

afterEach(() => {
  vi.unstubAllGlobals();
});

const fileOf = (path: string, status: string, previousPath?: string) => ({
  path,
  ...(previousPath ? { previousPath } : {}),
  status,
  additions: 0,
  deletions: 0,
  binary: false,
});

describe("getPullRequestContent", () => {
  it("lists the latest iteration's changes against its common commit: edits, additions, deletions and renames, a binary file as any other", async () => {
    const fixture = createAzureFixture(ORGANIZATION);
    const { requests } = serveFixture(fixture);

    await expect(getPullRequestContent(connection, ref)).resolves.toEqual({
      headSha: HEAD_1,
      baseSha: BASE_1,
      // The folder Azure DevOps lists beside its files is left out.
      files: [
        fileOf("src/limits.ts", "modified"),
        fileOf("src/new.ts", "added"),
        fileOf("src/old.ts", "removed"),
        fileOf("src/after.ts", "renamed", "src/before.ts"),
        fileOf("docs/guide.md", "renamed", "docs/read me.md"),
        fileOf("assets/logo.png", "modified"),
      ],
    });
    expect(requests.map(label)).toEqual([
      "GET /_apis/git/pullrequests/12",
      `GET ${PULL_REQUEST}/iterations`,
      `GET ${PULL_REQUEST}/iterations/1/changes`,
    ]);
    expect(requests[2]!.query).toEqual({ $compareTo: 0, $top: 2000, $skip: 0, "api-version": "7.1" });
  });

  it("reads the pair of the latest iteration after a push, compared with that iteration's common commit", async () => {
    const fixture = createAzureFixture(ORGANIZATION);
    fixture.push(HEAD_2, BASE_2, [change(1, "/src/limits.ts", "edit"), change(2, "/src/second.ts", "add")]);
    const { requests } = serveFixture(fixture);

    await expect(getPullRequestContent(connection, ref)).resolves.toEqual({
      headSha: HEAD_2,
      baseSha: BASE_2,
      files: [fileOf("src/limits.ts", "modified"), fileOf("src/second.ts", "added")],
    });
    expect(requests.map(label)).toContain(`GET ${PULL_REQUEST}/iterations/2/changes`);
  });

  it("reads every page of changes, 2,000 at a time", async () => {
    const fixture = createAzureFixture(ORGANIZATION);
    const many = Array.from({ length: 2_500 }, (_, index) => change(index + 1, `/src/file-${index}.ts`, "add"));
    fixture.push(HEAD_2, BASE_2, many);
    const { requests } = serveFixture(fixture);

    const content = await getPullRequestContent(connection, ref);

    expect(content.files).toHaveLength(2_500);
    expect(content.files.at(-1)).toEqual(fileOf("src/file-2499.ts", "added"));
    expect(
      requests.filter((request) => request.path.endsWith("/changes")).map((request) => request.query?.$skip),
    ).toEqual([0, 2000]);
  });

  it("fails rather than show part of a pull request that changes more than 3,000 files", async () => {
    const fixture = createAzureFixture(ORGANIZATION);
    fixture.push(
      HEAD_2,
      BASE_2,
      Array.from({ length: 3_001 }, (_, index) => change(index + 1, `/src/file-${index}.ts`, "edit")),
    );
    serveFixture(fixture);

    await expect(getPullRequestContent(connection, ref)).rejects.toThrow(
      "This pull request changes more than 3,000 files, more than Deck reads.",
    );
  });

  it("leaves out a submodule, and a file whose path, or previous path, is longer than Ajour reads", async () => {
    const fixture = createAzureFixture(ORGANIZATION);
    const long = `/src/${"a".repeat(1_000)}.ts`;
    const submodule = change(4, "/vendor/lib", "edit");
    submodule.item.gitObjectType = "commit";
    fixture.push(HEAD_2, BASE_2, [
      change(1, long, "edit"),
      change(2, "/src/short.ts", "edit, rename", long),
      change(3, "/src/kept.ts", "edit"),
      submodule,
    ]);
    serveFixture(fixture);

    await expect(getPullRequestContent(connection, ref)).resolves.toMatchObject({
      files: [fileOf("src/kept.ts", "modified")],
    });
  });

  it("reads the change types as Review Deck does: an addition or deletion first, then a rename, else an edit", async () => {
    const fixture = createAzureFixture(ORGANIZATION);
    fixture.push(HEAD_2, BASE_2, [
      change(1, "/src/a.ts", "add, edit"),
      change(2, "/src/b.ts", "delete, sourceRename"),
      change(3, "/src/c.ts", "edit, rename", "/src/c-before.ts"),
      // A rename Azure DevOps names no previous path for reads as an edit.
      change(4, "/src/d.ts", "rename"),
      change(5, "/src/e.ts", "edit, encoding"),
    ]);
    serveFixture(fixture);

    await expect(getPullRequestContent(connection, ref)).resolves.toMatchObject({
      files: [
        fileOf("src/a.ts", "added"),
        fileOf("src/b.ts", "removed"),
        fileOf("src/c.ts", "renamed", "src/c-before.ts"),
        fileOf("src/d.ts", "modified"),
        fileOf("src/e.ts", "modified"),
      ],
    });
  });

  it("fails when the latest iteration names no common commit, rather than diff from elsewhere", async () => {
    const fixture = createAzureFixture(ORGANIZATION);
    delete fixture.iterations[0]!.commonRefCommit;
    serveFixture(fixture);

    await expect(getPullRequestContent(connection, ref)).rejects.toThrow(
      "Azure DevOps didn't name the commits of this pull request's latest iteration.",
    );
  });

  it("fails with a plain message when the pull request is gone", async () => {
    serveFixture(createAzureFixture(ORGANIZATION));

    await expect(getPullRequestContent(connection, { ...ref, number: 404 })).rejects.toThrow(
      "Azure DevOps could not find the pull request.",
    );
  });

  it("fails with a plain message when the token is rejected", async () => {
    serveFixture(createAzureFixture(ORGANIZATION), {
      override: () => ({ status: 203, headers: { "content-type": "text/html" }, body: "<html>Sign in</html>" }),
    });

    await expect(getPullRequestContent(connection, ref)).rejects.toThrow(/rejected the token/);
  });

  it("is refused while the connection's Pull requests access is off", async () => {
    const { requests } = serveFixture(createAzureFixture(ORGANIZATION), { access: READ_ONLY_ACCESS });

    await expect(getPullRequestContent(readOnly, ref)).rejects.toThrow(/"pullRequests"/);
    expect(requests.map(label)).toEqual(["GET /_apis/git/pullrequests/12"]);
  });
});

describe("getFileContent", () => {
  it("reads a file's text at a commit, raw", async () => {
    const { requests } = serveFixture(createAzureFixture(ORGANIZATION));

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "src/limits.ts" }),
    ).resolves.toEqual({ kind: "text", content: LIMITS_HEAD_1 });
    expect(requests).toMatchObject([
      {
        method: "GET",
        path: ITEMS,
        query: {
          path: "/src/limits.ts",
          "versionDescriptor.version": HEAD_1,
          "versionDescriptor.versionType": "commit",
          "api-version": "7.1",
        },
        headers: { accept: "application/octet-stream" },
      },
    ]);
  });

  it("reads a renamed file's base version at its previous path, spaces and all", async () => {
    serveFixture(createAzureFixture(ORGANIZATION));

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: BASE_1, path: "docs/read me.md" }),
    ).resolves.toEqual({ kind: "text", content: "# Read me\n" });
  });

  it("answers binary for a file with a NUL byte", async () => {
    serveFixture(createAzureFixture(ORGANIZATION));

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "assets/logo.png" }),
    ).resolves.toEqual({ kind: "binary" });
  });

  it("answers binary for a file longer than Ajour reads, 5,000,000 characters", async () => {
    const fixture = createAzureFixture(ORGANIZATION);
    fixture.files.set(`${HEAD_1}:src/huge.ts`, "x".repeat(5_000_001));
    fixture.files.set(`${HEAD_1}:src/largest.ts`, "x".repeat(5_000_000));
    serveFixture(fixture);

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "src/huge.ts" }),
    ).resolves.toEqual({ kind: "binary" });
    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "src/largest.ts" }),
    ).resolves.toMatchObject({ kind: "text" });
  });

  it("answers binary when the broker refuses an answer over its size limit", async () => {
    serveFixture(createAzureFixture(ORGANIZATION), {
      override: () => {
        throw Object.assign(new Error("The service's answer is larger than 8 MB."), {
          name: "AjourRequestError",
          code: "limit",
        });
      },
    });

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "src/limits.ts" }),
    ).resolves.toEqual({ kind: "binary" });
  });

  it("answers missing when the file is not at that commit", async () => {
    serveFixture(createAzureFixture(ORGANIZATION));

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "src/old.ts" }),
    ).resolves.toEqual({ kind: "missing" });
  });

  it("names the project and repository encoded, and fails with Azure DevOps's message when it can't read the repository", async () => {
    const { requests } = serveFixture(createAzureFixture(ORGANIZATION));

    await expect(
      getFileContent(connection, { repository: "Fabrikam Web/web app", sha: HEAD_1, path: "src/limits.ts" }),
    ).rejects.toThrow("Azure DevOps request failed (404): TF401019");
    expect(requests.map(label)).toEqual(["GET /Fabrikam%20Web/_apis/git/repositories/web%20app/items"]);
  });

  it("fails with Azure DevOps's message on a 404 that doesn't say the item is missing, even without a type", async () => {
    serveFixture(createAzureFixture(ORGANIZATION), {
      override: () => ({
        status: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "TF401019: The Git repository with name or identifier api does not exist or you do not have permissions for the operation you are attempting.",
        }),
      }),
    });

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "src/limits.ts" }),
    ).rejects.toThrow("Azure DevOps request failed (404): TF401019");
  });

  it("fails on a 404 page that isn't Azure DevOps's, rather than call the file missing", async () => {
    serveFixture(createAzureFixture(ORGANIZATION), {
      override: () => ({ status: 404, headers: { "content-type": "text/html" }, body: "<html>Not Found</html>" }),
    });

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "src/limits.ts" }),
    ).rejects.toThrow("Azure DevOps request failed (404)");
  });

  it("answers missing for Azure DevOps's item-not-found error, even without a type", async () => {
    serveFixture(createAzureFixture(ORGANIZATION), {
      override: () => ({
        status: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "TF401174: The item '/src/limits.ts' could not be found in the repository 'api' at the version specified by '<Commit: abc>'.",
        }),
      }),
    });

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "src/limits.ts" }),
    ).resolves.toEqual({ kind: "missing" });
  });

  it("fails rather than read Azure DevOps's description of a file as its text", async () => {
    const description = { objectId: "blob-new-2", gitObjectType: "blob", commitId: HEAD_1, path: "/src/limits.ts" };
    serveFixture(createAzureFixture(ORGANIZATION), {
      override: () => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(description) }),
    });

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "src/limits.ts" }),
    ).rejects.toThrow("Azure DevOps answered with the file's description instead of its content.");
  });

  it("reads a JSON file served as JSON as its text", async () => {
    const text = '{ "name": "api", "version": "1.0.0" }\n';
    serveFixture(createAzureFixture(ORGANIZATION), {
      override: () => ({ status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: text }),
    });

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "package.json" }),
    ).resolves.toEqual({ kind: "text", content: text });
  });

  it("fails with Azure DevOps's status for any other refusal", async () => {
    serveFixture(createAzureFixture(ORGANIZATION), {
      override: () => ({ status: 500, headers: { "content-type": "application/json" }, body: '{"message":"Server busy"}' }),
    });

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "src/limits.ts" }),
    ).rejects.toThrow("Azure DevOps request failed (500): Server busy");
  });

  it("fails with a plain message when the token is rejected", async () => {
    serveFixture(createAzureFixture(ORGANIZATION), {
      override: () => ({ status: 401, body: "" }),
    });

    await expect(
      getFileContent(connection, { repository: ref.repository, sha: HEAD_1, path: "src/limits.ts" }),
    ).rejects.toThrow(/rejected the token/);
  });

  it("fails for a repository that isn't project/repository, without a request", async () => {
    const { requests } = serveFixture(createAzureFixture(ORGANIZATION));

    await expect(
      getFileContent(connection, { repository: "api", sha: HEAD_1, path: "src/limits.ts" }),
    ).rejects.toThrow('Azure DevOps names a repository "project/repository", not "api".');
    expect(requests).toEqual([]);
  });

  it("is refused while the connection's Pull requests access is off", async () => {
    serveFixture(createAzureFixture(ORGANIZATION), { access: READ_ONLY_ACCESS });

    await expect(
      getFileContent(readOnly, { repository: ref.repository, sha: HEAD_1, path: "src/limits.ts" }),
    ).rejects.toThrow(/"pullRequests"/);
  });
});
