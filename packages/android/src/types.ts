import type {
  ActionOutcome,
  CandidatesResult,
  DialogSummary,
  ElementFacts,
  ElementStates,
  ElementSummary,
  FillValue,
  HookRequest,
  HookResult,
  InspectResult,
  LocatorCandidate,
  LocatorSpec,
  Observation,
  ObservedElement,
  ObservedFrame,
  OutcomeStatus,
  PostState,
  Refusal,
  RefusalReason,
  RefusalType,
  RequestSummary,
  ScreenshotOptions,
  ScreenshotResult,
  SettleOptions,
  SettleResult,
  Target,
} from "@optestra/browser";
import type { SecretValue } from "@optestra/config/node";

// The same shapes as the web harness wherever the concept is the same (guarantee 1):
// observations, targets, locators, candidates, outcomes, post-state, settle,
// screenshots and check results are `@optestra/browser`'s own types. Android-only
// concepts extend them.

export type {
  CandidatesResult,
  DialogSummary,
  ElementFacts,
  ElementStates,
  ElementSummary,
  FillValue,
  HookRequest,
  HookResult,
  InspectResult,
  LocatorCandidate,
  LocatorSpec,
  Observation,
  ObservedElement,
  ObservedFrame,
  OutcomeStatus,
  RequestSummary,
  ScreenshotOptions,
  ScreenshotResult,
  SettleOptions,
  SettleResult,
  Target,
};

// ── Actions (the closed set, SAF-2) ──────────────────────────────────────────

export type SwipeDirection = "up" | "down" | "left" | "right";

/**
 * Every action the Android harness offers. `click` and `fill` are the web
 * harness's shapes and mean the same as `tap` and `type`, so code written for
 * web actions drives Android unchanged.
 */
export type AndroidAction =
  | { type: "tap"; target: Target }
  | { type: "click"; target: Target }
  | { type: "long_press"; target: Target; ms?: number }
  | { type: "type"; target: Target; value: FillValue }
  | { type: "fill"; target: Target; value: FillValue }
  | { type: "clear"; target: Target }
  | { type: "press"; key: string; target?: Target }
  | { type: "swipe"; direction: SwipeDirection; target?: Target }
  | { type: "scroll"; target?: Target; direction?: "up" | "down" }
  | { type: "back" }
  | { type: "home" }
  | { type: "launch_app" }
  | { type: "rotate"; orientation: "portrait" | "landscape" }
  | { type: "open_deep_link"; url: string }
  | { type: "permission"; decision: "allow" | "allow_once" | "deny" }
  | { type: "waitFor"; text?: string; target?: Target; timeoutMs?: number }
  /** The web's `goto`: on Android, opening a link in the app (a test's `start:`). */
  | { type: "goto"; url: string }
  /** The web's check/uncheck: tap a checkbox or switch only if it isn't in that state yet. */
  | { type: "check"; target: Target }
  | { type: "uncheck"; target: Target };

export type AndroidActionType = AndroidAction["type"];

/** Every action the harness offers. Nothing else can be done to the device. */
export const ANDROID_ACTION_TYPES: readonly AndroidActionType[] = [
  "tap",
  "click",
  "long_press",
  "type",
  "fill",
  "clear",
  "press",
  "swipe",
  "scroll",
  "back",
  "home",
  "launch_app",
  "rotate",
  "open_deep_link",
  "permission",
  "waitFor",
  "goto",
  "check",
  "uncheck",
];

/**
 * The web reasons plus `outside_app`: the target is on a screen of another app
 * (the launcher after `home`, another app a link opened). Only the app under
 * test, permission dialogs and system dialogs about it can be touched.
 */
export type AndroidRefusalReason = RefusalReason | "outside_app";

/** `firewall`: dropped on the device (UDP, the host alias, emulator services). */
export type AndroidRefusalType = RefusalType | "firewall";

export interface AndroidRefusal extends Omit<Refusal, "type"> {
  type: AndroidRefusalType;
}

/** The app under test right after an action. */
export type AppState = "running" | "crashed" | "not_responding" | "not_running";

/** App or device trouble, as data (guarantee 6). */
export type AppProblem =
  | "app_crashed"
  | "app_not_responding"
  | "emulator_crashed"
  | "driver_lost"
  | "screen_changed";

/** What changed because of an action (VER-5), with Android's own signals. */
export interface AndroidPostState extends Omit<PostState, "refused"> {
  /** `android-app://<package>/<activity>` before and after. */
  urlBefore: string;
  urlAfter: string;
  refused: AndroidRefusal[];
  /** Toast messages shown during the action. */
  toasts: string[];
  app: AppState;
  /** False when nothing observable happened: same screen, no element, request, dialog, toast or crash. */
  changed: boolean;
}

/** The engine's learned wait (LRN-4); the harness settles fully either way. */
export interface AndroidActOptions {
  until?: (post: AndroidPostState) => boolean;
  ceilingMs?: number;
}

