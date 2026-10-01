import { registerSection } from "@optestra/config";
import { z } from "zod";

// Quarantine (DIA-5): muted tests. A muted test still runs and keeps its
// evidence; its failure doesn't fail the run, the Action or alert. Every mute
// has a reason and a last day; after that the test counts again, and renewing
// takes an explicit `mute --renew`.

export interface QuarantineEntry {
  /** The test file (tests/checkout.test.md) or its id (tests__checkout). */
  test: string;
  reason: string;
  /** The last day the mute applies, YYYY-MM-DD (UTC). */
  until: string;
}

export const quarantineSchema = z
  .array(
    z.strictObject({
      test: z.string().min(1).describe("The test file (tests/checkout.test.md) or its id."),
      reason: z.string().min(1).describe("Why it is muted (an issue link helps)."),
      until: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date like 2026-10-15")
        .describe("The last day the mute applies (YYYY-MM-DD, UTC)."),
    }),
  )
  .describe(
    "Muted tests: they still run, but a failure doesn't fail the run. Each mute ends on its date.",
  );

declare module "@optestra/config" {
  interface ConfigSections {
    quarantine: QuarantineEntry[];
  }
}

/** Defaults live in the config package's defaults.yaml. */
registerSection({ key: "quarantine", schema: quarantineSchema });
