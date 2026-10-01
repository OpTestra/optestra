import type { ProtectedHeaderSpec } from "@optestra/config";
import type { SecretValue } from "@optestra/config/node";

/** Browser engines a session can run on (TGT-3). */
export type BrowserName = "chromium" | "firefox" | "webkit";
export const BROWSER_NAMES: readonly BrowserName[] = ["chromium", "firefox", "webkit"];

export interface Viewport {
  width: number;
  height: number;
}

// ── Locators and targets ─────────────────────────────────────────────────────

/**
 * A serialisable way to find one element, in Playwright's priority order.
 * `frame` scopes it: each entry finds an `<iframe>` in the previous frame
 * (starting at the page), and the locator is resolved inside the last one.
 */
export type LocatorSpec = (
  | { kind: "role"; role: string; name?: string; exact?: boolean }
  | { kind: "label"; text: string; exact?: boolean }
  | { kind: "placeholder"; text: string; exact?: boolean }
  | { kind: "alt"; text: string; exact?: boolean }
  | { kind: "title"; text: string; exact?: boolean }
  | { kind: "testId"; value: string }
  | { kind: "text"; text: string; exact?: boolean }
  | { kind: "css"; selector: string }
) & {
  frame?: readonly LocatorSpec[];
  /** 0-based index when the locator matches several elements. */
  nth?: number;
};

export type LocatorKind = LocatorSpec["kind"];

/** A ref from the latest `observe()` (e.g. `{ ref: "e12" }`) or a locator. */
export type Target = { ref: string } | LocatorSpec;

// ── Actions (the closed set, SAF-2) ──────────────────────────────────────────

export type FillValue = string | { secret: string };

/** A page to open: a URL, or a secret holding one (a magic link from a test inbox, SEC-5). */
export type GotoUrl = string | { secret: string };

export type Action =
  | { type: "goto"; url: GotoUrl }
  | { type: "click"; target: Target }
  | { type: "dblclick"; target: Target }
  | { type: "fill"; target: Target; value: FillValue }
  | { type: "select"; target: Target; option: string | readonly string[] }
  | { type: "check"; target: Target }
  | { type: "uncheck"; target: Target }
  | { type: "press"; key: string; target?: Target }
  | { type: "hover"; target: Target }
  | { type: "scroll"; target?: Target; direction?: "up" | "down"; pixels?: number }
  | { type: "upload"; target: Target; files: string | readonly string[] }
  | { type: "back" }
  | { type: "reload" }
  | { type: "waitFor"; text?: string; target?: Target; timeoutMs?: number };

export type ActionType = Action["type"];

/** Every action the harness offers. Nothing else can be done to a page. */
export const ACTION_TYPES: readonly ActionType[] = [
  "goto",
  "click",
  "dblclick",
  "fill",
  "select",
  "check",
  "uncheck",
  "press",
  "hover",
  "scroll",
  "upload",
  "back",
  "reload",
  "waitFor",
];

// ── Outcomes ─────────────────────────────────────────────────────────────────

/**
 * ok: done. refused: the harness would not do it (safety). not_found: the target
 * isn't on the page (or matches several elements). timeout: it didn't happen in
 * time. error: the page crashed, closed or the browser failed.
 */
export type OutcomeStatus = "ok" | "refused" | "not_found" | "timeout" | "error";

/**
 * Why an action was refused. `disallowed_domain` and `missing_secret` are the
 * contract's BlockedReason values of the same name; the others are the agent's
 * own mistakes (the runner decides what to do with them).
 */
export type RefusalReason =
  | "disallowed_domain"
  | "missing_secret"
  /** A dynamic secret (a TOTP code, an inbox code or link) could not produce its value. */
  | "secret_unavailable"
  | "upload_not_allowed"
  | "file_outside_folder"
  | "invalid_action";

/** Traffic the network guard refused. */
export type RefusalType =
  | "navigation"
  | "iframe"
  | "popup"
  | "fetch"
  | "subresource"
  | "websocket"
  | "download"
  | "service_worker"
  | "scheme"
  | "proxy";

export interface Refusal {
  url: string;
  type: RefusalType;
  /** URL of the frame that made the request ("" when unknown). */
  frame: string;
  at: string;
}

export interface ElementSummary {
  role: string;
  name: string;
  /** Text content, for elements whose meaning is their text. */
  text?: string;
}

export interface RequestSummary {
  method: string;
  url: string;
  resourceType: string;
  /**
   * HTTP status; "failed"/"refused" when it didn't complete; "pending" when it
   * was still running (no response yet) at the time of the report.
   */
  status: number | "failed" | "refused" | "pending";
  /** Playwright's failure text, for "failed" requests. */
  failure?: string;
}

