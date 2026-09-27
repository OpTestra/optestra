import { z } from "zod";
import { ConfidenceSchema, CountSchema, IdSchema, RunIdSchema, TimestampSchema } from "./common.js";
import { HealPolicySchema, openEnum } from "./enums.js";

/**
 * What a heal may change: how a step is done, never what is expected (HEAL-3).
 * This list is closed forever, and change entries are strict (unknown keys are
 * rejected, the one exception to "readers ignore unknown fields"), so no
 * document can carry an expectation change.
 */
export const HEAL_CHANGE_TARGETS = ["locator", "action", "wait"] as const;

export const HealChangeSchema = z.strictObject({
  target: z.enum(HEAL_CHANGE_TARGETS),
  before: z.string(),
  after: z.string(),
});
export type HealChange = z.infer<typeof HealChangeSchema>;

/** Why the healer thinks it is the same element (HEAL-6). Open list. */
export const HEAL_SIGNALS = [
  "text_match",
  "role_match",
  "position",
  "attributes",
  "anchor_text",
  "test_id",
] as const;

export const HealProposalSchema = z.object({
  id: IdSchema,
  stepIndex: CountSchema,
  stepKey: z.string(),
  changes: z.array(HealChangeSchema).min(1),
  /** The recording diff, as text. */
  diff: z.string(),
  signals: z.array(
    z.object({ name: openEnum(HEAL_SIGNALS), score: ConfidenceSchema, detail: z.string() }),
  ),
  confidence: ConfidenceSchema,
  classification: z.enum(["cosmetic", "behavior_change", "unknown"]),
  status: z.enum(["pending", "accepted", "rejected"]),
  /** The test's fix policy when the heal was made (HEAL-5). */
  policy: HealPolicySchema,
  /** 1.2: how it was healed (HEAL-1): a stored fallback, a re-find (no AI) or the fixer model. */
  level: z.enum(["fallback", "refind", "fixer"]).optional(),
  /** 1.2: who applied it to the recording: the `auto` policy or a person. Absent while pending. */
  appliedBy: z.enum(["auto", "human"]).optional(),
  /** 1.2: when it was accepted or rejected. */
  reviewedAt: TimestampSchema.optional(),
});
export type HealProposal = z.infer<typeof HealProposalSchema>;

/**
 * 1.2: review decisions on a finished run's heals (HEAL-4), in `heals/review.json`
 * of the run folder. The run's own documents never change after the run; readers
 * overlay these decisions on the proposals (`withHealReview`).
 */
export const HealDecisionSchema = z.object({
  healId: IdSchema,
  testId: IdSchema,
  status: z.enum(["accepted", "rejected"]),
  reviewedAt: TimestampSchema,
  appliedBy: z.enum(["auto", "human"]).optional(),
  /** The recording that was changed (project-relative), when accepted. */
  recording: z.string().nullable().default(null),
  /** Portable specs regenerated (project-relative). */
  specs: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});
export type HealDecision = z.infer<typeof HealDecisionSchema>;

export const HealReviewSchema = z.object({
  runId: RunIdSchema,
  decisions: z.array(HealDecisionSchema),
});
export type HealReview = z.infer<typeof HealReviewSchema>;

/** The proposals with their review decisions applied (status, appliedBy, reviewedAt). */
export function withHealReview<
  T extends { attempts: readonly { heals: readonly HealProposal[] }[] },
>(test: T, review: HealReview | null | undefined): T {
  if (!review || review.decisions.length === 0) return test;
  const byId = new Map(review.decisions.map((d) => [d.healId, d]));
  return {
    ...test,
    attempts: test.attempts.map((attempt) => ({
      ...attempt,
      heals: attempt.heals.map((heal) => {
        const decision = byId.get(heal.id);
        if (!decision) return heal;
        return {
          ...heal,
          status: decision.status,
          reviewedAt: decision.reviewedAt,
          ...(decision.status === "accepted" ? { appliedBy: decision.appliedBy ?? "human" } : {}),
        };
      }),
    })),
  };
}
