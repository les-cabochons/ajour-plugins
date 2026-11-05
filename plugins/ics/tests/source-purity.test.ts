import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCode } from "./support/source-code.ts";

/*
 * Plugin API 4 runs the source in a sandboxed worker: no Node, no network but
 * `ajour.http`, and no credential. Main strips the types of each file it
 * serves and nothing resolves a bare import, so every import is a relative
 * file with its extension. The vendored ical.js is a plain JavaScript file the
 * plugin imports by relative path; it must hold no Node use either.
 */

const sourceDirectory = new URL("../src/", import.meta.url);
const listed = readdirSync(sourceDirectory, { recursive: true, encoding: "utf8" }).map((name) =>
  name.replaceAll("\\", "/"),
);
// ical.d.ts only gives ical.js its types; it is erased and never served.
const files = listed.filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts")).sort();
const vendored = listed.filter((name) => name.startsWith("vendor/") && name.endsWith(".js")).sort();

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

/** `process` as a global; a method named `process` (ical.js has one) is not that. */
const processGlobal = /(?<![.\w$])process\b(?!\s*\()/;

function expectNoNode(code: string, withStrings: string, { vendor = false } = {}) {
  expect(code).not.toMatch(/\bfetch\s*\(/);
  expect(code).not.toMatch(/\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
  expect(code).not.toMatch(vendor ? processGlobal : /\bprocess\b/);
  expect(code).not.toMatch(/\bBuffer\b/);
  expect(code).not.toMatch(/\b(?:__dirname|__filename)\b/);
  expect(withStrings).not.toMatch(/["'`]node:/);
  expect(code).not.toMatch(/\bimport\s*\(/);
}

describe("the plugin source", () => {
  it("finds the source files", () => {
    expect(files).toEqual(["contract.ts", "events.ts", "feed.ts", "plugin.ts", "zones.ts"]);
    expect(vendored).toEqual(["vendor/ical.js"]);
  });

  describe.each(files)("%s", (file) => {
    const source = readFileSync(new URL(file, sourceDirectory), "utf8");
    const code = readCode(source);
    const withStrings = readCode(source, { keepStrings: true });

    it("calls no network API of its own and uses no Node API", () => {
      expectNoNode(code, withStrings);
    });

    it("holds no credential and builds no Authorization header", () => {
      expect(withStrings).not.toMatch(/authorization/i);
      expect(withStrings).not.toMatch(/\b(?:apiToken|password|secret)\b/i);
      expect(withStrings).not.toMatch(/\b(?:btoa|atob)\s*\(/);
    });

    it("never names the calendar address field or an address scheme", () => {
      expect(withStrings).not.toContain("calendarUrl");
      expect(withStrings).not.toMatch(/\bwebcals?:/);
      expect(withStrings).not.toMatch(/https?:\/\//);
    });

    it("imports only relative files with their extension, and types from the SDK", () => {
      const specifiers = [...withStrings.matchAll(/\b(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/g)];
      for (const [statement, , , specifier] of specifiers) {
        if (specifier!.startsWith("@ajour/plugin-sdk")) {
          expect(statement, `${file} imports runtime code from the SDK`).toMatch(/^\s*import\s+type\b/);
        } else {
          expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.{1,2}\/[^"']+\.(?:ts|js)$/);
        }
      }
      expect(withStrings).not.toMatch(/\bimport\s*["']/);
    });
  });

  describe.each(vendored)("%s", (file) => {
    const source = readFileSync(new URL(file, sourceDirectory), "utf8");
    const code = readCode(source);
    const withStrings = readCode(source, { keepStrings: true });

    it("uses no Node API and has no network call", () => {
      expectNoNode(code, withStrings, { vendor: true });
    });

    it("imports nothing and exports only its default", () => {
      expect(code).not.toMatch(/^\s*import\b/m);
      const exports = [...code.matchAll(/^\s*export\b[^;]*;/gm)].map(([statement]) => statement.trim());
      expect(exports).toEqual(["export { ICALmodule as default };"]);
    });
  });

  it("is imported from where the worker serves it: events.ts reaches ical.js by a relative path", () => {
    const events = readCode(readFileSync(new URL("events.ts", sourceDirectory), "utf8"), { keepStrings: true });
    expect(events).toMatch(/from\s*"\.\/vendor\/ical\.js"/);
  });
});
