import type { Session } from "@testament/browser";
import type {
  CheckResult,
  HealPolicy,
  HealProposal,
  ModelCall,
  RunMode,
  StepResult,
} from "@testament/contract";
import type { AttemptObservations, Decisions } from "@testament/decide";
import type { BudgetMeter, Models } from "@testament/models";
import type { CheckRecording, Recording, StepRecording } from "@testament/recording";
import type { ExpandedTest } from "@testament/spec";
import type { TestInbox } from "../author/inbox.js";
import type { AttemptRecord } from "./verdict.js";

/** The harness calls a replay uses. A LOOP-0 Session satisfies it. */
export type ReplaySession = Pick<
  Session,
  | "observe"
  | "act"
  | "candidates"
  | "factsOf"
  | "inspect"
  | "screenshot"
  | "url"
  | "hookRequest"
  | "refusals"
  | "browserName"
  | "check"
  | "pageCopy"
  | "requestMark"
>;

/** What an attempt reports as it goes (the runner adds testId/attempt and writes the events). */
export type ReplayEvent =
  | { type: "step.started"; index: number; key: string; text: string; kind: StepResult["kind"] }
  | { type: "step.finished"; step: StepResult }
  | { type: "check.evaluated"; check: CheckResult }
  | { type: "heal.proposed"; heal: HealProposal }
  | { type: "model.called"; call: ModelCall }
  | { type: "log"; level: "info" | "warn"; message: string };

export interface ReplayOptions {
  test: ExpandedTest;
  /** The stored recording; undefined when there is none (or in rerecord mode). */
  recording: Recording | undefined;
  session: ReplaySession;
  attempt: number;
  mode: RunMode;
  /** The test's heal policy (HEAL-5). */
  policy: HealPolicy;
  decisions: Decisions;
  /** For authoring new steps and compiling pending checks (normal / rerecord). */
  models?: Models | undefined;
  budget?: BudgetMeter | undefined;
  /** A fixer model could redo a missed step (HEAL wires it in; LOOP-4 reports "needs an AI heal"). */
  fixerAvailable: boolean;
  /** A planner model is usable (authoring new steps). */
  plannerAvailable: boolean;
  production: boolean;
  timeoutMs: number;
  /** How long a check may wait for its condition (default 5000 ms). */
  checkTimeoutMs?: number;
  /** Before/after screenshots per action step (default true). */
  screenshots?: boolean;
  emit: (event: ReplayEvent) => void;
  /** Stores a step screenshot; returns its run-relative path. */
  saveScreenshot?: (index: number, when: "before" | "after", bytes: Uint8Array) => string | null;
  /** Unique ids for checks and heals. */
  newId: () => string;
  redact?: (text: string) => string;
  now?: () => Date;
  /** The attempt's test inbox (AUTH-1): {{inbox.code}} / {{inbox.link}} and read_inbox. */
  inbox?: TestInbox | undefined;
  /**
   * Runs after the setup hooks, before the start page: the test's login
   * (`auth: <profile>`, SEC-3). Its step, if any, is reported first.
   */
  prepare?: () => Promise<PrepareOutcome>;
}

/** What the test's login did (see `ReplayOptions.prepare`). */
export interface PrepareOutcome {
  status: "ready" | "failed" | "blocked";
  /** For failed / blocked: the headline. */
  message: string;
  /** For blocked: the contract's blocked reason. */
  reason?: string;
  /** The login as one step (kind `flow`), when it ran or failed. */
  step?: StepResult;
  modelCalls?: ModelCall[];
  heals?: HealProposal[];
  logs?: string[];
  /** Where the login stopped (its page, requests), for the failure classifier. */
  observations?: AttemptObservations;
  /** The login flow's path, for the classifier's flow chain. */
  flowPath?: string;
}

/** A step's time span, for the video chapters. */
export interface Chapter {
  index: number;
  title: string;
  startMs: number;
  endMs: number;
}

export interface ReplayResult extends AttemptRecord {
  modelCalls: ModelCall[];
  /** What the classifier needs about the failure (requests, page, route…). */
  observations: AttemptObservations;
  /** Steps and checks recorded or compiled in this attempt (never replayed ones). */
  authored: { steps: StepRecording[]; checks: CheckRecording[]; model: string | null };
  chapters: Chapter[];
  /** Misses only an AI heal could fix (LOOP-4 doesn't call the fixer). */
  needsAi: number;
  /** Heals made without AI. */
  healedWithoutAi: number;
}

export type { AttemptRecord };
