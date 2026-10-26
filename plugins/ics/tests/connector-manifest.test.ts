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

  it.each([{}, { connector: {} }, { calendar: {}, codeHost: {} }])(
    "rejects a manifest that does not declare only calendar: %j",
    (capabilities) => {
      const manifest = cloneManifest();
      manifest.capabilities = capabilities;

      expect(() => assertConnectorPluginManifest(manifest)).toThrow(
        /capabilities/,
      );
    },
  );

  it("declares API version 4 and a secret calendar address the broker fetches", () => {
    expect(validManifest.apiVersion).toBe(4);
    expect(validManifest.capabilities).toEqual({ calendar: {} });
    expect(
      validManifest.connectionFields.find(
        (field: { id: string }) => field.id === "calendarUrl",
      ),
    ).toMatchObject({ type: "url", required: true, secret: true });
    expect(validManifest.network).toEqual({
      auth: { scheme: "secretAddress", secretField: "calendarUrl" },
      requestHeaders: ["Accept"],
    });
    expect(validManifest.runtime).toEqual({ start: "whenNeeded" });
  });

  it("rejects a manifest without a network block or with another auth scheme", () => {
    const missing = cloneManifest();
    delete missing.network;
    expect(() => assertConnectorPluginManifest(missing)).toThrow(/network/);

    const bearer = cloneManifest();
    bearer.network.auth = { scheme: "bearer", secretField: "calendarUrl" };
    expect(() => assertConnectorPluginManifest(bearer)).toThrow(/secretAddress/);
  });

  it("rejects a secret address that is not a secret url field", () => {
    const notSecret = cloneManifest();
    notSecret.connectionFields.find(
      (field: { id: string }) => field.id === "calendarUrl",
    ).secret = false;
    expect(() => assertConnectorPluginManifest(notSecret)).toThrow(/secret url/);

    const unknown = cloneManifest();
    unknown.network.auth.secretField = "email";
    expect(() => assertConnectorPluginManifest(unknown)).toThrow(/secret url/);
  });

  it("rejects a base address, endpoints or hosts next to a secret address", () => {
    for (const [key, value] of [
      ["baseAddress", { field: "calendarUrl" }],
      ["endpoints", [{ method: "GET", path: "/feed.ics" }]],
      ["derivedHosts", []],
      ["publicHosts", ["example.com"]],
    ] as const) {
      const manifest = cloneManifest();
      manifest.network[key] = value;
      expect(() => assertConnectorPluginManifest(manifest), key).toThrow(
        /whole address/,
      );
    }
  });

  it("rejects a header the broker never lets a plugin set", () => {
    const manifest = cloneManifest();
    manifest.network.requestHeaders = ["Accept", "Authorization"];
    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/Authorization/);
  });

  it("keeps package.json and plugin.json on the same version", () => {
    const packageMetadata = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageMetadata.version).toBe(validManifest.version);
  });
});
