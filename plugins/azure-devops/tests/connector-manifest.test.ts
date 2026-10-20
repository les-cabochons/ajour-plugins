import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertConnectorPluginManifest } from "../scripts/connector-manifest.mjs";

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

  it("declares descriptions with Azure DevOps' length limit and rejects a bad one", () => {
    expect(validManifest.capabilities.connector.description).toEqual({ maxLength: 1_000_000 });

    const notWhole = cloneManifest();
    notWhole.capabilities.connector.description = { maxLength: 1.5 };
    expect(() => assertConnectorPluginManifest(notWhole)).toThrow(/maxLength/);

    const notBoolean = cloneManifest();
    notBoolean.capabilities.connector.description = { write: "yes" };
    expect(() => assertConnectorPluginManifest(notBoolean)).toThrow(/write/);
  });
});