export interface AndroidActionOutcome extends Omit<ActionOutcome, "action" | "reason" | "post"> {
  action: AndroidAction;
  status: OutcomeStatus;
  reason?: AndroidRefusalReason;
  /** Set for app or device trouble (status is then `error`). */
  problem?: AppProblem;
  post: AndroidPostState;
}

export interface AndroidObservation extends Omit<Observation, "refused"> {
  /** `android-app://<package>/<activity>` of the resumed activity. */
  url: string;
  /** The top window's title (a dialog's title, else the activity's label). */
  title: string;
  refused: AndroidRefusal[];
  /** Screen rotation in degrees. */
  rotation: number;
}

export type { ScreenshotOptions as AndroidScreenshotOptions };

// ── Evidence ─────────────────────────────────────────────────────────────────

export interface AndroidEvidenceOptions {
  /** Screen recording (WebM, recorded by the emulator on the host). */
  video?: boolean;
  /** The device log, scrubbed. */
  logcat?: boolean;
  /** Connections and HTTP requests seen by the network guard (HAR, no bodies). */
  network?: boolean;
  /** Folder for the files (default: a new folder in the OS temp dir). */
  dir?: string;
}

/** One evidence file, scrubbed, ready for the contract's `RunWriter.writeArtifact`. */
export interface AndroidEvidenceFile {
  kind: "video" | "logcat" | "network";
  /** Attempt file from the contract layout: video, logcat.txt, network.har. */
  file: "video" | "logcat" | "network";
  path: string;
  contentType: string;
  scrubbed: true;
}

export interface AndroidCloseResult {
  evidence: AndroidEvidenceFile[];
  refused: AndroidRefusal[];
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface AndroidSessionOptions {
  /** Path to the APK under test. */
  apk: string;
  /** An emulator shared between sessions (`launchEmulator`), or omit to boot one for this session. */
  emulator?: import("./emulator.js").LaunchedEmulator;
  /** Android version from `versions.json` when the session boots its own emulator (default "16"). */
  androidVersion?: string;
  /** Device profile from `devices.json` when the session boots its own emulator (default "pixel-8"). */
  device?: string;
  /** Show the emulator window when this session boots its own (default: headless). */
  headless?: boolean;
  /**
   * Hosts the app may reach: `api.example.com`, `*.example.com`, `10.0.2.2:4180`
   * (the host machine's port 4180, through the emulator's host alias).
   */
  allowedDomains: readonly string[];
  /**
   * The environment's base URL: where setup/teardown requests (`hookRequest`) go,
   * from this machine (e.g. http://127.0.0.1:4180 for the fixture's shop). Relative
   * `goto` targets are refused on Android: a deep link needs its scheme.
   */
  baseUrl?: string;
  /** ENV-5: the device's timezone for this session (an IANA id, e.g. "Europe/Berlin"). */
  timezone?: string;
  /** ENV-5: the app's language for this session (a BCP 47 tag, e.g. "de-DE"; Android 13+ per-app language). */
  locale?: string;
  /** Loaded secrets; a secret can be typed only into an app whose package is in its `domains`. */
  secrets?: Readonly<Record<string, SecretValue>>;
  evidence?: AndroidEvidenceOptions;
  /** Scrubs everything the harness returns or writes. Default: the config's defaultRedactor. */
  redact?: (text: string) => string;
  /** Per-action timeout (default 5000 ms). */
  actionTimeoutMs?: number;
  settle?: SettleOptions;
  /** Maximum elements in one observation (default 400). */
  maxElements?: number;
}

/** Why a session could not start for app or device reasons (never thrown, guarantee 6). */
export type OpenFailureReason =
  | "app_install_failed"
  | "app_launch_failed"
  | "emulator_failed"
  | "driver_failed";

/** A system dialog about another package (e.g. "System UI isn't responding") that the session dismissed. */
export interface DismissedDialog {
  title: string;
  kind: "not_responding" | "crashed";
  /** The button pressed: Wait (an ANR), Close (a crash, or an ANR that kept coming back). */
  action: "wait" | "close";
  at: string;
}

export interface SessionTimings {
  /** Emulator boot, when the session booted its own. */
  bootMs?: number;
  /** Restoring the clean snapshot. */
  resetMs: number;
  installMs: number;
  driverMs: number;
  /** Times the on-device driver had to be started again (it exited before serving). */
  driverRestarts: number;
  /** Waiting for the system to be idle (launcher up, no system dialog) before launching the app. */
  readyMs: number;
  /**
   * Waiting for the device's network after the reset (MOB-3): on a slow machine
   * the restored snapshot's network comes up seconds later, and an app request
   * made before that fails on the device without reaching the guard.
   */
  networkMs: number;
  launchMs: number;
  totalMs: number;
  /**
   * System dialogs about other packages dismissed so far (at start and during the
   * session). Dialogs about the app under test are never dismissed.
   */
  systemDialogs: DismissedDialog[];
  /** Things the session couldn't do as asked (e.g. no screen recording), in words. */
  notes: string[];
}

export type OpenSessionResult =
  | { ok: true; session: import("./session.js").AndroidSession }
  | { ok: false; reason: OpenFailureReason; message: string };

export type { ElementFacts as AndroidElementFacts };
