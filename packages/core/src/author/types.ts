import type { Session } from "@testament/browser";
import type { ModelCall } from "@testament/contract";
import type { BudgetMeter, Models } from "@testament/models";
import type { Recording } from "@testament/recording";

/** The harness calls the author uses. A LOOP-0 Session satisfies it. */
export type AuthorSession = Pick<
  Session,
  | "observe"
  | "act"
  | "candidates"
  | "screenshot"
  | "url"
  | "hookRequest"
  | "refusals"
  | "browserName"
>;

/** Why a step (and so the test) ended without being recorded. */
export type StopReason =
  | "step_impossible"
  | "no_visible_effect"
  | "guard_refused"
  | "disallowed_domain"
  | "missing_secret"
  | "budget_exceeded"
  | "ai_unavailable"
  | "limit_reached"
  | "code_step_needs_replay"
  | "hook_unsupported"
  | "setup_failed"
  | "timeout";

/** A failed step means the app or the test is wrong; a stopped one means the run couldn't go on. */
export const FAILURE_REASONS: ReadonlySet<StopReason> = new Set([
  "step_impossible",
  "no_visible_effect",
  "guard_refused",
  "limit_reached",
]);

export interface AuthorLimits {
  /** Actions per step (default 8). */
  actionsPerStep: number;
  /** Model calls per step (default 12). */
  modelCallsPerStep: number;
  /** Consecutive failed or refused actions before the step fails (default 3). */
  consecutiveFailures: number;
}

export const DEFAULT_LIMITS: AuthorLimits = {
  actionsPerStep: 8,
  modelCallsPerStep: 12,
  consecutiveFailures: 3,
};

export interface AuthorOptions {
  session: AuthorSession;
  models: Models;
  /** The run's budget meter (MOD-5); the models client may carry more. */
  budget?: BudgetMeter;
  /** The environment has `production: true` (SAF-4). */
  production?: boolean;
  limits?: Partial<AuthorLimits>;
  /** Whole-test limit in ms (the test's timeout, else run.timeoutSeconds). */
  timeoutMs: number;
  /** Run `setup`/`teardown` request hooks through the session (default true). */
  hooks?: boolean;
  /** Open the test's `start` before the first step (default true). */
  openStart?: boolean;
  /** The previous recording, so steps not re-recorded keep their commands. */
  previous?: Recording;
  meta: {
    /** Project-relative test path with "/". */
    testPath: string;
    target: "web" | "android";
    engineVersion: string;
    device: string;
    environment: string | null;
  };
  /** Scrubs text for the report (default: the config's defaultRedactor). */
  redact?: (text: string) => string;
  /** Take before/after screenshots of each action step (default true). */
  screenshots?: boolean;
  onEvent?: (event: AuthorEvent) => void;
  now?: () => Date;
}

export type AuthorEvent =
  | { type: "hook"; hook: HookReport }
  | { type: "step.started"; index: number; number: number | null; text: string }
  | { type: "action"; index: number; action: ActionReport }
  | { type: "step.finished"; step: StepReport };

export interface HookReport {
  phase: "setup" | "teardown";
  kind: "request" | "run" | "sql";
  description: string;
  status: "ok" | "failed" | "refused" | "unsupported" | "error";
  httpStatus?: number;
  message?: string;
}

export interface ActionReport {
  /** Tool the model called, or the exact op. */
  tool: string;
  /** What was done, with values as templates, e.g. `fill "Email" with {{params.email}}`. */
  description: string;
  status: "ok" | "refused" | "not_found" | "timeout" | "error" | "guard_refused" | "invalid";
  reason?: string;
  message?: string;
  changed?: boolean;
  settledMs?: number;
}

export type StepStatus = "recorded" | "failed" | "stopped" | "pending" | "skipped";

export interface StepReport {
  index: number;
  number: number | null;
  kind: string;
  /** The line as written (variables by name). */
  text: string;
  status: StepStatus;
  reason?: StopReason;
  message?: string;
  route?: string;
  key?: string;
  actions: ActionReport[];
  modelCalls: ModelCall[];
  costUsd: number | null;
  /** Relative to the report folder. */
  screenshots: { before?: string; after?: string };
  refusals: string[];
}

export interface AuthoringReport {
  reportVersion: 1;
  runId: string;
  testId: string;
  testPath: string;
  startedAt: string;
  finishedAt: string;
  environment: string | null;
  browser: string;
  device: string;
  promptVersion: string;
  /** recorded: every action step recorded; failed: a step failed; stopped: the run couldn't go on. */
  outcome: "recorded" | "failed" | "stopped";
  stopReason?: StopReason;
  message?: string;
  hooks: HookReport[];
  steps: StepReport[];
  totals: {
    aiCalls: number;
    tokens: { input: number; output: number; cached: number; cacheWrite: number };
    costUsd: number;
    unknownCostCalls: number;
    /** How the calls were paid: API keys, the user's own subscription CLI (MOD-6), or both. */
    billing: "api" | "subscription" | "mixed" | null;
  };
  /** Set when saved: relative paths of the recording and evidence files. */
  recordingPath?: string;
  evidence: string[];
}

export interface AuthorResult {
  recording: Recording;
  report: AuthoringReport;
  /** Screenshot bytes by report-relative path (steps/<index>-before.png …). */
  screenshots: Map<string, Uint8Array>;
}
