import { defineConfig } from "vitest/config";

// The MCP server against the real demo shop: `run_tests` through the real
// runner (replay-only, no AI) and reading a failure. Not part of `pnpm check`;
// run by `pnpm bench:fixtures:test` and CI `fixtures`.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
