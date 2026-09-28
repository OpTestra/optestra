import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "test/**/*.test.ts",
      "bench/fixtures/*/src/**/*.test.ts",
      "bench/fixtures/*/e2e/**/*.test.ts",
      "docs/test/**/*.test.ts",
    ],
  },
});
