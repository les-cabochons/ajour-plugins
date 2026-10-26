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
    manifest.apiVersion = 2;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(
      /API version/,
    );
  });

  it.each([[{}], [{ settle: true }], [undefined]])(
    "rejects capabilities %j",
    (capabilities) => {
      const manifest = cloneManifest();
      manifest.capabilities = capabilities;

      expect(() => assertConnectorPluginManifest(manifest)).toThrow(
        /capabilities/,
      );
    },
  );

  it("declares issues as a connector with settle and written descriptions, and pull requests as a code host", () => {
    expect(cloneManifest().capabilities).toEqual({
      connector: { settle: true, description: { write: true, maxLength: 65536 } },
      codeHost: {},
    });
  });

  it("names the token permission writing issues needs", () => {
    const token = validManifest.connectionFields.find((field: { id: string }) => field.id === "token");
    expect(token.helpText).toContain("Issues permission set to Read and write");
  });

  it.each([[{ write: "yes" }], [{ maxLength: 0 }], [{ maxLength: 1.5 }], [true]])(
    "rejects the description capability %j",
    (description) => {
      const manifest = cloneManifest();
      manifest.capabilities.connector.description = description;

      expect(() => assertConnectorPluginManifest(manifest)).toThrow(/description/);
    },
  );

  it("tags the fields only one capability uses", () => {
    const capabilityOf = (id: string) =>
      validManifest.connectionFields.find((field: { id: string }) => field.id === id)?.capability;
    expect(capabilityOf("token")).toBeUndefined();
    expect(capabilityOf("include")).toBeUndefined();
    expect(capabilityOf("hideDrafts")).toBe("codeHost");
    expect(capabilityOf("autoSync")).toBe("connector");
    expect(capabilityOf("pullRequestAutoSync")).toBe("codeHost");
  });

  it("rejects a field tagged with a capability the plugin does not declare", () => {
    const manifest = cloneManifest();
    delete manifest.capabilities.connector;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/capability must name/);
  });
});

describe("plugin API 4", () => {
  it("declares API version 4 and rejects an API 3 manifest", () => {
    expect(validManifest.apiVersion).toBe(4);
    const manifest = cloneManifest();
    manifest.apiVersion = 3;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/API version must be 4/);
  });

  it("keeps the token a secret field that is never passed to the plugin", () => {
    const token = validManifest.connectionFields.find((field: { id: string }) => field.id === "token");
    expect(token).toMatchObject({ type: "password", secret: true });
    expect(token).not.toHaveProperty("passToPlugin");
  });
});

describe("network declaration", () => {
  it("lets Ajour's broker attach the token as a bearer credential, to the GitHub URL's connection", () => {
    expect(validManifest.network.auth).toEqual({ scheme: "bearer", secretField: "token" });
    expect(validManifest.network.baseAddress).toEqual({ field: "hostUrl", allowOnPremises: true });
  });

  it("derives the REST host: api.github.com on GitHub.com, /api/v3 on Enterprise Server", () => {
    const rest = validManifest.network.derivedHosts.find((host: { id: string }) => host.id === "rest");
    expect(rest.forms).toEqual([
      { whenHost: "github.com", host: "api.{host}", keepBasePath: false },
      { host: "{host}", pathPrefix: "/api/v3", keepBasePath: false },
    ]);
    expect(rest.endpoints.map((endpoint: { method: string; path: string }) => `${endpoint.method} ${endpoint.path}`)).toEqual([
      "GET /repos/*/*/activity",
      "GET /repos/*/*/issues/*",
      "PATCH /repos/*/*/issues/*",
      "GET /repositories/*/activity",
      "GET /repositories/*/issues/*",
      "PATCH /repositories/*/issues/*",
    ]);
  });

  it("derives the GraphQL host: api.github.com/graphql on GitHub.com, /api/graphql on Enterprise Server", () => {
    const graphql = validManifest.network.derivedHosts.find((host: { id: string }) => host.id === "graphql");
    expect(graphql.forms).toEqual([
      { whenHost: "github.com", host: "api.{host}", keepBasePath: false },
      { host: "{host}", pathPrefix: "/api", keepBasePath: false },
    ]);
    expect(graphql.endpoints).toEqual([{ method: "POST", path: "/graphql" }]);
  });

  it("calls nothing on the GitHub URL itself", () => {
    expect(validManifest.network.endpoints).toBeUndefined();
  });

  it("lists only the headers the plugin sets, never the credential's", () => {
    expect(validManifest.network.requestHeaders).toEqual(["Accept", "Content-Type", "User-Agent", "X-GitHub-Api-Version"]);
  });

  it("loads the plugin when needed", () => {
    expect(validManifest.runtime).toEqual({ start: "whenNeeded" });
    expect(validManifest.connectionAccess).toBeUndefined();
  });

  it("requires a network declaration", () => {
    const manifest = cloneManifest();
    delete manifest.network;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/network/);
  });

  it.each([
    ["a basic scheme", (manifest: any) => (manifest.network.auth = { scheme: "basic", userField: "label", secretField: "token" })],
    ["a secret field that is not secret", (manifest: any) => (manifest.network.auth.secretField = "include")],
    ["a base address that is not a url field", (manifest: any) => (manifest.network.baseAddress.field = "label")],
    ["an endpoint on the GitHub URL itself", (manifest: any) => (manifest.network.endpoints = [{ method: "GET", path: "/user" }])],
    ["no derived hosts", (manifest: any) => (manifest.network.derivedHosts = [])],
    ["two derived hosts with one id", (manifest: any) => (manifest.network.derivedHosts[1].id = "rest")],
    ["a derived host without forms", (manifest: any) => (manifest.network.derivedHosts[0].forms = [])],
    ["a form without whenHost before another", (manifest: any) => manifest.network.derivedHosts[0].forms.reverse()],
    ["an absolute endpoint", (manifest: any) => (manifest.network.derivedHosts[1].endpoints[0].path = "https://evil.test/graphql")],
    ["an endpoint with a trailing slash", (manifest: any) => (manifest.network.derivedHosts[1].endpoints[0].path = "/graphql/")],
    ["an unknown method", (manifest: any) => (manifest.network.derivedHosts[1].endpoints[0].method = "TRACE")],
    ["no endpoints on a derived host", (manifest: any) => (manifest.network.derivedHosts[1].endpoints = [])],
    ["the Authorization header", (manifest: any) => manifest.network.requestHeaders.push("authorization")],
    ["an X-Forwarded header", (manifest: any) => manifest.network.requestHeaders.push("X-Forwarded-For")],
  ])("rejects %s", (_name, change) => {
    const manifest = cloneManifest();
    change(manifest);

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/network/);
  });
});
