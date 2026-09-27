import { defineConfig } from "vitest/config";

// doctor with a real browser, and an export run with plain npm and Playwright,
// against the real demo shop. Not part of `pnpm check`; run by
// `pnpm bench:fixtures:test` and CI `fixtures` (npm install needs the registry
// or its offline cache).
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
