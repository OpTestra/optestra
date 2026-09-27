import type {
  AttemptStatus,
  CheckResult,
  Decider,
  HealProposal,
  StepResult,
  Verdict,
} from "@testament/contract";

// Verdicts (HEAL-2), decided by code from the checks and steps, never by a
// model (VER-2). A test passes only if every hard check of its final attempt
// passed; pending checks and checks that prove nothing fail it (guarantee 4).
// Blocked only for "couldn't run" reasons; a failed step inside an included
// flow is a failure like any other.

export interface AttemptFailure {
  /** The failing check or step (the contract decider). */
  decider: Extract<Decider, { kind: "check" | "step" }>;
  /** DIA-3: the one line that matters. */
  headline: string;
}

export interface AttemptBlock {
  reason: string;
  message: string;
  stepIndex: number | null;
}

/** One finished attempt as the verdict needs it. */
export interface AttemptRecord {
  attempt: number;
  status: AttemptStatus;
  steps: readonly StepResult[];
  checks: readonly CheckResult[];
  heals: readonly HealProposal[];
  failure: AttemptFailure | null;
  blocked: AttemptBlock | null;
}

export interface VerdictDecision {
  verdict: Verdict;
  decidedBy: Decider[];
  headline: string | null;
  /** EVD-3: what the final attempt checked, from the checks themselves. */
  checkedSummary: string[];
  /** The attempt whose failure the cause describes (failed / flaky). */
  failedAttempt: number | null;
}

/** The deciders that make an attempt a pass: every hard check, else every step that ran. */
function passingDeciders(attempt: AttemptRecord): Decider[] {
  const checks = attempt.checks.filter((c) => !c.soft && c.passed);
  if (checks.length > 0)
    return checks.map((c) => ({ kind: "check", attempt: attempt.attempt, checkId: c.id }));
  return attempt.steps
    .filter((s) => s.status === "passed")
    .map((s) => ({ kind: "step", attempt: attempt.attempt, stepIndex: s.index }));
}

export function checkedSummary(attempt: AttemptRecord | undefined): string[] {
  if (!attempt) return [];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const check of [...attempt.checks].sort((a, b) => Number(a.soft) - Number(b.soft))) {
    const line = `${check.generated.description}${check.soft ? " (soft)" : ""}${check.passed ? "" : ": failed"}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/** The verdict from a test's attempts (in order). */
export function decideVerdict(attempts: readonly AttemptRecord[]): VerdictDecision {
  const last = attempts.at(-1);
  if (!last) throw new Error("a test needs at least one attempt");
  const summary = checkedSummary(last);
  if (last.status === "blocked") {
    const block = last.blocked ?? { reason: "aborted", message: "The test could not run." };
    return {
      verdict: "blocked",
      decidedBy: [{ kind: "blocked", reason: block.reason, message: block.message }],
      headline: `Blocked: ${block.message}`,
      checkedSummary: summary,
      failedAttempt: null,
    };
  }
  if (last.status === "failed") {
    if (!last.failure) throw new Error(`attempt ${last.attempt} failed without a failing decider`);
    return {
      verdict: "failed",
      decidedBy: [last.failure.decider],
      headline: last.failure.headline,
      checkedSummary: summary,
      failedAttempt: last.attempt,
    };
  }
  const passing = passingDeciders(last);
  if (passing.length === 0) throw new Error(`attempt ${last.attempt} passed with nothing that ran`);
  const failed = [...attempts].reverse().find((a) => a.status === "failed");
  if (failed?.failure) {
    return {
      verdict: "flaky",
      decidedBy: [failed.failure.decider, ...passing],
      headline: `Flaky: attempt ${failed.attempt} failed (${failed.failure.headline}), attempt ${last.attempt} passed.`,
      checkedSummary: summary,
      failedAttempt: failed.attempt,
    };
  }
  return {
    verdict: last.heals.length > 0 ? "healed" : "passed",
    decidedBy: passing,
    headline: last.heals.length > 0 ? healedHeadline(last.heals) : null,
    checkedSummary: summary,
    failedAttempt: null,
  };
}

/** "Passed after 2 heals (1 by AI), proposed for review." (HEAL-4: nothing is fixed silently). */
function healedHeadline(heals: readonly HealProposal[]): string {
  const n = heals.length;
  const byAi = heals.filter((h) => h.level === "fixer").length;
  const how = byAi === 0 ? " without AI" : byAi === n ? " by AI" : "";
  const applied = heals.filter((h) => h.status === "accepted").length;
  const notes = [
    ...(how ? [] : [`${byAi} by AI`]),
    applied === 0
      ? "proposed for review"
      : applied === n
        ? "applied to the recording: heal policy auto"
        : `${applied} applied by the auto policy, ${n - applied} for review`,
  ];
  return `Passed after ${n} heal${n === 1 ? "" : "s"}${how} (${notes.join("; ")}).`;
}

/**
 * A cause when failure_cause couldn't decide (DIA-1 still needs one): a flaky
 * test's is the environment; a failed check is a product bug; an element that
 * couldn't be found is test drift; a time-out or server trouble is the
 * environment.
 */
export function fallbackCause(
  failure: AttemptFailure,
  steps: readonly StepResult[],
  verdict: "failed" | "flaky" = "failed",
): "product_bug" | "test_drift" | "environment" {
  // It passed on the retry with nothing changed: the environment, not the app or the test.
  if (verdict === "flaky") return "environment";
  if (failure.decider.kind === "check") return "product_bug";
  const index = failure.decider.stepIndex;
  const step = steps.find((s) => s.index === index);
  if (step?.postState?.status === "mismatch") return "product_bug";
  if (/time limit|timed out|server error|5\d\d\b|network/i.test(step?.error ?? ""))
    return "environment";
  return "test_drift";
}
