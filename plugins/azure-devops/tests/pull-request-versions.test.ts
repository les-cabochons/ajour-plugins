import { afterEach, describe, expect, it, vi } from "vitest";
import { getPullRequestVersions } from "../src/plugin.ts";
import { label, pluginConnection, READ_ONLY_ACCESS, serveFixture } from "./support/azure-ajour.ts";
import {
  BASE_1,
  BASE_2,
  change,
  commitOf,
  createAzureFixture,
  HEAD_1,
  HEAD_2,
  PROJECT,
  PROJECT_ID,
} from "./support/azure-fixture.ts";

/*
 * A pull request's versions for Deck's versions bar (les-cabochons/ajour#787):
 * on Azure DevOps, its iterations, each with its head, the common commit
 * it is compared with, when it was pushed and its commits. Every request
 * goes through the fake Ajour with the real plugin.json, behind it the
 * stateful fixture.
 */

const ORGANIZATION = "https://dev.azure.com/contoso";
const ref = { repository: `${PROJECT}/api`, number: 12 };
const PULL_REQUEST = `/${PROJECT_ID}/_apis/git/repositories/repo-1/pullRequests/12`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getPullRequestVersions", () => {
  it("lists each iteration with its head, its common commit, its push and its commits oldest first", async () => {
    const fixture = createAzureFixture(ORGANIZATION);
    fixture.push(HEAD_2, BASE_2, [change(1, "/src/limits.ts", "edit")], {}, {
      reason: "forcePush",
      push: { date: "2026-10-03T08:00:00Z" },
      commits: [commitOf(HEAD_2, "Rebase on main", "2026-10-03T07:00:00Z")],
    });
    const { requests } = serveFixture(fixture);

    await expect(getPullRequestVersions(pluginConnection(), ref)).resolves.toEqual({
      versionName: "iteration",
      versions: [
        {
          number: 1,
          headSha: HEAD_1,
          baseSha: BASE_1,
          pushedAt: Date.parse("2026-10-02T08:59:00Z"),
          commits: [
            {
              sha: "c0ffee00000000000000000000000000000000c1",
              headline: "Add the limits file",
              authorName: "Alba",
              createdAt: Date.parse("2026-10-02T08:00:00Z"),
            },
            { sha: HEAD_1, headline: "Raise the limit", authorName: "Alba", createdAt: Date.parse("2026-10-02T08:30:00Z") },
          ],
        },
        {
          number: 2,
          headSha: HEAD_2,
          baseSha: BASE_2,
          pushedAt: Date.parse("2026-10-03T08:00:00Z"),
          forced: true,
          commits: [{ sha: HEAD_2, headline: "Rebase on main", authorName: "Alba", createdAt: Date.parse("2026-10-03T07:00:00Z") }],
        },
      ],
    });
    expect(requests.map(label)).toEqual(["GET /_apis/git/pullrequests/12", `GET ${PULL_REQUEST}/iterations`]);
    expect(requests[1]!.query).toEqual({ includeCommits: true, "api-version": "7.1" });
  });

  it("dates an iteration by its creation when Azure DevOps names no push, and counts a rebase as rewriting the branch", async () => {
    const fixture = createAzureFixture(ORGANIZATION);
    fixture.push(HEAD_2, BASE_2, [], {}, { reason: "rebase", push: {} });
    serveFixture(fixture);

    const { versions } = await getPullRequestVersions(pluginConnection(), ref);

    expect(versions[1]).toMatchObject({ number: 2, pushedAt: Date.parse("2026-10-03T09:00:00Z"), forced: true, commits: [] });
  });

  it("reads them with read-only pull request access", async () => {
    serveFixture(createAzureFixture(ORGANIZATION));

    const { versions } = await getPullRequestVersions(pluginConnection({}, { access: READ_ONLY_ACCESS }), ref);

    expect(versions.map((version) => version.headSha)).toEqual([HEAD_1]);
  });

  it("fails when Azure DevOps doesn't find the pull request", async () => {
    serveFixture(createAzureFixture(ORGANIZATION));

    await expect(getPullRequestVersions(pluginConnection(), { ...ref, number: 99 })).rejects.toThrow(
      "Azure DevOps could not find the pull request.",
    );
  });
});
