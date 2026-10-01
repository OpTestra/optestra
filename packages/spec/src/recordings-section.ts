import { registerSection } from "@optestra/config";
import { z } from "zod";

// Branch-aware recordings (REP-8): on a feature branch, recordings the engine
// writes go to `<tests>/<data dir>/branches/<branch>/` and runs prefer them over
// main's, until `recordings promote` moves them into place after the merge.

export interface RecordingsSettings {
  branches: "auto" | "on" | "off";
  mainBranch?: string | null | undefined;
}

export const recordingsSchema = z
  .object({
    branches: z
      .enum(["auto", "on", "off"])
      .describe(
        "Per-branch recordings: auto (GitHub projects: a github.com remote, or in a GitHub Action), on, or off.",
      ),
    mainBranch: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe("The branch whose recordings are the main ones (default: main or master)."),
  })
  .strict();

declare module "@optestra/config" {
  interface ConfigSections {
    recordings: RecordingsSettings;
  }
}

/** Defaults live in the config package's defaults.yaml. */
registerSection({ key: "recordings", schema: recordingsSchema });
