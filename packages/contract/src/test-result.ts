import { z } from "zod";
import { CheckResultSchema } from "./check.js";
import {
  ArtifactRefSchema,
  ContractVersionSchema,
  CountSchema,
  IdSchema,
  MillisecondsSchema,
  RelativePathSchema,
  RunIdSchema,
  TimestampSchema,
  TokensSchema,
  UsdSchema,
} from "./common.js";
import {
  AttemptStatusSchema,
  BlockedReasonSchema,
  FailureCauseSchema,
  VerdictSchema,
} from "./enums.js";
import {
  AccessibilityReportSchema,
  MockUseSchema,
  MuteSchema,
  MuteSuggestionSchema,
} from "./extras.js";
import { HealProposalSchema } from "./heal.js";
import { DecisionRecordSchema, ModelCallSchema } from "./records.js";
import { StepResultSchema } from "./step.js";

const AttemptNumberSchema = z.number().int().min(1);

/**
 * What decided a verdict (VER-2, VER-4): a check, a step (element not found,
 * post-state mismatch) or a blocked reason. There is deliberately no kind for
 * a model or decision: prose can never set a verdict.
 */
export const DeciderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check"), attempt: AttemptNumberSchema, checkId: IdSchema }),
  z.object({ kind: z.literal("step"), attempt: AttemptNumberSchema, stepIndex: CountSchema }),
  z.object({ kind: z.literal("blocked"), reason: BlockedReasonSchema, message: z.string() }),
]);
export type Decider = z.infer<typeof DeciderSchema>;

/** Evidence behind a failure cause (DIA-1). */
export const EvidenceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check"), attempt: AttemptNumberSchema, checkId: IdSchema }),
  z.object({ kind: z.literal("step"), attempt: AttemptNumberSchema, stepIndex: CountSchema }),
  z.object({ kind: z.literal("decision"), attempt: AttemptNumberSchema, decisionId: IdSchema }),
  z.object({ kind: z.literal("artifact"), path: RelativePathSchema }),
]);
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** Where the test ran: browser + device, or Android version + device profile. */
export const MatrixEntrySchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("web"),
    browser: z.enum(["chromium", "firefox", "webkit"]),
    device: z.string().nullable(),
  }),
  z.object({
    target: z.literal("android"),
    androidVersion: z.string(),
    device: z.string(),
  }),
]);
export type MatrixEntry = z.infer<typeof MatrixEntrySchema>;

