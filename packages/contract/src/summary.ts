import { VERDICTS, type Verdict } from "./enums.js";
import type { Run, Totals } from "./run.js";

export interface RunSummary {
  totals: Totals;
  durationMs: number;
  costUsd: number;
  unpricedCalls: number;
  aiCalls: number;
  /** e.g. "3 passed, 1 healed, 1 failed". Verdicts with no tests are left out. */
  line: string;
}

export function summarize(run: Run): RunSummary {
  const parts = VERDICTS.filter((v) => run.totals[v] > 0).map((v) => `${run.totals[v]} ${v}`);
  // 1.5 (DIA-5): muted tests are counted under their verdict and named apart.
  if (run.totals.muted) parts.push(`${run.totals.muted} muted`);
  return {
    totals: run.totals,
    durationMs: run.durationMs,
    costUsd: run.cost.usd,
    unpricedCalls: run.cost.unpricedCalls,
    aiCalls: run.cost.aiCalls,
    line: parts.length > 0 ? parts.join(", ") : "no tests ran",
  };
}

export const EXIT_CODES = { ok: 0, failed: 1, blocked: 2 } as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface ExitPolicy {
  /** Healed tests count as passed (e.g. the heal policy is `auto`). Otherwise they fail the run. */
  healedCountsAsPass: boolean;
  /** Flaky tests fail the run. Default true: flaky is never hidden as a pass (DIA-2). */
  flakyCountsAsFailure?: boolean;
}

/**
 * CLI-5 exit code. First match wins:
 *   1  any failed test
 *   1  any flaky test, unless flakyCountsAsFailure is false
 *   1  any healed test, unless healedCountsAsPass
 *   2  the run itself was blocked (config_error, aborted, …)
 *   2  any blocked test
 *   2  no tests ran
 *   0  everything else (passed, plus healed/flaky where the policy allows)
 * Failures outrank blocks: a run with both exits 1.
 */
export function exitCodeFor(run: Run, policy: ExitPolicy): ExitCode {
  // 1.5 (DIA-5): a muted test's verdict doesn't count (it ran, and is reported apart).
  const counted = run.tests.filter((t) => !t.muted);
  const has = (verdict: Verdict) =>
    counted.length === run.tests.length
      ? run.totals[verdict] > 0
      : counted.some((t) => t.verdict === verdict);
  if (has("failed")) return EXIT_CODES.failed;
  if (has("flaky") && policy.flakyCountsAsFailure !== false) return EXIT_CODES.failed;
  if (has("healed") && !policy.healedCountsAsPass) return EXIT_CODES.failed;
  if (run.blocked || has("blocked") || run.totals.tests === 0) return EXIT_CODES.blocked;
  return EXIT_CODES.ok;
}

/** "850ms", "4.2s", "3m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** "$0.00", "$0.0123", "$1.25". Small amounts keep four decimals. */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
