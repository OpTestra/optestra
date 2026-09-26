import { z } from "zod";
import { ConfidenceSchema, CountSchema, IdSchema } from "./common.js";
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
});
export type HealProposal = z.infer<typeof HealProposalSchema>;
