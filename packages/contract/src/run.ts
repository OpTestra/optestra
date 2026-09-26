import { z } from "zod";
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
  BlockedReasonSchema,
  RunModeSchema,
  TargetSchema,
  TriggerSchema,
  VERDICTS,
  VerdictSchema,
} from "./enums.js";
import { DecisionRecordSchema, ModelCallSchema } from "./records.js";

export const GitInfoSchema = z.object({
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  pr: z.number().int().positive().nullable(),
});
export type GitInfo = z.infer<typeof GitInfoSchema>;

/** A run that could not start or was stopped as a whole (e.g. config_error, aborted). */
export const RunBlockSchema = z.object({ reason: BlockedReasonSchema, message: z.string() });
export type RunBlock = z.infer<typeof RunBlockSchema>;

export const TotalsSchema = z.object({
  tests: CountSchema,
  passed: CountSchema,
  healed: CountSchema,
  failed: CountSchema,
  flaky: CountSchema,
  blocked: CountSchema,
});
export type Totals = z.infer<typeof TotalsSchema>;

export const RunCostSchema = z.object({
  /** Sum of priced AI calls in the run. */
  usd: UsdSchema,
  unpricedCalls: CountSchema,
  aiCalls: CountSchema,
  tokens: TokensSchema,
});
export type RunCost = z.infer<typeof RunCostSchema>;

/** Enough about each test to render a summary without opening its result file. */
export const RunTestRefSchema = z.object({
  testId: IdSchema,
  name: z.string(),
  file: z.string(),
  verdict: VerdictSchema,
  headline: z.string().nullable(),
  durationMs: MillisecondsSchema,
  attempts: CountSchema,
  aiCalls: CountSchema,
  costUsd: UsdSchema,
  /** Path of the TestResult document. */
  result: RelativePathSchema,
});
export type RunTestRef = z.infer<typeof RunTestRefSchema>;

export const RunSchema = z
  .object({
    contractVersion: ContractVersionSchema,
    runId: RunIdSchema,
    engineVersion: z.string(),
    project: z.string(),
    environment: z.string().nullable(),
    target: TargetSchema,
    trigger: TriggerSchema,
    mode: RunModeSchema,
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema,
    durationMs: MillisecondsSchema,
    blocked: RunBlockSchema.nullable(),
    totals: TotalsSchema,
    cost: RunCostSchema,
    git: GitInfoSchema.nullable(),
    tests: z.array(RunTestRefSchema),
    /** Calls, decisions and artifacts that belong to the run rather than one test. */
    modelCalls: z.array(ModelCallSchema),
    decisions: z.array(DecisionRecordSchema),
    artifacts: z.array(ArtifactRefSchema),
  })
  .superRefine((run, ctx) => {
    if (run.totals.tests !== run.tests.length)
      ctx.addIssue({ code: "custom", message: "totals.tests does not match tests" });
    for (const verdict of VERDICTS) {
      const count = run.tests.filter((t) => t.verdict === verdict).length;
      if (run.totals[verdict] !== count)
        ctx.addIssue({ code: "custom", message: `totals.${verdict} does not match tests` });
    }
  });
export type Run = z.infer<typeof RunSchema>;