export interface DialogSummary {
  /** alert | confirm | prompt | beforeunload for native dialogs; dialog | alertdialog for page dialogs. */
  type: string;
  message: string;
  /** Native dialogs only: what the harness did with it. */
  handled?: "accepted" | "dismissed";
}

/** What changed because of an action (VER-5). */
export interface PostState {
  urlBefore: string;
  urlAfter: string;
  added: ElementSummary[];
  removed: ElementSummary[];
  requests: RequestSummary[];
  dialogs: DialogSummary[];
  popups: string[];
  refused: Refusal[];
  /** False when nothing observable happened: same URL, no element, request, dialog or popup. */
  changed: boolean;
  /**
   * The same elements as before, in a different order (a table sort). Not part of
   * `changed`, which compares the page as a set of elements.
   */
  reordered: boolean;
}

export interface SettleResult {
  settledMs: number;
  timedOut: boolean;
  /** How long each signal kept the page from being settled. */
  waitedFor: { network: number; dom: number; busy: number };
  /** Requests still in flight when settle returned. */
  inflight: number;
  /**
   * `effect`: the action's expected effect showed with no request in flight
   * (`act(action, { until })`, replay), so no quiet window was waited for.
   * Absent: an ordinary settle.
   */
  endedBy?: "effect";
}

export interface ActionOutcome {
  action: Action;
  status: OutcomeStatus;
  reason?: RefusalReason;
  message?: string;
  /** Time spent doing the action, not counting settle. */
  ms: number;
  settledMs: number;
  settle: SettleResult;
  post: PostState;
}

// ── Observation (MOD-3, SAF-3) ───────────────────────────────────────────────

export interface ElementStates {
  checked?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  pressed?: boolean | "mixed";
  selected?: boolean;
  invalid?: boolean;
  active?: boolean;
  level?: number;
  /** A sortable column's `aria-sort` (LOOP-4): ascending, descending or other; absent when none. */
  sort?: "ascending" | "descending" | "other";
}

export interface ObservedElement {
  /** Short ref (e.g. `e12`) for elements an action can target; valid until the next observe. */
  ref?: string;
  role: string;
  name: string;
  /** Nesting depth in the filtered tree (0 = top). */
  depth: number;
  /** Text content (static text, paragraphs, cells) or a field's value. */
  text?: string;
  url?: string;
  placeholder?: string;
  states: ElementStates;
  /** Can be clicked or typed into. */
  interactive: boolean;
  /** Index into `Observation.frames`. 0 = the page. */
  frame: number;
  box?: { x: number; y: number; width: number; height: number };
}

export interface ObservedFrame {
  url: string;
  /** Ref of the iframe element that holds it (null for the page). */
  parentRef: string | null;
}

/**
 * The page as data. `untrusted: true` always: everything here was written by the
 * page, never by the test author. Render it with `renderForModel`.
 */
export interface Observation {
  readonly untrusted: true;
  url: string;
  title: string;
  observedAt: string;
  frames: ObservedFrame[];
  elements: ObservedElement[];
  /** Traffic refused since the previous observe. */
  refused: Refusal[];
  /** True when the page had more elements than `maxElements`. */
  truncated: boolean;
}

export interface LocatorCandidate {
  locator: LocatorSpec;
  /** Exactly one element matches. */
  unique: boolean;
  matches: number;
}

/** Facts about an element for fingerprints (HEAL / LOOP-4). */
export interface ElementFacts {
  role: string;
  name: string;
  tag: string;
  attributes: Record<string, string>;
  text: string;
  /** Closest heading, legend, label or landmark name around the element. */
  anchorText: string;
  framePath: LocatorSpec[];
  box: { x: number; y: number; width: number; height: number } | null;
}

/** What a locator finds right now (LOOP-4 replay validates it against a fingerprint). */
export interface InspectResult {
  /** ok: exactly one element; not_found: none; multiple: more than one; error: bad locator or page gone. */
  status: "ok" | "not_found" | "multiple" | "error";
  matches: number;
  /** Facts about the one element (status ok). */
  facts: ElementFacts | null;
  message?: string;
}

export interface CandidatesResult {
  status: "ok" | "not_found";
  candidates: LocatorCandidate[];
  facts: ElementFacts | null;
}

// ── Screenshots and evidence ─────────────────────────────────────────────────

