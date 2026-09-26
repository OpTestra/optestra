import { defaultRegistry } from "@testament/config";
import { z } from "zod";

/**
 * Backends a project can choose. auto: Jev when its key is available, else none.
 * Kev and Laya are used only when chosen explicitly (LRN-7).
 */
export const BACKEND_IDS = ["auto", "none", "jev", "kev", "laya"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];
/** The System One backends (each has a settings block of the same name). */
export const MODEL_BACKENDS = ["jev", "kev", "laya"] as const;
export type ModelBackendId = (typeof MODEL_BACKENDS)[number];

export interface SystemOneSettings {
  /** Scheme, host and optional port; requests go only to this host. */
  baseUrl: string;
  model: string;
  /** Name of the secret holding the bearer key; unset when none is needed. */
  keySecret?: string;
  /** USD per million input tokens (Jev bills input tokens only); 0 for local models. */
  priceUsdPerMillionInputTokens: number;
  /** Typical latency of one request; tasks with a shorter time limit never call this backend. */
  expectedLatencyMs: number;
}

export interface LayaSettings extends SystemOneSettings {
  /** How long Ollaya keeps the model loaded after a decision (Ollama duration, e.g. 30m). */
  keepAlive: string;
  /** Time allowed for the warm-up decision at run start (model load), in milliseconds. */
  warmUpTimeoutMs: number;
}

export interface DecisionTaskSettings {
  /** False turns the task off: every call escalates with reason `disabled`. */
  enabled?: boolean;
  /** Minimum confidence to act on, 0–1. */
  threshold?: number;
  /** Hard time limit for the whole decision, in milliseconds. */
  timeLimitMs?: number;
}

export interface DecisionsSettings {
  /** Shorthand for both phases. */
  backend: BackendId;
  /** During-run decisions. auto: whatever `backend` names, else rules only. */
  during: BackendId;
  /** After-run decisions. auto: whatever `backend` names, else Jev when its key is set, else rules only. */
  after: BackendId;
  /** Stop calling a backend for a task after this many timeouts in one run. */
  skipAfterTimeouts: number;
  jev: SystemOneSettings;
  kev: SystemOneSettings;
  laya: LayaSettings;
  threshold: number;
  tasks: Record<string, DecisionTaskSettings>;
  cache: { enabled: boolean; ttlSeconds: number };
}

const confidence = z.number().min(0).max(1);

const baseUrl = z
  .string()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/";
    } catch {
      return false;
    }
  }, "must be an http(s) URL with no path, e.g. https://api.typesafe.ai")
  .describe("Scheme, host and optional port. Requests go only to this host.");

const systemOneShape = {
  baseUrl,
  model: z.string().min(1).describe("Model name sent with every request."),
  keySecret: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, "must be an UPPER_SNAKE secret name")
    .optional()
    .describe("Secret holding the bearer key (leave unset when no key is needed)."),
  priceUsdPerMillionInputTokens: z
    .number()
    .nonnegative()
    .describe("USD per million input tokens, for the run cost."),
  expectedLatencyMs: z
    .number()
    .int()
    .positive()
    .describe(
      "Typical latency of one request; a task with a shorter time limit never calls this backend.",
    ),
};

export const decisionsSchema = z
  .strictObject({
    backend: z
      .enum(BACKEND_IDS)
      .describe(
        "Decision model behind the rules. auto: Jev if its key is set, else rules only. none: rules only.",
      ),
    during: z
      .enum(BACKEND_IDS)
      .describe("During-run decisions. auto: what `backend` names, else rules only."),
    after: z
      .enum(BACKEND_IDS)
      .describe(
        "After-run decisions. auto: what `backend` names, else Jev when its key is set, else rules only.",
      ),
    skipAfterTimeouts: z
      .number()
      .int()
      .positive()
      .describe("Stop calling a backend for a task after this many timeouts in one run."),
    jev: z.strictObject(systemOneShape).describe("Jev, hosted by TypeSafe AI."),
    kev: z.strictObject(systemOneShape).describe("Kev, open models you host (System One API)."),
    laya: z
      .strictObject({
        ...systemOneShape,
        keepAlive: z
          .string()
          .regex(/^-?\d+(ms|s|m|h)?$|^(-?\d+h)?(\d+m)?(\d+s)?$/, "must be a duration like 30m")
          .describe("How long Ollaya keeps the model loaded between decisions."),
        warmUpTimeoutMs: z
          .number()
          .int()
          .positive()
          .describe("Time allowed for the warm-up decision at run start (model load)."),
      })
      .describe("Laya, run locally through Ollaya."),
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
