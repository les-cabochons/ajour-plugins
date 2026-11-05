import { afterEach, expect, it, vi } from "vitest";
import * as plugin from "../src/plugin.ts";
import {
  ALL_ACCESS,
  pluginConnection,
  stubAzureFetch,
} from "./support/azure-ajour.ts";
import {
  createAzureFixture,
  PROJECT,
  ORIGINAL_ESTIMATE,
} from "./support/azure-fixture.ts";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["https://dev.azure.com/contoso", "https://dev.azure.com/contoso"],
  ["https://dev.azure.com/contoso/", "https://dev.azure.com/contoso"],
  ["https://dev.azure.com/contoso/Mercury", "https://dev.azure.com/contoso"],
  ["https://dev.azure.com/contoso/Mercury///", "https://dev.azure.com/contoso"],
  [
    "https://dev.azure.com/contoso/Mercury/_git/api",
    "https://dev.azure.com/contoso",
  ],
  ["https://contoso.visualstudio.com", "https://contoso.visualstudio.com"],
  ["https://contoso.visualstudio.com/", "https://contoso.visualstudio.com"],
  [
    "https://contoso.visualstudio.com/Mercury/_git/api/",
    "https://contoso.visualstudio.com",
  ],
  [
    "https://contoso.visualstudio.com/Mercury/",
    "https://contoso.visualstudio.com",
  ],
  [
    "https://contoso.visualstudio.com/DefaultCollection/",
    "https://contoso.visualstudio.com",
  ],
  [
    "https://contoso.visualstudio.com/DefaultCollection/Mercury/",
    "https://contoso.visualstudio.com",
  ],
  [
    "http://ado.contoso.local:8080/tfs/DefaultCollection/",
    "http://ado.contoso.local:8080/tfs/DefaultCollection",
  ],
])(
  "keeps an API 3 connection saved as %s working with its tracked ids",
  async (savedUrl, root) => {
    const fixture = createAzureFixture(root);
    const calls: string[] = [];
    const brokerAccess = [...ALL_ACCESS];
    const identitiesRoot =
      root === "https://dev.azure.com/contoso"
        ? "https://vssps.dev.azure.com/contoso"
        : root === "https://contoso.visualstudio.com"
          ? "https://contoso.vssps.visualstudio.com"
          : root;
    stubAzureFetch(
      async (address, init) => {
        const url = new URL(address);
        const identities = url.pathname.endsWith("/_apis/identities");
        const expectedRoot = identities ? identitiesRoot : root;
        expect(url.origin).toBe(new URL(expectedRoot).origin);
        expect(
          url.pathname.startsWith(
            new URL(expectedRoot).pathname.replace(/\/+$/, "") + "/",
          ),
        ).toBe(true);
        const path = url.pathname.slice(
          new URL(expectedRoot).pathname.replace(/\/+$/, "").length,
        );
        calls.push(`${init.method} ${path}`);
        const answer = fixture.answer({
          method: init.method,
          path,
          query: url.searchParams,
          body: init.body,
          identities,
        });
        return new Response(
          answer.json === undefined
            ? (answer.body ?? "")
            : JSON.stringify(answer.json),
          {
            status: answer.status,
            headers: { "content-type": "application/json", ...answer.headers },
          },
        );
      },
      { baseAddress: savedUrl, access: brokerAccess },
    );
    const connection = pluginConnection({
      organizationUrl: savedUrl,
      originalEstimateFieldName: "Original Estimate",
    });
    // API 3 built source IDs from the saved URL, then appended the item's project.
    const sourceId = `${savedUrl.replace(/\/+$/, "")}/${PROJECT}/_workitems/edit/42`;
    const tracked = {
      localWorkItemId: "existing-local-42",
      sourceId,
      originalEstimateHours: 6,
      estimateSync: {
        originalEstimateHours: { baselineValue: 4, remoteValue: 4 },
      },
    };
    const validated = await plugin.validateConnection!(connection, {
      capabilities: ["connector", "codeHost"],
    });
    expect(validated.normalizedConfig.organizationUrl).toBe(
      savedUrl.replace(/\/+$/, ""),
    );
    const synced = await plugin.syncConnection!(connection, [tracked]);
    expect(synced.items).toContainEqual(
      expect.objectContaining({ externalId: "42", sourceId }),
    );
    expect(synced.workItemUpdates).toContainEqual(
      expect.objectContaining({ localWorkItemId: "existing-local-42" }),
    );
    expect(fixture.items.get(42)!.fields[ORIGINAL_ESTIMATE]).toBe(6);
    expect(calls).toContain(
      `POST ${savedUrl.includes("/Mercury") ? "/Mercury" : ""}/_apis/wit/wiql`,
    );
    calls.length = 0;
    const refreshed = await plugin.syncConnection!(connection, [tracked], {
      sourceIds: [sourceId],
    });
    expect(refreshed.items).toContainEqual(
      expect.objectContaining({ externalId: "42", sourceId }),
    );
    expect(calls.some((call) => call.includes("wiql"))).toBe(false);
    const prs = await plugin.syncPullRequests!(connection, {
      tracked: [{ number: 12, repository: `${PROJECT}/api` }],
    });
    expect(prs.instanceUrl).toBe(root);
    expect(prs.pullRequests).toContainEqual(
      expect.objectContaining({
        id: "12",
        number: 12,
        url: `${root}/${PROJECT}/_git/api/pullrequest/12`,
      }),
    );
    await expect(
      plugin.listSettleStates!(connection, { sourceId }),
    ).resolves.toBeDefined();
    await plugin.writeSettle!(connection, { sourceId, state: "Resolved" });
    expect(fixture.items.get(42)!.fields["System.State"]).toBe("Resolved");
    const posted = await plugin.postItemComment!(connection, {
      sourceId,
      body: "Still connected after upgrade",
    });
    const page = await plugin.listItemComments!(connection, {
      sourceId,
      limit: 20,
    });
    expect(page.comments).toContainEqual(
      expect.objectContaining({
        id: posted.comment.id,
        body: "Still connected after upgrade",
      }),
    );
    const people = await plugin.searchItemPeople!(connection, {
      sourceId,
      query: "alan",
      limit: 5,
    });
    expect(people.people).toContainEqual(
      expect.objectContaining({ displayName: "Alan Turing" }),
    );
    const readOnly = { ...connection, access: ["readBacklog"] };
    // The broker owns access enforcement, so change its connection choices too.
    brokerAccess.splice(0, brokerAccess.length, "readBacklog");
    await expect(
      plugin.writeSettle!(readOnly, { sourceId, state: "Closed" }),
    ).rejects.toThrow(/editWorkItems/);
    expect(connection.config.organizationUrl).toBe(savedUrl);
  },
);
