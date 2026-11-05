import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCode } from "./support/source-code.ts";

/*
 * Plugin API 4 runs the source in a sandboxed worker: no Node, no network but
 * `ajour.http`, and no credential. Main strips the types of each file it
 * serves and nothing resolves a bare import, so every import is a relative
 * file with its extension.
 */

const sourceDirectory = new URL("../src/", import.meta.url);
const files = readdirSync(sourceDirectory, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".ts"))
  .sort();

describe("the code check", () => {
  const sample = [
    "// fetch(url) in a comment",
    "/* process.env, Authorization */",
    "const a = 'fetch(';",
    'const b = "require(x)";',
    "const c = `Buffer ${a} process.`;",
    "const d = /[\"']fetch\(/g;",
    "const e = `${fetch(a)}`;",
  ].join("\n");

  it("reads code only, and keeps the line count", () => {
    const code = readCode(sample);
    expect(code.match(/\bfetch\b/g)).toHaveLength(1);
    expect(code).not.toMatch(/\b(?:process|Buffer|require|Authorization)\b/);
    expect(code.split("\n")).toHaveLength(sample.split("\n").length);
  });

  it("keeps strings when asked, but never comments", () => {
    const code = readCode(sample, { keepStrings: true });
    expect(code).toContain("require(x)");
    expect(code).toContain("Buffer ");
    expect(code).not.toContain("Authorization");
    expect(code).not.toContain("a comment");
  });
});

describe("the plugin source", () => {
  it("finds the source files", () => {
    expect(files).toContain("plugin.ts");
    expect(files).toHaveLength(7);
  });

  describe.each(files)("%s", (file) => {
    const source = readFileSync(new URL(file, sourceDirectory), "utf8");
    const code = readCode(source);
    const withStrings = readCode(source, { keepStrings: true });

    it("calls no network API of its own", () => {
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    });

    it("uses no Node API", () => {
      expect(code).not.toMatch(/\brequire\s*\(/);
      expect(code).not.toMatch(/\bprocess\b/);
      expect(code).not.toMatch(/\bBuffer\b/);
      expect(code).not.toMatch(/\b(?:__dirname|__filename)\b/);
      expect(withStrings).not.toMatch(/["'`]node:/);
    });

    it("holds no credential and builds no Authorization header", () => {
      expect(withStrings).not.toMatch(/authorization/i);
      expect(withStrings).not.toMatch(/\bBearer\b/);
      // The connection field that holds the credential, read or named.
      expect(withStrings).not.toMatch(/\.token\b/);
      expect(withStrings).not.toMatch(/\btoken\s*[:,}]/);
      expect(withStrings).not.toMatch(/["'`]token["'`]/);
      expect(withStrings).not.toMatch(/\b(?:btoa|atob)\s*\(/);
    });

    it("builds no GitHub address: every URL comes from the broker", () => {
      expect(withStrings).not.toContain("api.github.com");
      expect(withStrings).not.toContain("/api/v3");
      expect(withStrings).not.toContain("/api/graphql");
    });

    it("imports only relative files with their extension, and types from the SDK", () => {
      const specifiers = [...withStrings.matchAll(/\b(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/g)];
      for (const [statement, keyword, clause, specifier] of specifiers) {
        if (specifier!.startsWith("@ajour/plugin-sdk")) {
          expect(statement, `${file} imports runtime code from the SDK`).toMatch(/^\s*import\s+type\b/);
        } else {
          expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.{1,2}\/[^"']+\.ts$/);
        }
        expect(keyword).toMatch(/^(?:import|export)$/);
        expect(clause).toBeDefined();
      }
      expect(code).not.toMatch(/\bimport\s*\(/);
      expect(withStrings).not.toMatch(/\bimport\s*["']/);
    });
  });
});
