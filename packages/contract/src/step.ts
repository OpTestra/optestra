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