export interface ScreenshotOptions {
  /** true: JPEG, at most 1280 px wide, for a model. false (default): full-resolution PNG evidence. */
  forModel?: boolean;
  /**
   * Evidence format (default png). `jpeg`: full resolution at quality 80, much
   * cheaper to take and store; replay uses it for steps that passed.
   */
  format?: "png" | "jpeg";
  /** Crop to one element. */
  target?: Target;
}

export interface ScreenshotResult {
  status: "ok" | "not_found" | "error";
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg";
  message?: string;
}

export interface EvidenceOptions {
  video?: boolean;
  trace?: boolean;
  console?: boolean;
  network?: boolean;
  /** Folder for temporary files (default: a new folder in the OS temp dir). */
  dir?: string;
}

/** One evidence file, scrubbed, ready for the contract's `RunWriter.writeArtifact`. */
export interface EvidenceFile {
  kind: "video" | "trace" | "console" | "network";
  /** Attempt file name from the contract layout: video.webm, trace.zip, console.log, network.har. */
  file: "video" | "trace" | "console" | "network";
  path: string;
  contentType: string;
  scrubbed: true;
}

/** A setup/teardown request (AUT-10). Not an agent action: the model can't call it. */
export interface HookRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  /** A path on the app (resolved against baseUrl) or an absolute http(s) URL. */
  target: string;
  /** Objects are sent as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HookResult {
  status: "ok" | "refused" | "failed" | "error";
  /** HTTP status when a response came back. */
  httpStatus?: number;
  reason?: "disallowed_domain" | "invalid_action";
  /** Scrubbed; for failures, the start of the response body. */
  message?: string;
}

export interface CloseOptions {
  /**
   * Evidence not wanted after all (a clean pass under `run.evidence: failures`):
   * it is dropped without being scrubbed or written. Recording it still ran, so
   * the caller could decide at the end.
   */
  discard?: readonly ("trace" | "network")[];
}

export interface CloseResult {
  evidence: EvidenceFile[];
  refused: Refusal[];
}

// ── Options ──────────────────────────────────────────────────────────────────

/** Playwright storage state (cookies + local storage), passed in explicitly. */
export interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export interface SettleOptions {
  /** Give up after this long (default 10 000 ms). */
  timeoutMs?: number;
  /** How long network and DOM must stay quiet (default 300 ms). */
  quietMs?: number;
}

/**
 * Replay's learned wait (LRN-4): instead of the generic quiet window, the
 * action is done as soon as `until` holds for its post-state with no request
 * in flight. If it doesn't within `ceilingMs`, the ordinary settle decides and
 * the outcome is built as usual (the caller then sees the mismatch).
 */
export interface ActOptions {
  /** The expected effect, checked against the post-state as it builds up. */
  until?: (post: PostState) => boolean;
  /** How long to look for the effect before falling back to settle (default 3000 ms). */
  ceilingMs?: number;
}

export interface SessionOptions {
  /** Engine name (a browser is launched for this session) or a shared launched browser. */
  browser?: BrowserName | import("./launch.js").LaunchedBrowser;
  headless?: boolean;
  /** Device preset name from `devices.json` (TGT-3). */
  device?: string;
  /** Custom size; overrides the preset's viewport. */
  viewport?: Viewport;
  locale?: string;
  timezone?: string;
  baseUrl?: string;
  /** Hosts the browser may reach: `example.com`, `*.example.com`, `example.com:8080`. */
  allowedDomains: readonly string[];
  /** Loaded secrets by name; each carries the domains it may be typed into. */
  secrets?: Readonly<Record<string, SecretValue>>;
  /**
   * Protected previews (SEC-8): headers whose values are secrets from `secrets`,
   * added only to requests for allowed hosts in that secret's domains.
   */
  protectedHeaders?: readonly ProtectedHeaderSpec[];
  /** Enables `upload`, only for files inside this folder (the test's folder). */
  allowUpload?: { dir: string };
  storageState?: StorageState;
  evidence?: EvidenceOptions;
  /** Scrubs everything the harness returns or writes. Default: the config's defaultRedactor. */
  redact?: (text: string) => string;
  /** Per-action timeout (default 5000 ms). */
  actionTimeoutMs?: number;
  settle?: SettleOptions;
  /** Native alert/confirm/prompt handling (default: accept alerts, dismiss the rest). */
  nativeDialogs?: "accept" | "dismiss";
  /** Maximum elements in one observation (default 400). */
  maxElements?: number;
  /**
   * ENV-4: recorded traffic. `record`: keep every fetch/XHR answer (scrubbed) and
   * write it to this HAR file on close. `replay`: answer those requests from it.
   * `label` is how the report names the file (project-relative).
   */
  network?: { mode: "record" | "replay"; file: string; label?: string };
}
