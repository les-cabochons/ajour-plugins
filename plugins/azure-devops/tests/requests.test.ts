import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordedHttpRequest } from "@ajour/plugin-sdk/testing";
import * as plugin from "../src/plugin.ts";
import { TOKEN_REJECTED } from "../src/azure-devops.ts";
import {
  ALL_ACCESS,
  installAjour,
  label,
  ORGANIZATION_URL,
  pluginConnection,
  READ_ONLY_ACCESS,
} from "./support/azure-ajour.ts";
import { createAzureFixture, ORIGINAL_ESTIMATE, PROJECT, PROJECT_ID, VIEWER, type AzureFixture } from "./support/azure-fixture.ts";

/*
 * Each operation's requests as `ajour.http` receives them, through the SDK's
 * fake with this repository's manifest: the host, method, path, query and
 * content type, and what a connection's access choices let through.
 */

const SOURCE = (id: number) => `${ORGANIZATION_URL}/${PROJECT}/_workitems/edit/${id}`;
const MUTATING = new Set(["PATCH", "PUT", "DELETE"]);

let fixture: AzureFixture;
/** The requests the fixture answered: those the fake's manifest and access let through. */
let answered: RecordedHttpRequest[];

function install(access: readonly string[] = ALL_ACCESS) {
  fixture = createAzureFixture(ORGANIZATION_URL);
  answered = [];
  return installAjour(
    (request) => {
      answered.push(request);
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(request.query ?? {})) query.append(key, String(value));
      return fixture.answer({
        method: request.method,
        path: request.path,
        query,
        ...(request.bodyText !== undefined ? { body: request.bodyText } : {}),
        identities: request.host === "identities",
      });
    },
    { access },
  );
}

function connection(access: readonly string[] = ALL_ACCESS, config: Record<string, string | number | boolean> = {}) {
  return pluginConnection({ originalEstimateFieldName: "Original Estimate", ...config }, { access: [...access] });
}

