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

  it("declares issues as a connector with settle, and pull requests as a code host", () => {
    expect(cloneManifest().capabilities).toEqual({ connector: { settle: true }, codeHost: {} });
  });

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
