import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertConnectorPluginManifest } from "./connector-manifest.mjs";

const validManifest = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
);

function cloneManifest() {
  return structuredClone(validManifest);
}

describe("connector manifest packaging contract", () => {
  it("accepts the repository manifest", () => {
    expect(assertConnectorPluginManifest(cloneManifest())).toBeTruthy();
  });

  it.each([
    ["displayName", undefined],
    ["iconSvg", undefined],
    ["connectionFields", []],
  ])("rejects an invalid %s", (field, value) => {
    const manifest = cloneManifest();
    manifest[field] = value;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow();
  });

  it("rejects invalid nested connection fields", () => {
    const manifest = cloneManifest();
    manifest.connectionFields[0].defaultValue = { unsafe: true };

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(
      /defaultValue/,
    );
  });

  it("rejects unsupported API versions", () => {
    const manifest = cloneManifest();
    manifest.apiVersion = 1;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(
      /API version/,
    );
  });

  it.each([{}, { codeHost: {} }])("rejects a manifest without the connector capability: %j", (capabilities) => {
    const manifest = cloneManifest();
    manifest.capabilities = capabilities;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(
      /capabilities/,
    );
  });

  it("accepts a connector that also declares codeHost", () => {
    const manifest = cloneManifest();
    manifest.capabilities.codeHost = {};

    expect(assertConnectorPluginManifest(manifest)).toBe(manifest);
  });

  it("declares both capabilities and tags each part's fields", () => {
    expect(Object.keys(validManifest.capabilities)).toEqual(["connector", "codeHost"]);
    const capabilityOf = (id: string) =>
      validManifest.connectionFields.find((field: { id: string }) => field.id === id)?.capability;
    expect(capabilityOf("personalAccessToken")).toBeUndefined();
    expect(capabilityOf("queryScope")).toBe("connector");
    expect(capabilityOf("autoSync")).toBe("connector");
    expect(capabilityOf("autoSyncIntervalMinutes")).toBeUndefined();
    expect(capabilityOf("pullRequestsInclude")).toBe("codeHost");
    expect(capabilityOf("pullRequestAutoSync")).toBe("codeHost");
  });

  it("rejects a field tagged with a capability the plugin does not declare", () => {
    const manifest = cloneManifest();
    delete manifest.capabilities.codeHost;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/capability must name/);
  });

  it("declares the settle capability and rejects a non-boolean one", () => {
    expect(validManifest.capabilities.connector.settle).toBe(true);

    const manifest = cloneManifest();
    manifest.capabilities.connector.settle = "yes";

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/settle/);
  });

  it("declares that it writes descriptions, with Azure DevOps' length limit, and rejects a bad one", () => {
    expect(validManifest.capabilities.connector.description).toEqual({ write: true, maxLength: 1_000_000 });

    const notWhole = cloneManifest();
    notWhole.capabilities.connector.description = { maxLength: 1.5 };
    expect(() => assertConnectorPluginManifest(notWhole)).toThrow(/maxLength/);

    const notBoolean = cloneManifest();
    notBoolean.capabilities.connector.description = { write: "yes" };
    expect(() => assertConnectorPluginManifest(notBoolean)).toThrow(/write/);
  });
});

describe("plugin API 4", () => {
  it("declares API version 4 and rejects an API 3 manifest", () => {
    expect(validManifest.apiVersion).toBe(4);
    const manifest = cloneManifest();
    manifest.apiVersion = 3;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/API version must be 4/);
  });

  it("keeps the personal access token a secret field that is never passed to the plugin", () => {
    const token = validManifest.connectionFields.find((field: { id: string }) => field.id === "personalAccessToken");
    expect(token).toMatchObject({ type: "password", secret: true });
    expect(token).not.toHaveProperty("passToPlugin");
  });

  it("loads the plugin when needed", () => {
    expect(validManifest.runtime).toEqual({ start: "whenNeeded" });
  });
});