const v71 = { "api-version": "7.1" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the requests each operation sends", () => {
  it("validates work items with the field list and a WIQL query, as JSON", async () => {
    const fake = install();

    await plugin.validateConnection!(connection(), { capabilities: ["connector"] });

    expect(fake.requests.map(label)).toEqual(["GET /_apis/wit/fields", "POST /_apis/wit/wiql"]);
    expect(fake.requests[0]).toMatchObject({ query: v71, headers: { accept: "application/json" } });
    expect(fake.requests[0]!.headers["content-type"]).toBeUndefined();
    expect(fake.requests[1]).toMatchObject({
      query: { $top: 200, "api-version": "7.1" },
      headers: { accept: "application/json", "content-type": "application/json" },
    });
    expect(JSON.parse(fake.requests[1]!.bodyText!).query).toContain("[System.AssignedTo] = @Me");
    expect(fake.requests.every((request) => request.host === undefined && !("authorization" in request.headers))).toBe(true);
  });

  it("syncs with WIQL, two batch reads, the states, and pushes an estimate as a JSON patch", async () => {
    const fake = install();

    const result = await plugin.syncConnection!(connection(), [
      {
        localWorkItemId: "local-42",
        sourceId: SOURCE(42),
        originalEstimateHours: 6,
        estimateSync: { originalEstimateHours: { baselineValue: 4, remoteValue: 4 } },
      },
    ]);

    expect(fake.requests.map(label)).toEqual([
      "GET /_apis/wit/fields",
      "POST /_apis/wit/wiql",
      "POST /_apis/wit/workitemsbatch",
      "POST /_apis/wit/workitemsbatch",
      "POST /_apis/wit/workitemsbatch",
      "POST /_apis/wit/workitemsbatch",
      `GET /${PROJECT}/_apis/wit/workitemtypes/Task/states`,
      `GET /${PROJECT}/_apis/wit/workitemtypes/User%20Story/states`,
      "PATCH /_apis/wit/workitems/42",
    ]);
    const patch = fake.requests.at(-1)!;
    expect(patch).toMatchObject({ query: v71, headers: { "content-type": "application/json-patch+json" } });
    expect(JSON.parse(patch.bodyText!)).toEqual([{ op: "add", path: `/fields/${ORIGINAL_ESTIMATE}`, value: 6 }]);
    expect(fixture.items.get(42)!.fields[ORIGINAL_ESTIMATE]).toBe(6);
    expect(result.workItemUpdates).toMatchObject([
      { localWorkItemId: "local-42", fields: { originalEstimateHours: { status: "pushed", nextBaselineValue: 6 } } },
    ]);
  });

  it("reads a settled item's comments since its settle, with the comments API's version", async () => {
    const fake = install();

    const result = await plugin.syncConnection!(connection(), [
      { localWorkItemId: "local-7", sourceId: SOURCE(7), commentsSince: "2026-10-22T00:00:00Z" },
    ]);

    expect(result.commentFacts).toMatchObject([
      { localWorkItemId: "local-7", comments: [{ id: "5", mentionsViewer: true }] },
    ]);
    const comments = fake.requests.find((request) => request.path === `/${PROJECT}/_apis/wit/workItems/7/comments`)!;
    expect(comments).toMatchObject({ method: "GET", query: { $top: 20, order: "desc", "api-version": "7.1-preview.4" } });
  });

  it("lists settle states and writes a state as a JSON patch", async () => {
    const fake = install();

    await expect(plugin.listSettleStates!(connection(), { sourceId: SOURCE(42) })).resolves.toMatchObject({
      states: expect.arrayContaining([{ name: "Closed", category: "Completed", done: true }]),
    });
    await expect(plugin.writeSettle!(connection(), { sourceId: SOURCE(42), state: "Closed" })).resolves.toMatchObject({
      state: "Closed",
      stateDone: true,
    });

    expect(fake.requests.map(label)).toEqual([
      "GET /_apis/wit/workitems/42",
      `GET /${PROJECT}/_apis/wit/workitemtypes/Task/states`,
      "PATCH /_apis/wit/workitems/42",
      `GET /${PROJECT}/_apis/wit/workitemtypes/Task/states`,
    ]);
    expect(fake.requests[0]!.query).toEqual({ fields: "System.State,System.WorkItemType,System.TeamProject", "api-version": "7.1" });
    expect(fake.requests[2]).toMatchObject({ query: v71, headers: { "content-type": "application/json-patch+json" } });
  });

  it("reads and writes a description, testing the revision in the patch", async () => {
    const fake = install();

    const read = await plugin.readDescription!(connection(), { sourceId: SOURCE(42) });
    expect(read).toEqual({ description: { text: "Steps for **login**" } });
    const written = await plugin.writeDescription!(connection(), {
      sourceId: SOURCE(42),
      expected: "Steps for **login**",
      text: "Steps for **login** and logout",
    });

    expect(written).toMatchObject({ outcome: "written", description: { text: "Steps for **login** and logout" } });
    expect(fake.requests.map(label)).toEqual([
      "GET /_apis/wit/workitems/42",
      "GET /_apis/wit/workitems/42",
      "PATCH /_apis/wit/workitems/42",
    ]);
    expect(fake.requests.every((request) => JSON.stringify(request.query) === JSON.stringify(v71))).toBe(true);
    const patch = fake.requests[2]!;
    expect(patch.headers["content-type"]).toBe("application/json-patch+json");
    expect(JSON.parse(patch.bodyText!)[0]).toEqual({ op: "test", path: "/rev", value: 3 });
  });

  it("lists, posts, edits and deletes comments, and sets a reaction, under the item's project", async () => {
    const fake = install();

    const page = await plugin.listItemComments!(connection(), { sourceId: SOURCE(42), limit: 10, cursor: "next" });
    expect(page.viewer).toEqual({ id: VIEWER, displayName: "Ada Lovelace" });
    const posted = await plugin.postItemComment!(connection(), { sourceId: SOURCE(42), body: "On it" });
    const id = posted.comment.id;
    await plugin.editItemComment!(connection(), { sourceId: SOURCE(42), commentId: id, body: "On it now" });
    await expect(
      plugin.setItemCommentReaction!(connection(), { sourceId: SOURCE(42), commentId: id, reaction: "heart", reacted: true }),
    ).resolves.toEqual({ reactions: [{ reaction: "heart", count: 1, viewerReacted: true }] });
    await plugin.deleteItemComment!(connection(), { sourceId: SOURCE(42), commentId: id });

    const comments = `/${PROJECT}/_apis/wit/workItems/42/comments`;
    const seen = fake.requests.filter((request) => request.path.startsWith(comments));
    expect(seen.map((request) => [label(request), request.query, request.headers["content-type"]])).toEqual([
      [
        `GET ${comments}`,
        { $top: 10, order: "desc", $expand: "renderedText,reactions", "api-version": "7.1-preview.4", continuationToken: "next" },
        undefined,
      ],
      [`POST ${comments}`, { format: "markdown", "api-version": "7.1-preview.4" }, "application/json"],
      [`PATCH ${comments}/${id}`, { format: "markdown", "api-version": "7.1-preview.4" }, "application/json"],
      [`PUT ${comments}/${id}/reactions/heart`, { "api-version": "7.1-preview.1" }, undefined],
      [`GET ${comments}/${id}`, { $expand: "reactions", "api-version": "7.1-preview.4" }, undefined],
      [`DELETE ${comments}/${id}`, { "api-version": "7.1-preview.4" }, undefined],
    ]);
    expect(fake.requests.filter((request) => request.path === "/_apis/wit/workitems/42").every((request) =>
      request.query?.fields === "System.TeamProject",
    )).toBe(true);
  });

  it("searches the organisation's people on the identities host, beside the item's and the project's", async () => {
    const fake = install();

    const result = await plugin.searchItemPeople!(connection(), { sourceId: SOURCE(42), query: "al", limit: 10 });

    expect(result.people).toEqual([
      { id: "44444444-4444-4444-4444-444444444444", displayName: "Alba Reyes", email: "alba@contoso.com" },
      { id: "66666666-6666-6666-6666-666666666666", displayName: "Alan Turing" },
    ]);
    const identities = fake.requests.find((request) => request.host === "identities")!;
    expect(label(identities)).toBe("GET identities /_apis/identities");
    expect(identities.query).toEqual({
      searchFilter: "General",
      filterValue: "al",
      queryMembership: "None",
      "api-version": "7.1",
    });
    expect(fake.requests.filter((request) => request.host === undefined).map(label).sort()).toEqual([
      `GET /${PROJECT}/_apis/wit/workItems/42/comments`,
      "GET /_apis/wit/workitems/42",
      "POST /_apis/wit/workitemsbatch",
      `POST /${PROJECT}/_apis/wit/wiql`,
    ].sort());
  });

  it("syncs pull requests: viewer, teams, the searches, then each one's threads, iterations and checks", async () => {
    const fake = install();

    const result = await plugin.syncPullRequests!(connection(), { tracked: [] });

    expect(result.pullRequests.map((facts) => [facts.number, facts.checks, facts.url])).toEqual([
      [12, "success", `${ORGANIZATION_URL}/${PROJECT}/_git/api/pullrequest/12`],
    ]);
    const details = `/${PROJECT_ID}/_apis/git/repositories/repo-1/pullRequests/12`;
    expect(fake.requests.map((request) => [label(request), request.query])).toEqual([
      ["GET /_apis/connectionData", undefined],
      ["GET /_apis/teams", { $mine: true, $top: 100, $skip: 0, "api-version": "7.1-preview.3" }],
      ["GET /_apis/git/pullrequests", { $top: 1, "api-version": "7.1" }],
      [
        "GET /_apis/git/pullrequests",
        { "searchCriteria.status": "active", "searchCriteria.creatorId": VIEWER, $top: 100, $skip: 0, "api-version": "7.1" },
      ],
      [
        "GET /_apis/git/pullrequests",
        { "searchCriteria.status": "active", "searchCriteria.reviewerId": VIEWER, $top: 100, $skip: 0, "api-version": "7.1" },
      ],
      [`GET ${details}/threads`, v71],
      [`GET ${details}/iterations`, v71],
      [
        `GET /${PROJECT_ID}/_apis/policy/evaluations`,
        { artifactId: `vstfs:///CodeReview/CodeReviewId/${PROJECT_ID}/12`, "api-version": "7.1-preview.1" },
      ],
    ]);
  });
});

