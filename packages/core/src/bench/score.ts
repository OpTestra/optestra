import type { TestResult } from "@optestra/contract";

// Bench scoring (BEN-1, BEN-2): one test × variant result against the fixture's
// gold manifest. Scoring only reads results; it never changes one (guarantee 3).

export type FixtureId = "shop" | "android";

export interface Expectation {
  verdict: string;
  step?: number;
  cause?: string;
  reason?: string;
}

export interface Manifest {
  variants: Record<string, { also_accept?: { passed?: string[] } }>;
  tests: Record<string, Record<string, string | Expectation>>;
  harness: { retries: number };
}

/** match: right verdict (and cause); healed: passed after heals without AI; needs_ai: a miss only an AI heal could fix; mismatch: wrong. */
export type Score = "match" | "healed" | "needs_ai" | "mismatch";

/** One test × variant (× rerun) result, as Bench keeps it. */
export interface BenchRow {
  fixture: FixtureId;
  variant: string;
  test: string;
  /** 1-based; reruns of `correct` for the flake rate. */
  rerun: number;
  expected: Expectation;
  verdict: string;
  cause: string | null;
  /** The .test.md step where the (first) failing attempt stopped. */
  step: number | null;
  score: Score;
  note: string;
  aiCalls: number;
  costUsd: number;
  heals: { withoutAi: number; byFixer?: number; needsAi: number };
  /** Action steps that ran, and how they got done (HEAL-1 recovery). */
  steps: { ran: number; replayed: number; refound: number; byFixer: number; authored: number };
  durationMs: number;
}

/** The manifest's answer for a test × variant. */
export function expectation(manifest: Manifest, test: string, variant: string): Expectation {
  const entry = manifest.tests[test]?.[variant];
  if (entry === undefined) throw new Error(`manifest has no answer for ${test} × ${variant}`);
  return typeof entry === "string" ? { verdict: entry } : entry;
}

/** Scores one result against the manifest (the rules bench:replay has used since LOOP-4). */
export function scoreResult(
  manifest: Manifest,
  variant: string,
  expected: Expectation,
  result: Pick<TestResult, "verdict" | "failureCause" | "decidedBy" | "headline">,
  heals: { withoutAi: number; needsAi: number },
): { score: Score; note: string } {
  const blockedBy = result.decidedBy.find((d) => d.kind === "blocked");
  const accepted = [
    expected.verdict,
    ...(manifest.variants[variant]?.also_accept?.[expected.verdict as "passed"] ?? []),
  ];
  if (accepted.includes(result.verdict)) {
    if (expected.cause && result.failureCause !== expected.cause)
      return {
        score: "mismatch",
        note: `cause ${result.failureCause}, expected ${expected.cause}`,
      };
    return result.verdict === "healed"
      ? { score: "healed", note: `${heals.withoutAi} heal(s) without AI` }
      : { score: "match", note: "" };
  }
  if (variant === "cosmetic" && expected.verdict === "passed") {
    const aiOnly =
      heals.needsAi > 0 ||
      (result.verdict === "blocked" &&
        blockedBy?.kind === "blocked" &&
        blockedBy.reason === "ai_unavailable");
    if (aiOnly) return { score: "needs_ai", note: result.headline ?? "needs an AI heal" };
  }
  return {
    score: "mismatch",
    note: `got ${result.verdict}${result.failureCause ? ` (${result.failureCause})` : ""}: ${result.headline ?? ""}`,
  };
}

/** How the final attempt's action steps got done: replayed as recorded, re-found, fixed by AI, authored. */
export function stepStats(result: Pick<TestResult, "attempts">): BenchRow["steps"] {
  const attempt = result.attempts.at(-1);
  const stats = { ran: 0, replayed: 0, refound: 0, byFixer: 0, authored: 0 };
  for (const step of attempt?.steps ?? []) {
    if ((step.kind !== "action" && step.kind !== "exact") || step.status === "skipped") continue;
    stats.ran++;
    if (step.recovery === "replay") stats.replayed++;
    else if (step.recovery === "refind") stats.refound++;
    else if (step.recovery === "fixer") stats.byFixer++;
    else if (step.modelCallIds.length > 0) stats.authored++;
  }
  return stats;
}