const endpointsOf = (endpoints: { method: string; path: string; access?: string }[]) =>
  endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}${endpoint.access ? ` [${endpoint.access}]` : ""}`);

describe("network declaration", () => {
  it("lets Ajour's broker attach the token as Basic credentials with an empty user, to the Organization URL's connection", () => {
    expect(validManifest.network.auth).toEqual({ scheme: "patBasic", secretField: "personalAccessToken" });
    expect(validManifest.network.baseAddress).toEqual({ field: "organizationUrl", allowOnPremises: true });
  });

  it("declares each endpoint the plugin calls on the Organization URL, behind its access choice", () => {
    expect(endpointsOf(validManifest.network.endpoints)).toEqual([
      "GET /_apis/connectionData",
      "POST /_apis/wit/wiql [readBacklog]",
      "POST /*/_apis/wit/wiql [readBacklog]",
      "POST /_apis/wit/workitemsbatch [readBacklog]",
      "GET /_apis/wit/fields [readBacklog]",
      "GET /_apis/wit/workitems/* [readBacklog]",
      "PATCH /_apis/wit/workitems/* [editWorkItems]",
      "GET /*/_apis/wit/workitemtypes/*/states [readBacklog]",
      "GET /*/_apis/wit/workitemtypes/*/fields [readBacklog]",
      "GET /*/_apis/wit/workItems/*/comments [readBacklog]",
      "POST /*/_apis/wit/workItems/*/comments [editWorkItems]",
      "GET /*/_apis/wit/workItems/*/comments/* [readBacklog]",
      "PATCH /*/_apis/wit/workItems/*/comments/* [editWorkItems]",
      "DELETE /*/_apis/wit/workItems/*/comments/* [editWorkItems]",
      "PUT /*/_apis/wit/workItems/*/comments/*/reactions/* [editWorkItems]",
      "DELETE /*/_apis/wit/workItems/*/comments/*/reactions/* [editWorkItems]",
      "GET /_apis/git/repositories [pullRequests]",
      "GET /_apis/git/pullrequests [pullRequests]",
      "GET /*/_apis/git/pullrequests [pullRequests]",
      "GET /_apis/git/pullrequests/* [pullRequests]",
      "GET /*/_apis/git/repositories/*/pullRequests/*/threads [pullRequests]",
      "GET /*/_apis/git/repositories/*/pullRequests/*/iterations [pullRequests]",
      "GET /*/_apis/policy/evaluations [pullRequests]",
      "GET /_apis/teams [pullRequests]",
    ]);
  });

  it("derives the people search host: vssps.{host} for dev.azure.com, {org}.vssps.visualstudio.com, the collection on a server", () => {
    expect(validManifest.network.derivedHosts).toEqual([
      {
        id: "identities",
        label: "People search",
        forms: [
          { whenHost: "dev.azure.com", host: "vssps.{host}" },
          { whenHost: "*.visualstudio.com", host: "{match}.vssps.visualstudio.com", keepBasePath: false },
          { host: "{host}" },
        ],
        endpoints: [{ method: "GET", path: "/_apis/identities", access: "peopleSearch" }],
      },
    ]);
  });

  it("lists only the headers the plugin sets, never the credential's", () => {
    expect(validManifest.network.requestHeaders).toEqual(["Accept", "Content-Type"]);
  });

  it("requires a network declaration", () => {
    const manifest = cloneManifest();
    delete manifest.network;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/network/);
  });

  it.each([
    ["a bearer scheme", (manifest: any) => (manifest.network.auth = { scheme: "bearer", secretField: "personalAccessToken" })],
    ["a secret field that is not secret", (manifest: any) => (manifest.network.auth.secretField = "label")],
    ["a base address that is not a url field", (manifest: any) => (manifest.network.baseAddress.field = "label")],
    ["no endpoints on the Organization URL", (manifest: any) => (manifest.network.endpoints = [])],
    ["two derived hosts with one id", (manifest: any) => manifest.network.derivedHosts.push(structuredClone(manifest.network.derivedHosts[0]))],
    ["a derived host without forms", (manifest: any) => (manifest.network.derivedHosts[0].forms = [])],
    ["a form without whenHost before another", (manifest: any) => manifest.network.derivedHosts[0].forms.reverse()],
    ["an absolute endpoint", (manifest: any) => (manifest.network.endpoints[0].path = "https://evil.test/_apis/connectionData")],
    ["an endpoint with a query", (manifest: any) => (manifest.network.endpoints[1].path = "/_apis/wit/wiql?api-version=7.1")],
    ["an endpoint with a trailing slash", (manifest: any) => (manifest.network.endpoints[0].path = "/_apis/connectionData/")],
    ["an unknown method", (manifest: any) => (manifest.network.endpoints[0].method = "TRACE")],
    ["an endpoint behind an undeclared choice", (manifest: any) => (manifest.network.endpoints[0].access = "everything")],
    ["the Authorization header", (manifest: any) => manifest.network.requestHeaders.push("authorization")],
    ["an X-Forwarded header", (manifest: any) => manifest.network.requestHeaders.push("X-Forwarded-For")],
  ])("rejects %s", (_name, change) => {
    const manifest = cloneManifest();
    change(manifest);

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/network/);
  });
});

describe("connection access", () => {
  // The same choices as Ajour's own table for this plugin on API 3
  // (packages/shared/connection-access.ts), so a migrated connection keeps its choices.
  it("declares Ajour's four Azure DevOps choices, by the same ids, each with its token scope", () => {
    expect(
      validManifest.connectionAccess.map((choice: any) => [choice.id, choice.label, choice.tokenScope, choice.always === true]),
    ).toEqual([
      ["readBacklog", "Read the backlog", "Work Items (Read)", true],
      ["editWorkItems", "Edit work items", "Work Items (Read & write)", false],
      ["pullRequests", "Pull requests", "Code (Read), and Project and Team (Read) for teams", false],
      ["peopleSearch", "Search people across the organisation", "Identity (Read)", false],
    ]);
  });

  it("gates every write, the estimate upload included, behind Edit work items", () => {
    const edit = validManifest.connectionAccess.find((choice: any) => choice.id === "editWorkItems");
    expect(edit.operations).toEqual([
      "writeSettle",
      "writeDescription",
      "postItemComment",
      "editItemComment",
      "deleteItemComment",
      "setItemCommentReaction",
      "pushEstimates",
    ]);
    const writes = [
      ...validManifest.network.endpoints,
      ...validManifest.network.derivedHosts.flatMap((host: any) => host.endpoints),
    ].filter((endpoint: any) => endpoint.method !== "GET" && endpoint.access !== "editWorkItems");
    // Reads that POST a query or a list of ids.
    expect(endpointsOf(writes)).toEqual([
      "POST /_apis/wit/wiql [readBacklog]",
      "POST /*/_apis/wit/wiql [readBacklog]",
      "POST /_apis/wit/workitemsbatch [readBacklog]",
    ]);
  });

  it("gates the code host operations behind Pull requests, and the organisation's people behind people search", () => {
    const choice = (id: string) => validManifest.connectionAccess.find((candidate: any) => candidate.id === id);
    expect(choice("pullRequests").operations).toContain("syncPullRequests");
    expect(choice("peopleSearch").operations).toEqual(["searchItemPeople"]);
    expect(choice("readBacklog").operations).toEqual([]);
  });

  it.each([
    ["two choices with one id", (manifest: any) => (manifest.connectionAccess[1].id = "readBacklog")],
    ["a choice without a token scope", (manifest: any) => delete manifest.connectionAccess[0].tokenScope],
    ["a choice id that is not camel case", (manifest: any) => (manifest.connectionAccess[0].id = "read-backlog")],
    ["an operation that is not a name", (manifest: any) => manifest.connectionAccess[1].operations.push("write settle")],
  ])("rejects %s", (_name, change) => {
    const manifest = cloneManifest();
    change(manifest);

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/connectionAccess/);
  });
});