describe("a connection's access choices", () => {
  it("lets a read-only connection sync, with its WIQL and batch POSTs, and sends no mutation", async () => {
    const fake = install(READ_ONLY_ACCESS);

    // Ajour holds the estimates of a connection that can't edit work items:
    // the plugin sees the agreed value, so it has nothing to push.
    const result = await plugin.syncConnection!(connection(READ_ONLY_ACCESS), [
      {
        localWorkItemId: "local-42",
        sourceId: SOURCE(42),
        originalEstimateHours: 4,
        estimateSync: { originalEstimateHours: { baselineValue: 4, remoteValue: 4 } },
      },
    ]);

    expect(result.items.map((item) => [item.externalId, item.parentSourceId])).toEqual([["42", SOURCE(40)]]);
    expect(answered.map(label)).toContain("POST /_apis/wit/wiql");
    expect(answered.map(label)).toContain("POST /_apis/wit/workitemsbatch");
    expect(fake.requests.some((request) => MUTATING.has(request.method))).toBe(false);
  });

  it("has Ajour's broker refuse every write of a read-only connection before it reaches Azure DevOps", async () => {
    install(READ_ONLY_ACCESS);
    const readOnly = connection(READ_ONLY_ACCESS);

    await expect(plugin.writeSettle!(readOnly, { sourceId: SOURCE(42), state: "Closed" })).rejects.toThrow(
      /hasn't turned on the access choice "editWorkItems"/,
    );
    await expect(
      plugin.writeDescription!(readOnly, { sourceId: SOURCE(42), expected: "Steps for **login**", text: "Changed" }),
    ).rejects.toThrow(/editWorkItems/);
    await expect(plugin.postItemComment!(readOnly, { sourceId: SOURCE(42), body: "Hi" })).rejects.toThrow(/editWorkItems/);
    await expect(
      plugin.setItemCommentReaction!(readOnly, { sourceId: SOURCE(42), commentId: "1", reaction: "like", reacted: true }),
    ).rejects.toThrow(/editWorkItems/);
    await expect(plugin.deleteItemComment!(readOnly, { sourceId: SOURCE(42), commentId: "1" })).rejects.toThrow(/editWorkItems/);

    expect(answered.some((request) => MUTATING.has(request.method) || request.path.endsWith("/comments") && request.method === "POST")).toBe(false);
    expect(fixture.items.get(42)!.fields["System.State"]).toBe("Active");
    // An estimate a sync pushed anyway would fail as an error, not change the item.
    const result = await plugin.syncConnection!(readOnly, [
      {
        localWorkItemId: "local-42",
        sourceId: SOURCE(42),
        originalEstimateHours: 6,
        estimateSync: { originalEstimateHours: { baselineValue: 4, remoteValue: 4 } },
      },
    ]);
    expect(result.workItemUpdates[0]!.fields.originalEstimateHours).toMatchObject({ status: "error" });
    expect(fixture.items.get(42)!.fields[ORIGINAL_ESTIMATE]).toBe(4);
  });

  it("keeps pull request endpoints closed without the pull request choice", async () => {
    install(["editWorkItems", "peopleSearch"]);

    await expect(
      plugin.syncPullRequests!(connection(["editWorkItems", "peopleSearch"], { includeTeamReviewRequests: false }), {
        tracked: [],
      }),
    ).rejects.toThrow(/pullRequests/);
    expect(answered.map(label)).toEqual(["GET /_apis/connectionData"]);
  });

  it("suggests the item's and the project's people, without asking the identities host, while people search is off", async () => {
    const fake = install(["editWorkItems"]);

    const result = await plugin.searchItemPeople!(connection(["editWorkItems"]), { sourceId: SOURCE(42), query: "al", limit: 10 });

    expect(result.people.map((person) => person.displayName)).toEqual(["Alba Reyes"]);
    expect(fake.requests.some((request) => request.host === "identities")).toBe(false);
  });

  it("finds the item's people on a bare @ without people search", async () => {
    const fake = install(READ_ONLY_ACCESS);

    const result = await plugin.searchItemPeople!(connection(READ_ONLY_ACCESS), { sourceId: SOURCE(42), query: "", limit: 10 });

    expect(result.people.map((person) => person.displayName)).toEqual(["Ada Lovelace", "Alba Reyes"]);
    expect(fake.requests.some((request) => request.host === "identities")).toBe(false);
  });
});

