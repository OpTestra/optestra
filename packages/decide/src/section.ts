import { defaultRegistry } from "@testament/config";
import { z } from "zod";

/** Backends a project can choose. DEC-1 adds jev, kev and laya with their settings. */
export const BACKEND_IDS = ["none"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

export interface DecisionTaskSettings {
  /** False turns the task off: every call escalates with reason `disabled`. */
  enabled?: boolean;
  /** Minimum confidence to act on, 0–1. */
  threshold?: number;
  /** Hard time limit for the whole decision, in milliseconds. */
  timeLimitMs?: number;
}

export interface DecisionsSettings {
  backend: BackendId;
  threshold: number;
  tasks: Record<string, DecisionTaskSettings>;
  cache: { enabled: boolean; ttlSeconds: number };
}

const confidence = z.number().min(0).max(1);

export const decisionsSchema = z
  .strictObject({
    backend: z
      .enum(BACKEND_IDS)
      .describe("Decision model behind the rules. none: rules only (the default)."),
    threshold: confidence.describe(
      "Minimum confidence to act on a decision; below it the decision escalates.",
    ),
    tasks: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]*$/, "must be a snake_case task name"),
        z.strictObject({
          enabled: z.boolean().optional().describe("False turns the task off (it escalates)."),
          threshold: confidence.optional().describe("Minimum confidence for this task."),
          timeLimitMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Hard time limit for one decision, in milliseconds."),
        }),
      )
      .describe("Per-task overrides by task name."),
    cache: z
      .strictObject({
        enabled: z.boolean().describe("Reuse decision model answers for the same input."),
        ttlSeconds: z.number().int().positive().describe("How long a cached answer stays valid."),
      })
      .describe("Decision cache under the project data folder."),
  })
  .describe("The decision layer: rules first, a decision model second.");

declare module "@testament/config" {
  interface ConfigSections {
    decisions: DecisionsSettings;
  }
}

// Registered when this package loads; defaults live in packages/config/defaults.yaml.
if (!defaultRegistry.has("decisions")) {
  defaultRegistry.register({
    key: "decisions",
    schema: decisionsSchema,
    environmentOverride: true,
  });
}
