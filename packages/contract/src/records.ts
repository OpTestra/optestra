import { z } from "zod";
import {
  ConfidenceSchema,
  CountSchema,
  IdSchema,
  MillisecondsSchema,
  TimestampSchema,
  TokensSchema,
  UsdSchema,
} from "./common.js";
import { openEnum } from "./enums.js";

/** Model roles. Open: may grow within a contract version. */
export const MODEL_ROLES = ["planner", "fixer", "decider"] as const;

/** One model adapter call (MOD-4). The contract owns this shape; the adapter emits it. */
export const ModelCallSchema = z.object({
  id: IdSchema,
  role: openEnum(MODEL_ROLES),
  /** The provider and model that answered; null when none did. */
  provider: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: TimestampSchema,
  tokens: TokensSchema,
  /** Null when the price is unknown. */
  costUsd: UsdSchema.nullable(),
  latencyMs: MillisecondsSchema,
  /** Provider attempts including failover. */
  attempts: CountSchema,
  /** "ok" or the adapter's failure reason. */
  outcome: z.union([z.literal("ok"), z.string().regex(/^[a-z][a-z0-9_]*$/)]),
  /**
   * 1.1: how the call was paid for. "subscription" = the user's own AI plan via its
   * official CLI (MOD-6): costUsd is 0 to the run budget. Absent in 1.0 documents.
   */
  billing: z.enum(["api", "subscription"]).optional(),
  /** 1.2: the model's short reasoning for this call (EVD-1), scrubbed. Absent before 1.2. */
  note: z.string().max(500).optional(),
});
export type ModelCall = z.infer<typeof ModelCallSchema>;

/**
 * One small decision (LRN-8), made by rules or a decision model. Decisions never
 * set a verdict: no verdict or decidedBy field can point at a decision.
 */
export const DecisionRecordSchema = z.object({
  id: IdSchema,
  /** e.g. same_element, miss_action, failure_cause, flaky_or_real, heal_class. */
  task: z.string().min(1),
  answer: z.json(),
  confidence: ConfidenceSchema,
  /** "rules" or the decision model id. */
  source: z.string().min(1),
  latencyMs: MillisecondsSchema,
  /** True when confidence was below the threshold and it went to the fixer or a human. */
  escalated: z.boolean(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