describe("a rejected token, as the broker hands it back", () => {
  const answers = {
    "a 401": { status: 401, body: "" },
    "a 203 with the sign-in page": { status: 203, headers: { "content-type": "text/html" }, body: "<html>Sign in</html>" },
    "a redirect to the sign-in host, not followed": {
      status: 302,
      headers: { location: "https://app.vssps.visualstudio.com/_signin?realm=dev.azure.com" },
      body: "",
    },
    "a redirect within the organization to a page the manifest does not declare": {
      status: 302,
      headers: { location: `${ORGANIZATION_URL}/_signin` },
      body: "",
    },
  };

  it.each(Object.entries(answers))("is recognised by the pull request client from %s", async (_name, answer) => {
    installAjour(() => answer);

    await expect(plugin.validateConnection!(connection(), { capabilities: ["codeHost"] })).rejects.toThrow(TOKEN_REJECTED);
    await expect(plugin.syncPullRequests!(connection(), { tracked: [] })).rejects.toThrow(TOKEN_REJECTED);
  });

  it.each(Object.entries(answers).slice(1))("is recognised by the work item requests from %s", async (_name, answer) => {
    installAjour(() => answer);

    await expect(plugin.validateConnection!(connection(), { capabilities: ["connector"] })).rejects.toThrow(TOKEN_REJECTED);
  });

  it("keeps the work items' 401 message", async () => {
    installAjour(() => ({ status: 401, json: { message: "Access denied" } }));

    await expect(plugin.validateConnection!(connection(), { capabilities: ["connector"] })).rejects.toThrow(
      "Azure DevOps request failed (401): Access denied",
    );
  });
});
