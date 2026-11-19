// Every tool's start names its thread with oneLineTitle, so these cases hold
// for T3 Code, Claude Code, Copilot CLI, OpenCode and Codex alike.
import assert from "node:assert/strict";
import { test } from "node:test";
import { oneLineTitle } from "../src/shared.ts";

test("a title of 80 characters stays whole", () => {
  const title = `[AJ-42] ${"x".repeat(72)}`;
  assert.equal(oneLineTitle(title), title);
});

test("a long word ends in an ellipsis at 80 characters, without half an emoji", () => {
  // No space in the second half, so the cut falls inside the word, between
  // the emoji's two UTF-16 halves, the 79th and 80th.
  const title = `[AJ-42] ${"x".repeat(70)}🚀 and more words after it`;
  const result = oneLineTitle(title);
  assert.equal(result, `[AJ-42] ${"x".repeat(70)}…`);
  assert.ok(result.length <= 80);
});
