import { z } from "zod";
import {
  CountSchema,
  IdSchema,
  MillisecondsSchema,
  RelativePathSchema,
  TimestampSchema,
} from "./common.js";
import { RecoveryLevelSchema, StepKindSchema, StepStatusSchema } from "./enums.js";

export const StepResultSchema = z.object({
  index: CountSchema,
  /**
   * 1.3 (PERF-0): the step as the test file numbers it, e.g. "3", or "1 › Log
   * in 4" for step 4 of the flow used at step 1. Readers show `step <label>`;
   * absent in older runs (use `stepLabel`, which falls back to index + 1).
   */
  label: z.string().optional(),
  /** Stable key the recording is stored under (REP-7 defines how it is built). */
  key: z.string(),
  text: z.string(),
  kind: StepKindSchema,
  status: StepStatusSchema,
  recovery: RecoveryLevelSchema,
  /** The locator that found the element, when the step targets one. */
  locator: z
    .object({
      used: z.enum(["primary", "fallback"]),
      value: z.string(),
    })
    .nullable(),
  /** VER-5: did the page or screen reflect the action? */
  postState: z
    .object({
      status: z.enum(["verified", "mismatch", "not_checkable"]),
      expected: z.string().nullable(),
      observed: z.string().nullable(),
    })
    .nullable(),
  startedAt: TimestampSchema,
  durationMs: MillisecondsSchema,
  /** How long the page or screen took to settle after the action (LRN-4). */
  settledMs: MillisecondsSchema.nullable(),
  screenshots: z.object({
    before: RelativePathSchema.nullable(),
    after: RelativePathSchema.nullable(),
  }),
  /** Short plain reason when the step did not pass. */
  error: z.string().nullable(),
  checkIds: z.array(IdSchema),
  modelCallIds: z.array(IdSchema),
  decisionIds: z.array(IdSchema),
  healIds: z.array(IdSchema),
});
export type StepResult = z.infer<typeof StepResultSchema>;

/** How to name a step to a person: the test file's own numbering (`label`), else its position. */
export function stepLabel(step: Pick<StepResult, "index" | "label">): string {
  return step.label ?? String(step.index + 1);
}
