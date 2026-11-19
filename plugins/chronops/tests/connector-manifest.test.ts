import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertProjectSourcePluginManifest } from "./connector-manifest.mjs";

const validManifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));

function cloneManifest() {
  return structuredClone(validManifest);
}

describe("project source and time sync manifest packaging contract", () => {
  it("accepts the repository manifest", () => {
    expect(assertProjectSourcePluginManifest(cloneManifest())).toEqual(validManifest);
  });

  it("declares plugin API 4, the projectSource capability and timeSync beside it", () => {
    expect(validManifest.apiVersion).toBe(4);
    expect(validManifest.capabilities).toEqual({ projectSource: {}, timeSync: {} });
    expect(validManifest.entrypoint).toBe("src/plugin.ts");
  });

  it("rejects timeSync without projectSource, and an option on timeSync", () => {
    const alone = cloneManifest();
    delete alone.capabilities.projectSource;
    expect(() => assertProjectSourcePluginManifest(alone)).toThrow(/must declare projectSource/);

    const option = cloneManifest();
    option.capabilities.timeSync = { running: true };
    expect(() => assertProjectSourcePluginManifest(option)).toThrow(/takes no option/);
  });

  it("sends the personal token as X-ChronOps-Token and lists the headers the plugin sets", () => {
    const { network, connectionFields } = validManifest;
    expect(network.auth).toEqual({
      scheme: "headerTemplate",
      header: "X-ChronOps-Token",
      template: "{secret}",
      secretField: "personalToken",
    });
    const tokenField = connectionFields.find((field: { id: string }) => field.id === "personalToken");
    expect(tokenField).toMatchObject({ type: "password", secret: true, required: true });
    // Time entries writes, so the help no longer asks for a read token.
    expect(tokenField.placeholder).not.toMatch(/read token/);
    expect(tokenField.helpText).toMatch(/Time entries need a read-write token/);
    expect(network.baseAddress).toEqual({ field: "forwarderUrl", allowOnPremises: true });
    expect(connectionFields.find((field: { id: string }) => field.id === "forwarderUrl")).toMatchObject({
      type: "url",
      defaultValue: "https://chronops-forwarder.minehunter.az.nventive.com",
    });
    // Ajour's broker refuses a header the manifest does not list: the source
    // tag on every request, the cursor sent as an ETag on the snapshot, and
    // the JSON type of a Time Entry write.
    expect(network.requestHeaders).toEqual(["X-ChronOps-Source", "If-None-Match", "Content-Type"]);
    // Only the Time Entry routes the time sync calls. `*` is one path segment,
    // the entry's id. The plain timer stop is left out on purpose: it stops
    // whichever timer runs, such as one another tool started.
    expect(network.endpoints).toEqual([
      { method: "GET", path: "/integration/me" },
      { method: "GET", path: "/integration/snapshot" },
      { method: "GET", path: "/integration/entries" },
      { method: "POST", path: "/integration/entries" },
      { method: "PATCH", path: "/integration/entries/*" },
      { method: "DELETE", path: "/integration/entries/*" },
      { method: "POST", path: "/integration/entries/timer/start" },
      { method: "POST", path: "/integration/entries/*/stop" },
      { method: "GET", path: "/integration/change-marker" },
    ]);
    // The change marker's HEAD goes to Azure Storage with ajour.publicFetch,
    // which reaches exact hosts only: MineHunter's markers account.
    expect(network.publicHosts).toEqual(["stchronopsmarkers.blob.core.windows.net"]);
  });

  it.each([
    ["displayName", undefined],
    ["iconSvg", undefined],
    ["connectionFields", []],
    ["network", undefined],
  ])("rejects an invalid %s", (field, value) => {
    const manifest = cloneManifest();
    manifest[field] = value;
    expect(() => assertProjectSourcePluginManifest(manifest)).toThrow();
  });

  it("rejects another API version", () => {
    const manifest = cloneManifest();
    manifest.apiVersion = 3;
    expect(() => assertProjectSourcePluginManifest(manifest)).toThrow(/API version/);
  });

  it("rejects a token field that is not secret", () => {
    const manifest = cloneManifest();
    manifest.connectionFields.find((field: { id: string }) => field.id === "personalToken").secret = false;
    expect(() => assertProjectSourcePluginManifest(manifest)).toThrow(/secretField/);
  });

  it("rejects a header the broker never lets a plugin set, or one the auth scheme sets", () => {
    const authorization = cloneManifest();
    authorization.network.requestHeaders.push("Authorization");
    expect(() => assertProjectSourcePluginManifest(authorization)).toThrow(/Authorization/);

    const token = cloneManifest();
    token.network.requestHeaders.push("x-chronops-token");
    expect(() => assertProjectSourcePluginManifest(token)).toThrow(/auth scheme sets/);
  });

  it("rejects a template without the secret and an absolute endpoint", () => {
    const template = cloneManifest();
    template.network.auth.template = "Bearer token";
    expect(() => assertProjectSourcePluginManifest(template)).toThrow(/\{secret\}/);

    const endpoint = cloneManifest();
    endpoint.network.endpoints.push({ method: "GET", path: "https://example.com/x" });
    expect(() => assertProjectSourcePluginManifest(endpoint)).toThrow(/relative/);
  });
});
