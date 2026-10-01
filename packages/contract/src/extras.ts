import { z } from "zod";
import { CountSchema, MillisecondsSchema, RelativePathSchema } from "./common.js";

// 1.5 (ADV-1): what a run says besides the verdict. All optional, all additive:
// a mute (DIA-5), the mocked or replayed responses an attempt used (ENV-4), and
// the accessibility warnings of the pages it visited (EVD-6). None of them is a
// verdict and none can change one.

/** DIA-5: a test is muted until a date, with a reason. It runs; its failure doesn't count. */
export const MuteSchema = z.object({
  reason: z.string().min(1),
  /** The last day the mute applies, YYYY-MM-DD (UTC). */
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Where it was set: the project file (by hand or `mute`). */
  source: z.string().min(1),
});
export type Mute = z.infer<typeof MuteSchema>;

/** DIA-5: the decide layer thinks the test is flaky: muting is suggested, never done. */
export const MuteSuggestionSchema = z.object({
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});
export type MuteSuggestion = z.infer<typeof MuteSuggestionSchema>;

/** ENV-4: a response the attempt got from a mock (a `Mock:` step) or recorded traffic, not the app. */
export const MockUseSchema = z.object({
  source: z.enum(["step", "recorded"]),
  method: z.string(),
  /** The route as matched, e.g. /api/orders. */
  url: z.string(),
  /** The status served; null for recorded traffic summed over routes. */
  status: z.number().int().nullable(),
  /** How many requests it answered. */
  hits: CountSchema,
  /** The `Mock:` step, for step mocks. */
  stepIndex: CountSchema.nullable(),
  /** The body file (step mocks) or the recorded traffic file, project-relative. */
  file: RelativePathSchema.nullable(),
});
export type MockUse = z.infer<typeof MockUseSchema>;

/** EVD-6: one axe-core rule that failed on one page (deduplicated per page and rule). */
export const AccessibilityViolationSchema = z.object({
  rule: z.string(),
  impact: z.enum(["minor", "moderate", "serious", "critical"]).nullable(),
  help: z.string(),
  helpUrl: z.string(),
  /** The page's route, e.g. /checkout. */
  page: z.string(),
  /** Elements that fail the rule. */
  nodes: CountSchema,
  /** CSS selectors of the first few of them. */
  targets: z.array(z.string()),
});
export type AccessibilityViolation = z.infer<typeof AccessibilityViolationSchema>;

export const AccessibilityReportSchema = z.object({
  /** The standard checked. */
  standard: z.literal("wcag2aa"),
  /** Distinct pages scanned. */
  pages: CountSchema,
  /** Time spent scanning, in total. */
  ms: MillisecondsSchema,
  violations: z.array(AccessibilityViolationSchema),
});
export type AccessibilityReport = z.infer<typeof AccessibilityReportSchema>;
