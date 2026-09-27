import type { Expectation, Verdict } from "./manifest.js";

// Turns Playwright attempts into a Bench verdict, and checks it against gold.

export interface Attempt {
  passed: boolean;
  /** Title of the top-level step that failed, e.g. `6. Expect: a message says "Project created"`. */
  failedStep: string | null;
}

export interface Outcome {
  verdict: Verdict;
  step: number | null;
  failedStep: string | null;
}

export function stepNumber(title: string | null): number | null {
  const match = /^(\d+)\.\s/.exec(title ?? "");
  return match ? Number(match[1]) : null;
}

export function outcomeOf(attempts: readonly Attempt[]): Outcome {
  const first = attempts[0];
  if (!first) return { verdict: "failed", step: null, failedStep: null };
  if (first.passed) return { verdict: "passed", step: null, failedStep: null };
  const failed = { step: stepNumber(first.failedStep), failedStep: first.failedStep };
  if (attempts.some((attempt) => attempt.passed)) return { verdict: "flaky", ...failed };
  // A failing `Use:` flow (e.g. a broken login) is a failure at the Use: step, never
  // blocked: blocked would turn a broken login into a neutral CI result.
  return { verdict: "failed", ...failed };
}

/** Null when the outcome matches the gold answer, else what is wrong. */
export function mismatch(expected: Expectation, actual: Outcome): string | null {
  if (expected.verdict !== actual.verdict) {
    const where = actual.failedStep ? ` (at "${actual.failedStep}")` : "";
    return `expected ${expected.verdict}, got ${actual.verdict}${where}`;
  }
  if (expected.verdict !== "passed" && expected.step !== actual.step) {
    const where = actual.failedStep ?? "outside any step";
    return `expected the failure at step ${expected.step}, got it at "${where}"`;
  }
  return null;
}
