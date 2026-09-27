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
import type { HealPatch } from "../heal/patch.js";
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
  /** A fixer model can redo a missed step (HEAL-1 level 2), through `models`. */
  fixerAvailable: boolean;
  /** Project-relative test path, stored in heal patches. */
  testPath?: string;
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
  /** Misses only an AI heal could fix that the fixer didn't (or couldn't) fix. */
  needsAi: number;
  /** Heals made without AI. */
  healedWithoutAi: number;
  /** Steps the fixer model healed. */
  healedByFixer: number;
  /** What each heal changes in the recording, by heal id (applied on accept, or now under `auto`). */
  patches: HealPatch[];
}

export type { AttemptRecord };
