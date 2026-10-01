import type { Conclusion } from "./github.js";

// The status check (CI-3). The exit code comes from `run` / `merge-runs`, which
// apply the CLI-5 rules (`exitCodeFor`) with the project's heal policy; the
// results summary says why. Blocked is never red or green: a run whose worst
// outcome is "couldn't run" is NEUTRAL, with the reason.

/** The part of the CLI's JSON results summary (`results --json`) the Action reads. */
export interface Summary {
  runId: string;
  blocked: { reason: string; message: string } | null;
  totals: {
    tests: number;
    passed: number;
    healed: number;
    failed: number;
    flaky: number;
    blocked: number;
    /** Summary 1.2 (DIA-5). */
    muted?: number;
  };
  cost: { usd: number; aiCalls: number; subscriptionCalls: number };
  tests: {
    testId: string;
    name: string;
    verdict: "passed" | "healed" | "failed" | "flaky" | "blocked";
    headline: string | null;
    blocked: { reason: string; message: string } | null;
    heals: { id: string }[];
    screenshot: string | null;
    /** Summary 1.2 (DIA-5): muted tests don't fail the check. */
    muted?: { reason: string; until: string } | null;
  }[];
}

export interface CheckOutcome {
  conclusion: Conclusion;
  title: string;
}

const fixes = (n: number) => `${n} ${n === 1 ? "fix" : "fixes"}`;

function counts(summary: Summary): string {
  const t = summary.totals;
  const parts = (["passed", "healed", "failed", "flaky", "blocked"] as const)
    .filter((v) => t[v] > 0)
    .map((v) => `${t[v]} ${v}`);
  if (t.muted) parts.push(`${t.muted} muted`);
  return parts.length ? parts.join(", ") : "no tests ran";
}

function blockedReasons(summary: Summary): string {
  const reasons = new Map<string, number>();
  if (summary.blocked) reasons.set(summary.blocked.reason, 1);
  for (const test of summary.tests)
    if (test.blocked) reasons.set(test.blocked.reason, (reasons.get(test.blocked.reason) ?? 0) + 1);
  return [...reasons.keys()].map((r) => r.replaceAll("_", " ")).join(", ");
}

/**
 * success: exit 0 (everything passed; healed too when the heal policy is auto).
 * failure: exit 1 (a failed or flaky test, or a heal waiting for review), or no
 *          results at all (the run crashed: never hidden as neutral).
 * neutral: exit 2 with results: blocked tests or a blocked run, and no failures.
 */
export function checkOutcome(exitCode: number | null, summary: Summary | null): CheckOutcome {
  if (!summary)
    return {
      conclusion: "failure",
      title: "The run could not finish: no results were written",
    };
  const t = summary.totals;
  if (exitCode === 0) return { conclusion: "success", title: counts(summary) };
  if (exitCode === 1) {
    const why =
      t.failed + t.flaky > 0 ? counts(summary) : `${counts(summary)}: ${fixes(t.healed)} to review`;
    return { conclusion: "failure", title: why };
  }
  // A muted test's failure never turns the check red (DIA-5).
  const failing = summary.tests.filter(
    (test) => !test.muted && (test.verdict === "failed" || test.verdict === "flaky"),
  ).length;
  if (failing > 0) return { conclusion: "failure", title: counts(summary) };
  const reasons = blockedReasons(summary);
  return {
    conclusion: "neutral",
    title:
      t.tests === 0 && !summary.blocked
        ? "No tests ran"
        : `${counts(summary)}${reasons ? ` (blocked: ${reasons})` : ""}`,
  };
}
