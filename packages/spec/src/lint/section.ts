import { registerSection } from "@testament/config";
import { z } from "zod";
import { RULE_IDS, type RuleLevel } from "./types.js";

export interface LintSettings {
  /** Per-rule level: off, info, warning or error. Missing rules use their default. */
  rules: Record<string, RuleLevel>;
  /** Warnings count as errors for the exit code (CI). */
  strict: boolean;
}

export const lintSchema = z
  .strictObject({
    rules: z
      .record(z.string(), z.enum(["off", "info", "warning", "error"]))
      .describe(`Rule levels by id (${RULE_IDS.join(", ")}): off, info, warning or error.`),
    strict: z.boolean().describe("Warnings count as errors for the exit code (CI)."),
  })
  .describe("Test lint rules.");

declare module "@testament/config" {
  interface ConfigSections {
    lint: LintSettings;
  }
}

/** Defaults live in the config package's defaults.yaml. */
registerSection({ key: "lint", schema: lintSchema });
