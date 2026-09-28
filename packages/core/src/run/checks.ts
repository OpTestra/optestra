import type { CheckKind, CheckResult } from "@testament/contract";
import { type CheckOp, type CheckRecording, describeCheck } from "@testament/recording";
import type { CheckEvaluation } from "../target/harness.js";

// A recorded check → the contract's CheckResult (VER-1). Every run evaluates
// the check again (LRN-2); nothing from authoring is reused as a result.

/** The contract's check kind for an op. */
export function checkKindOf(op: CheckOp): CheckKind {
  switch (op.type) {
    case "text":
    case "value":
      return "text";
    case "url":
      return "url";
    case "element_state":
      return "element_state";
    case "count":
      return "count";
    case "network":
      return "network";
    case "aria_snapshot":
      return "aria_snapshot";
    case "soft_judgment":
      return "screen";
    case "code":
    case "pending":
      return "custom";
  }
}

/** The op as shown to the user ("generated code"): compact, stable JSON. */
export function checkCode(op: CheckOp): string {
  return JSON.stringify(op);
}

/**
 * Why a stored check can't count as proof (guarantee 4), or null when it can:
 * a line still `pending`, a check the sanity test flagged, or code that only
 * the generated spec can run.
 */
export function unusableCheck(check: CheckRecording): string | null {
  if (check.check.type === "pending")
    return `"${check.text}" has no check yet${check.problem ? ` (${check.problem})` : ""}: it can't prove anything.`;
  if (check.sanity?.provesNothing)
    return `The check for "${check.text}" proves nothing (it also passes where it shouldn't, see its sanity test), so it can't count as proof.`;
  if (check.check.type === "code")
    return `"${check.text}" is Playwright code: it runs from the generated spec only.`;
  return null;
}

export interface CheckResultInput {
  id: string;
  stepIndex: number;
  /** The line as the user wrote it. */
  expectation: string;
  op: CheckOp;
  soft: boolean;
  passed: boolean;
  expected: string | null;
  actual: string | null;
  summary?: string | undefined;
}

export function checkResult(input: CheckResultInput): CheckResult {
  return {
    id: input.id,
    stepIndex: input.stepIndex,
    expectation: input.expectation,
    generated: {
      description: input.summary ?? describeCheck(input.op),
      code: checkCode(input.op),
    },
    kind: checkKindOf(input.op),
    soft: input.soft,
    passed: input.passed,
    expected: input.expected,
    actual: input.actual,
  };
}

/** A harness evaluation as expected/actual text for the report. */
export function evaluationText(evaluation: CheckEvaluation): {
  expected: string | null;
  actual: string | null;
} {
  const actual =
    evaluation.status === "passed" || evaluation.status === "failed"
      ? evaluation.actual
      : `${evaluation.status}${evaluation.message ? `: ${evaluation.message}` : ""}`;
  return { expected: evaluation.expected, actual };
}
