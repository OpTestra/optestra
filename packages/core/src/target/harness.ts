import type {
  Action,
  ActionOutcome,
  CandidatesResult,
  CheckEvaluation,
  ElementFacts,
  HookRequest,
  HookResult,
  InspectResult,
  LocatorSpec,
  Observation,
  PostState,
  Refusal,
  ScreenshotOptions,
  ScreenshotResult,
  SettleOptions,
  SettleResult,
  Target,
} from "@testament/browser";
import type { CheckOp } from "@testament/recording";

// The target layer (MOB-1): one engine, two harnesses. The author, the replayer,
// the check compiler and the heals talk to a HarnessSession; a web Session
// (@testament/browser) and an AndroidSession (@testament/android) both satisfy it
// as they are, with no adapter. Where the two differ the types here are the
// wider of the two (e.g. a refusal's type is any string); Android adds actions.

/**
 * Android's own actions. `tap` and `type` are Android's names for the web's click
 * and fill (the engine records click and fill, so recordings stay shared).
 */
export type AndroidOnlyAction =
  | { type: "tap"; target: Target }
  | { type: "type"; target: Target; value: string | { secret: string } }
  | { type: "long_press"; target: Target; ms?: number }
  | { type: "clear"; target: Target }
  | { type: "swipe"; direction: "up" | "down" | "left" | "right"; target?: Target }
  | { type: "home" }
  | { type: "launch_app" }
  | { type: "rotate"; orientation: "portrait" | "landscape" }
  | { type: "open_deep_link"; url: string }
  | { type: "permission"; decision: "allow" | "allow_once" | "deny" };

/** Any action on any target. A harness refuses the ones its target doesn't have. */
export type HarnessAction = Action | AndroidOnlyAction;

export type HarnessRefusal = Omit<Refusal, "type"> & { type: string };

export type HarnessObservation = Omit<Observation, "refused"> & {
  refused: HarnessRefusal[];
  /** Android: the screen's rotation in degrees. */
  rotation?: number;
};

export type HarnessPostState = Omit<PostState, "refused"> & {
  refused: HarnessRefusal[];
  /** Android: toasts shown during the action. */
  toasts?: string[];
  /** Android: the app after the action (running, crashed…). */
  app?: string;
};

export type HarnessOutcome = Omit<ActionOutcome, "action" | "reason" | "post"> & {
  action: HarnessAction;
  reason?: string;
  /** Android: app or device trouble (app_crashed…), with status error. */
  problem?: string;
  post: HarnessPostState;
};

/** A page or screen copy, or a step mark: opaque, passed back to the same session. */
export type HarnessCopy = object;

/**
 * Replay's learned wait (LRN-4, PERF-0): move on once `until` holds for the
 * post-state. The Android harness settles fully instead (same outcome, slower).
 */
export interface HarnessActOptions {
  until?: (post: HarnessPostState) => boolean;
  ceilingMs?: number;
}

export interface HarnessCheckOptions {
  timeoutMs?: number;
  values?: Readonly<Record<string, string>>;
  on?: "page" | "blank" | HarnessCopy;
  since?: HarnessCopy;
}

/**
 * What the engine asks of a harness. Methods (not properties) so a session whose
 * own types are narrower (the web's Action, Android's AndroidAction) still fits.
 */
export interface HarnessSession {
  observe(): Promise<HarnessObservation>;
  act(action: HarnessAction, options?: HarnessActOptions): Promise<HarnessOutcome>;
  /** Waits until the page or screen is quiet. */
  settle(options?: SettleOptions): Promise<SettleResult>;
  /** The last act moved on at its effect: a settle is still owed (web; never on Android). */
  readonly unsettled: boolean;
  candidates(ref: string): Promise<CandidatesResult>;
  factsOf(ref: string): Promise<ElementFacts | null>;
  inspect(target: LocatorSpec): Promise<InspectResult>;
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;
  readonly url: string;
  /** chromium | firefox | webkit, or android. */
  readonly browserName: string;
  hookRequest(request: HookRequest): Promise<HookResult>;
  refusals(): HarnessRefusal[];
  check(op: CheckOp, options?: HarnessCheckOptions): Promise<CheckEvaluation>;
  pageCopy(): Promise<HarnessCopy>;
  requestMark(): HarnessCopy;
}

/** The targets a project can test (config `project.target`). */
export type TargetName = "web" | "android";

/** Which target a session drives (an AndroidSession's browserName is "android"). */
export function targetOfSession(session: { readonly browserName: string }): TargetName {
  return session.browserName === "android" ? "android" : "web";
}

export type {
  CandidatesResult,
  CheckEvaluation,
  CheckStatus,
  ElementFacts,
  ElementSummary,
  InspectResult,
  LocatorSpec,
  ObservedElement,
} from "@testament/browser";
// The engine's names for these, as its modules use them (the web's names, widened).
export type {
  HarnessActOptions as ActOptions,
  HarnessAction as Action,
  HarnessCopy as PageCopy,
  HarnessCopy as RequestMark,
  HarnessObservation as Observation,
  HarnessOutcome as ActionOutcome,
  HarnessPostState as PostState,
};
