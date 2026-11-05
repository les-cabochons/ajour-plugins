import { describe, expect, it } from "vitest";
import { withoutCommentsAndStrings } from "./support/code-only.ts";

describe("the code-only reader behind the source purity test", () => {
  it("blanks comments, strings, template text and regular expressions, and keeps the code that runs", () => {
    const code = [
      "// fetch(url) in a comment",
      "/* import x from 'y'; process */",
      "const a = 'fetch';",
      'const b = "require(x)";',
      "const c = `process ${a} Buffer`;",
      "const d = /[\"']fetch/g;",
      "const e = `${fetch(a)}`;",
    ].join("\n");

    const stripped = withoutCommentsAndStrings(code);

    expect(stripped.match(/\bfetch\b/g)).toHaveLength(1);
    expect(stripped).not.toMatch(/\b(?:process|Buffer|require|import)\b/);
    expect(stripped.split("\n")).toHaveLength(code.split("\n").length);
  });
});
