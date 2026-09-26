import { z } from "zod";
import { CountSchema, IdSchema } from "./common.js";
import { CheckKindSchema } from "./enums.js";

/** One concrete check generated from an `Expect:` (or `Soft:`) line (VER-1). */
export const CheckResultSchema = z.object({
  id: IdSchema,
  /** The step the check belongs to. */
  stepIndex: CountSchema.nullable(),
  /** The expectation as the user wrote it. */
  expectation: z.string(),
  generated: z.object({
    /** Plain English, shown to the user and used for "what was checked". */
    description: z.string(),
    code: z.string(),
  }),
  kind: CheckKindSchema,
  /** Soft checks warn on failure and can never make a test pass alone (VER-3). */
  soft: z.boolean(),
  passed: z.boolean(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;