export const AttemptSchema = z.object({
  attempt: AttemptNumberSchema,
  status: AttemptStatusSchema,
  startedAt: TimestampSchema,
  durationMs: MillisecondsSchema,
  steps: z.array(StepResultSchema),
  checks: z.array(CheckResultSchema),
  modelCalls: z.array(ModelCallSchema),
  decisions: z.array(DecisionRecordSchema),
  heals: z.array(HealProposalSchema),
  artifacts: z.array(ArtifactRefSchema),
  /** 1.5 (ENV-4): responses that came from a mock or recorded traffic, not the app. */
  mocks: z.array(MockUseSchema).optional(),
  /** 1.5 (EVD-6): accessibility warnings (never part of the verdict). */
  accessibility: AccessibilityReportSchema.optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const AiUsageSchema = z.object({
  calls: CountSchema,
  /** Sum of priced calls. */
  costUsd: UsdSchema,
  /** Calls whose price is unknown, not included in costUsd. */
  unpricedCalls: CountSchema,
  tokens: TokensSchema,
  /** LRN-5: AI calls in this test's last `runs` runs. Filled from history; null when unknown. */
  recent: z.object({ runs: CountSchema, calls: CountSchema }).nullable(),
  /** 1.6 (PROV-0): time the calls waited for providers (rate limits, slots); outside the test's time limit. */
  waitMs: MillisecondsSchema.optional(),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;

export const RecentHealsSchema = z.object({ runs: CountSchema, healed: CountSchema });
export type RecentHeals = z.infer<typeof RecentHealsSchema>;

/** HEAL-7: a test that healed this often in its last runs should be re-recorded. */
export const REPEATED_HEALS = { runs: 10, healed: 3 } as const;

export function needsRerecord(recent: RecentHeals | null | undefined): boolean {
  return (recent?.healed ?? 0) >= REPEATED_HEALS.healed;
}

export const TestResultSchema = z
  .object({
    contractVersion: ContractVersionSchema,
    runId: RunIdSchema,
    /** Stable id derived from the project-relative test path (see testIdFromPath). */
    testId: IdSchema,
    file: z.string(),
    name: z.string(),
    tags: z.array(z.string()),
    matrix: MatrixEntrySchema,
    verdict: VerdictSchema,
    decidedBy: z.array(DeciderSchema).min(1),
    failureCause: FailureCauseSchema.nullable(),
    failureEvidence: z.array(EvidenceRefSchema),
    /** The one line that matters (DIA-3). */
    headline: z.string().nullable(),
    /** Plain-English "what was checked", generated from the checks (EVD-3). */
    checkedSummary: z.array(z.string()),
    startedAt: TimestampSchema,
    durationMs: MillisecondsSchema,
    ai: AiUsageSchema,
    /**
     * 1.2 (HEAL-7): how often this test healed in its last `runs` runs, this one
     * included. `healed` ≥ 3 of the last 10 means "re-record this test".
     */
    recentHeals: RecentHealsSchema.optional(),
    /**
     * 1.5 (DIA-5): muted until a date. The verdict is still the real one; a
     * muted test's failure doesn't fail the run (see exitCodeFor).
     */
    muted: MuteSchema.optional(),
    /** 1.5: the mute ended before this run: the test counts again. */
    muteExpired: MuteSchema.optional(),
    /** 1.5: the run thinks the test is flaky and suggests muting it. */
    muteSuggested: MuteSuggestionSchema.optional(),
    attempts: z.array(AttemptSchema),
  })
  .superRefine((test, ctx) => {
    for (const message of verdictProblems(test)) ctx.addIssue({ code: "custom", message });
  });
export type TestResult = z.infer<typeof TestResultSchema>;

type TestShape = Pick<
  TestResult,
  "verdict" | "decidedBy" | "failureCause" | "attempts" | "failureEvidence"
>;

/**
 * Guarantee 3: a verdict must follow from the checks, steps or blocked reason
 * that it names. Returns one message per broken rule.
 */
export function verdictProblems(test: TestShape): string[] {
  const problems: string[] = [];
  const attempt = (n: number) => test.attempts.find((a) => a.attempt === n);
  const last = test.attempts.at(-1);
  // Outcome of each decider: true = passing, false = failing, null = blocked, undefined = dangling.
  const outcomes = test.decidedBy.map(
    (d): { passed: boolean | null | undefined; attempt?: number } => {
      if (d.kind === "blocked") return { passed: null };
      if (d.kind === "check") {
        const check = attempt(d.attempt)?.checks.find((c) => c.id === d.checkId);
        if (!check)
          problems.push(`decidedBy names check "${d.checkId}" missing from attempt ${d.attempt}`);
        else if (check.soft && check.passed)
          problems.push(`soft check "${d.checkId}" cannot decide a pass`);
        return { passed: check?.passed, attempt: d.attempt };
      }
      const step = attempt(d.attempt)?.steps.find((s) => s.index === d.stepIndex);
      if (!step)
        problems.push(`decidedBy names step ${d.stepIndex} missing from attempt ${d.attempt}`);
      return { passed: step ? step.status === "passed" : undefined, attempt: d.attempt };
    },
  );
  for (const ref of test.failureEvidence) {
    if (ref.kind === "artifact") continue;
    const a = attempt(ref.attempt);
    const found =
      ref.kind === "check"
        ? a?.checks.some((c) => c.id === ref.checkId)
        : ref.kind === "step"
          ? a?.steps.some((s) => s.index === ref.stepIndex)
          : a?.decisions.some((d) => d.id === ref.decisionId);
    if (!found)
      problems.push(`failureEvidence points at a ${ref.kind} missing from attempt ${ref.attempt}`);
  }

  const blocked = outcomes.some((o) => o.passed === null);
  const passing = outcomes.filter((o) => o.passed === true);
  const failing = outcomes.filter((o) => o.passed === false);
  const hardFailuresIn = (n: number | undefined) =>
    attempt(n ?? 0)?.checks.some((c) => !c.soft && !c.passed) ?? false;

  switch (test.verdict) {
    case "blocked":
      if (!blocked) problems.push("blocked verdict needs a blocked reason in decidedBy");
      if (test.failureCause !== "blocked")
        problems.push('blocked verdict needs failureCause "blocked"');
      break;
    case "passed":
    case "healed":
      if (blocked || failing.length > 0)
        problems.push(`${test.verdict} verdict names a failing or blocked decider`);
      if (passing.length === 0)
        problems.push(`${test.verdict} verdict needs a passing check or step in decidedBy`);
      if (last?.status !== "passed")
        problems.push(`${test.verdict} verdict needs a passed final attempt`);
      if (hardFailuresIn(last?.attempt))
        problems.push(`${test.verdict} verdict with a failed check in the final attempt`);
      if (test.attempts.some((a) => a.status !== "passed"))
        problems.push(`${test.verdict} verdict with a failed attempt is flaky`);
      if (test.failureCause !== null)
        problems.push(`${test.verdict} verdict cannot have a failureCause`);
      if (test.verdict === "healed" && (last?.heals.length ?? 0) === 0)
        problems.push("healed verdict needs a heal proposal in the final attempt");
      if (test.verdict === "passed" && (last?.heals.length ?? 0) > 0)
        problems.push("a test with a heal proposal is healed, not passed");
      break;
    case "failed":
      if (blocked) problems.push("failed verdict names a blocked reason");
      if (failing.length === 0)
        problems.push("failed verdict needs a failing check or step in decidedBy");
      if (last?.status !== "failed") problems.push("failed verdict needs a failed final attempt");
      if (test.failureCause === null || test.failureCause === "blocked")
        problems.push("failed verdict needs a failureCause other than blocked");
      break;
    case "flaky":
      if (blocked) problems.push("flaky verdict names a blocked reason");
      if (last?.status !== "passed" || !test.attempts.some((a) => a.status === "failed"))
        problems.push("flaky verdict needs a failed attempt followed by a passed final attempt");
      if (failing.length === 0 || !passing.some((o) => o.attempt === last?.attempt))
        problems.push(
          "flaky verdict needs a failing decider and a passing one from the final attempt",
        );
      if (test.failureCause === null || test.failureCause === "blocked")
        problems.push("flaky verdict needs the failureCause of the failed attempt");
      break;
  }
  return problems;
}
