import { defineConfig } from "vitest/config";

// The engine on the Android fixture app, on an emulator, with a scripted model (no
// AI). Not part of `pnpm check` (which needs no Android SDK); run by
// `pnpm --filter @optestra/core test:android` and the CI `android` job.
export default defineConfig({
  test: {
    include: ["e2e-android/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
