import type { RunTestsOptions } from "./run/runner.js";
import { VIEWPORT_LIMITS } from "./run/viewport.js";

// What this engine can do, as plain data (DESK-3's ask): the apps read it
// instead of sniffing exports or option names. `capabilitiesVersion` bumps
// when a field changes meaning; new fields and new names in lists are
// additive. `runTests.options` is checked against RunTestsOptions at compile
// time, so a new option can't be left out.

const RUN_TESTS_OPTIONS = [
  "projectDir",
  "tests",
  "cwd",
  "tags",
  "grep",
  "shard",
  "environment",
  "env",
  "mode",
  "retries",
  "workers",
  "budgetUsd",
  "headless",
  "browser",
  "device",
  "androidVersion",
  "browsers",
  "devices",
  "androidVersions",
  "emulator",
  "locale",
  "timezone",
  "viewport",
  "video",
  "evidence",
  "signal",
  "node",
  "trigger",
  "onEvent",
  "beforeAttempt",
  "secretSources",
  "models",
  "decisions",
  "generateSpecs",
  "checkTimeoutMs",
  "inbox",
] as const satisfies readonly (keyof RunTestsOptions)[];

// Every option of RunTestsOptions is in the list above (a compile error otherwise).
type Missing = Exclude<keyof RunTestsOptions, (typeof RUN_TESTS_OPTIONS)[number]>;
const everyOption: [Missing] extends [never] ? true : Missing = true;
void everyOption;

export const ENGINE_CAPABILITIES = {
  capabilitiesVersion: 1,
  runTests: {
    /** Every option `runTests` accepts. */
    options: RUN_TESTS_OPTIONS,
    /** TGT-5: one TestResult per cell, testId `<id>@<cell>`. */
    matrix: { web: ["browsers", "devices"], android: ["androidVersions", "devices"] },
    /** PERF-0: an AbortSignal stops cleanly (run blocked `aborted`). */
    signal: true,
    /** PERF-0: onEvent receives every event, `artifact.written` included. */
    artifactEvents: true,
    /** EVD-1 / PERF-0: `run.evidence` and `runTests({ evidence })`. */
    evidenceModes: ["full", "failures", "minimal"],
    /** TGT-3 / BEN-0: `viewport: { width, height }`, whole pixels, 200–7680. */
    viewport: VIEWPORT_LIMITS,
    /** ENV-5. */
    locale: true,
    timezone: true,
    /** PERF-0: the Node for JS subscription CLIs and code-step specs (the packaged app). */
    node: true,
    browsers: ["chromium", "firefox", "webkit"],
  },
  targets: ["web", "android"],
  /** HEAL-0: heal policies, review and accept (`listHeals`, `applyHeals`). */
  heals: { policies: ["strict", "review", "auto"], review: true },
  /** AGT-0: `draftTest` (write a test from a goal) and the MCP server. */
  draftTest: true,
  mcp: true,
  /** CLI-1 / PERF-0: `runDoctor({ secretSources, node })` in @optestra/cli. */
  doctor: { secretSources: true, node: true },
  /** BEN-0: the CLI's `bench`, model evals and the `eval` gate (`@optestra/core/bench`). */
  bench: { fixtures: ["shop", "android"], models: true, evalGate: true, measures: true },
} as const;

export type EngineCapabilities = typeof ENGINE_CAPABILITIES;
