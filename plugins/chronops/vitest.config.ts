import { defineConfig } from "vitest/config";

// The contract tests in tests/contract.test.mjs run on node:test, not here.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
