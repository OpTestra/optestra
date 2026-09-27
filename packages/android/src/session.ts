import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Allowlist } from "@testament/browser";
import { defaultRedactor, Redactor } from "@testament/config/node";
// RESTRICTED import: the Android driver types secrets into the app they belong to (SEC-1).
import { prepareSecret, revealSecret } from "@testament/config/reveal";
import type { CheckOp } from "@testament/recording";
import {
  type AndroidCheckOptions,
  AndroidRequestMark,
  type CheckEvaluation,
  evaluateCheck,
  ScreenCopy,
} from "./check.js";
import { DriverClient, DriverError, type Dump, type Hello } from "./driver.js";
import { ensureRoot, type LaunchedEmulator, launchEmulator } from "./emulator.js";
import {
  COUNTERS_COMMAND,
  type FirewallCounters,
  firewallRules,
  parseCounters,
  resetRules,
} from "./firewall.js";
import {
  buildObservation,
  diffElements,
  type RefKey,
  reorderedElements,
  Screen,
  type ScreenNode,
} from "./hierarchy.js";
import { candidatesFor, resolveLocator } from "./locators.js";
import { Logcat } from "./logcat.js";
import { AndroidSetupError } from "./sdk.js";
import { findSystemDialogs } from "./system-dialogs.js";
import { PACKAGE_NAME, type Running, runAdb, startAdb } from "./tools.js";
import type {
  AndroidAction,
  AndroidActionOutcome,
  AndroidCloseResult,
  AndroidEvidenceFile,
  AndroidObservation,
  AndroidPostState,
  AndroidRefusal,
  AndroidRefusalReason,
  AndroidSessionOptions,
  AppProblem,
  AppState,
  CandidatesResult,
  DialogSummary,
  DismissedDialog,
  OpenFailureReason,
  OpenSessionResult,
  OutcomeStatus,
  RequestSummary,
  ScreenshotOptions,
  ScreenshotResult,
  SessionTimings,
  SettleOptions,
  SettleResult,
  Target,
} from "./types.js";

const ACTION_TIMEOUT_MS = 5_000;
const MODEL_MAX_WIDTH = 1280;
const MAX_ELEMENTS = 400;
const DEFAULT_SETTLE = { timeoutMs: 10_000, quietMs: 300 };
const AFTER_NETWORK_QUIET_MS = 800;
/** How long to wait before looking again at an action that seemed to change nothing. */
const SECOND_LOOK_MS = 1_000;
const PERMISSION_PACKAGES = /permissioncontroller$/;
/** Permission prompt buttons across Android versions, by decision, preferred first. */
const PERMISSION_BUTTONS: Record<"allow" | "allow_once" | "deny", readonly string[]> = {
  allow: [
    "permission_allow_foreground_only_button",
    "permission_allow_button",
    "permission_allow_always_button",
  ],
  allow_once: [
    "permission_allow_one_time_button",
    "permission_allow_foreground_only_button",
    "permission_allow_button",
  ],
  deny: ["permission_deny_button", "permission_deny_and_dont_ask_again_button"],
};
/** Key names (Playwright's where they exist) to Android key codes. */
const KEYS: Record<string, number> = {
  enter: 66,
  tab: 61,
  backspace: 67,
  delete: 112,
  escape: 111,
  space: 62,
  search: 84,
  arrowup: 19,
  arrowdown: 20,
  arrowleft: 21,
  arrowright: 22,
  home: 122,
  end: 123,
  pageup: 92,
  pagedown: 93,
};
const BLOCKED_SCHEMES = new Set([
  "file",
  "content",
  "intent",
  "javascript",
  "data",
  "android-app",
  "about",
]);

interface Result {
  status: OutcomeStatus;
  reason?: AndroidRefusalReason;
  message?: string;
  problem?: AppProblem;
}

const ok: Result = { status: "ok" };
const refused = (reason: AndroidRefusalReason, message: string): Result => ({
  status: "refused",
  reason,
  message,
});
const notFound = (message: string): Result => ({ status: "not_found", message });

interface LoggedRequest {
  summary: RequestSummary;
  at: string;
}

/**
 * Dismisses Android's ANR and crash dialogs about *other* packages (System UI,
 * the launcher) that sit on top of the app on slow or shared machines, and
 * records each one. A dialog about the app under test is left alone: it is a
 * finding, reported through the action outcome.
 */
class SystemDialogGuard {
  readonly #driver: DriverClient;
  readonly #appPackage: string;
  readonly #appLabel: string | null;
  /** How the session reads a dump (with its secret fields); set once the session exists. */
  screenOf: (dump: Dump) => Screen;
  readonly #record: DismissedDialog[];
  readonly #redact: (text: string) => string;
  readonly #seen = new Map<string, number>();

  constructor(init: {
    driver: DriverClient;
    appPackage: string;
    appLabel: string | null;
    record: DismissedDialog[];
    redact: (text: string) => string;
  }) {
    this.#driver = init.driver;
    this.#appPackage = init.appPackage;
    this.#appLabel = init.appLabel;
    this.screenOf = (dump) => new Screen(dump, { appPackage: init.appPackage });
    this.#record = init.record;
    this.#redact = init.redact;
  }

  /** The screen, with foreign system dialogs gone, or null when the driver can't read it. */
  async clear(rounds = 5): Promise<Screen | null> {
    let settleUntil = 0;
    for (let round = 0; ; round++) {
      const dump = await this.#driver.dump().catch(() => null);
      if (!dump) return null;
      const screen = this.screenOf(dump);
      const foreign = findSystemDialogs(
        screen,
        this.#appLabel,
        (title) => this.#seen.get(title) ?? 0,
      ).filter((dialog) => dialog.owner === "other" && dialog.dismiss);
      if (foreign.length === 0 || round >= rounds) {
        // After a dismissal, the window underneath needs a moment to show its content again.
        if (screen.busy() && Date.now() < settleUntil) {
          await sleep(250);
          continue;
        }
        return screen;
      }
      settleUntil = Date.now() + 5_000;
      for (const dialog of foreign) {
        const [l, t, r, b] = dialog.dismiss?.node.bounds ?? [0, 0, 0, 0];
        await this.#driver
          .call("tap", { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) })
          .catch(() => {});
        this.#seen.set(dialog.title, (this.#seen.get(dialog.title) ?? 0) + 1);
        this.#record.push({
          title: this.#redact(dialog.title),
          kind: dialog.kind,
          action: dialog.dismiss?.node.rid === "android:id/aerr_wait" ? "wait" : "close",
          at: new Date().toISOString(),
        });
      }
      // Give the dialog a moment to come back (a process that is still stuck gets
      // another dialog quickly; the next round then presses Close).
      await this.#driver.call("idle", { quietMs: 1_000, timeoutMs: 5_000 }, 10_000).catch(() => {});
    }
  }
}

interface Init {
  emulator: LaunchedEmulator;
  ownsEmulator: boolean;
  options: AndroidSessionOptions;
  allowlist: Allowlist;
  redact: (text: string) => string;
  secretRedactor: Redactor;
  appPackage: string;
  driver: DriverClient;
  instrument: Running;
  forwardPort: number;
  logcat: Logcat;
  logcatProcess: Running;
  hello: Hello;
  evidenceDir: string;
  video: string | null;
  requests: LoggedRequest[];
  refusals: AndroidRefusal[];
  counters: FirewallCounters;
  timings: SessionTimings;
  systemDialogs: SystemDialogGuard;
}

/**
 * An Android session for one test: a clean emulator (restored from its clean
 * snapshot) with the app freshly installed, behind the network guard, offering
 * only the closed action set. No adb, device shell or driver object is reachable.
 */
export class AndroidSession {
  readonly #emulator: LaunchedEmulator;
  readonly #ownsEmulator: boolean;
  readonly #options: AndroidSessionOptions;
  readonly #allowlist: Allowlist;
  readonly #redact: (text: string) => string;
  readonly #secretRedactor: Redactor;
  readonly #appPackage: string;
  readonly #driver: DriverClient;
  readonly #instrument: Running;
  readonly #forwardPort: number;
  readonly #logcat: Logcat;
  readonly #logcatProcess: Running;
  readonly #hello: Hello;
  readonly #evidenceDir: string;
  readonly #video: string | null;
  readonly #requests: LoggedRequest[];
  readonly #refusals: AndroidRefusal[];
  readonly #timings: SessionTimings;
  readonly #systemDialogs: SystemDialogGuard;
  readonly #secretFields = new Map<string, string>();
  #refs = new Map<string, RefKey>();
  #latest: Screen | null = null;
  #refusalCursor = 0;
  #counters: FirewallCounters = { app: 0, system: 0 };
  #closed: AndroidCloseResult | undefined;
  #mark = 0;

  /** @internal Use `openAndroidSession`. */
  constructor(init: Init) {
    this.#emulator = init.emulator;
    this.#ownsEmulator = init.ownsEmulator;
    this.#options = init.options;
    this.#allowlist = init.allowlist;
    this.#redact = init.redact;
    this.#secretRedactor = init.secretRedactor;
    this.#appPackage = init.appPackage;
    this.#driver = init.driver;
    this.#instrument = init.instrument;
    this.#forwardPort = init.forwardPort;
    this.#logcat = init.logcat;
    this.#logcatProcess = init.logcatProcess;
    this.#hello = init.hello;
    this.#evidenceDir = init.evidenceDir;
    this.#video = init.video;
    this.#requests = init.requests;
    this.#refusals = init.refusals;
    this.#timings = init.timings;
    this.#systemDialogs = init.systemDialogs;
    this.#systemDialogs.screenOf = (dump) =>
      new Screen(dump, { appPackage: this.#appPackage, secretFields: this.#secretFields });
    this.#counters = init.counters;
  }

  /** The app under test's package name. */
  appPackage(): string {
    return this.#appPackage;
  }

  /** The device this session runs on: version, profile and what the device reports. */
  device(): {
    androidVersion: string;
    profile: string;
    sdk: number;
    model: string;
    width: number;
    height: number;
    density: number;
  } {
    return {
      androidVersion: this.#emulator.androidVersion,
      profile: this.#emulator.device,
      sdk: this.#hello.sdk,
      model: this.#hello.model,
      width: this.#hello.width,
      height: this.#hello.height,
      density: this.#hello.density,
    };
  }

  /** The contract's MatrixEntry for this session. */
  matrixEntry(): { target: "android"; androidVersion: string; device: string } {
    return {
      target: "android",
      androidVersion: this.#emulator.androidVersion,
      device: this.#emulator.device,
    };
  }

  /** How long starting the session took. */
  timings(): SessionTimings {
    return {
      ...this.#timings,
      systemDialogs: [...this.#timings.systemDialogs],
      notes: [...this.#timings.notes],
    };
  }

  /** `android-app://<package>/<activity>` of the last screen seen (scrubbed). */
  url(): string {
    return this.#redact(this.#latest?.url ?? `android-app://${this.#appPackage}`);
  }

  /** Every connection refused so far. */
  refusals(): AndroidRefusal[] {
    return [...this.#refusals];
  }

  // ── Screen ────────────────────────────────────────────────────────────────

  #problem(): AppProblem | null {
    if (!this.#emulator.running) return "emulator_crashed";
    if (this.#driver.closed) return "driver_lost";
    return null;
  }

  async #screen(): Promise<Screen | null> {
    if (this.#problem()) return null;
    try {
      const dump = await this.#driver.dump();
      this.#latest = new Screen(dump, {
        appPackage: this.#appPackage,
        secretFields: this.#secretFields,
      });
      return this.#latest;
    } catch {
      return null;
    }
  }

  /** A fresh screen that is not between windows (waits up to `timeoutMs`). */
  async #readyScreen(timeoutMs = 5_000): Promise<Screen | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = await this.#screen();
      if (!screen?.transitioning() || Date.now() > deadline) return screen;
      await sleep(150);
    }
  }

  /** A fresh screen with foreign system dialogs dismissed first (the one the guard checked). */
  async #clearScreen(): Promise<Screen | null> {
    if (this.#problem()) return null;
    const screen = await this.#systemDialogs.clear();
    if (screen) this.#latest = screen;
    return screen;
  }

  #blank(): Screen {
    const dump: Dump = { windows: [], nodes: [], truncated: false, activity: null, rotation: 0 };
    return new Screen(dump, { appPackage: this.#appPackage });
  }

  async #firewallRefusals(): Promise<AndroidRefusal[]> {
    const result = await runAdb(
      this.#emulator.sdk,
      this.#emulator.serial,
      { name: "firewall", rules: COUNTERS_COMMAND },
      10_000,
    );
    const now = parseCounters(result.stdout);
    const out: AndroidRefusal[] = [];
    // Only the app's own non-TCP traffic; the system's (time sync, discovery) is not the test's.
    if (now.app > this.#counters.app) {
      out.push({ url: "udp:", type: "firewall", frame: "", at: new Date().toISOString() });
    }
    this.#counters = now;
    this.#refusals.push(...out);
    return out;
  }

  /** The screen as data (untrusted). Refs are valid until the next observe. */
  async observe(): Promise<AndroidObservation> {
    const screen = (await this.#clearScreen()) ?? this.#blank();
    await this.#firewallRefusals();
    const refused = this.#refusals.slice(this.#refusalCursor);
    this.#refusalCursor = this.#refusals.length;
    const built = buildObservation(screen, {
      maxElements: this.#options.maxElements ?? MAX_ELEMENTS,
      redact: this.#redact,
      refused,
    });
    this.#refs = built.refs;
    return built.observation;
  }

  #resolve(target: Target, screen: Screen): { entry: ScreenNode } | { result: Result } {
    if ("ref" in target) {
      const key = this.#refs.get(target.ref);
      if (!key) return { result: notFound(`${target.ref} is not a ref from the latest observe.`) };
      const entry = screen.find(key);
      if (!entry)
        return { result: notFound(`The screen changed: ${target.ref} is gone. Observe again.`) };
      return { entry };
    }
    const { entry, count } = resolveLocator(screen, target);
    if (entry) return { entry };
    return {
      result: notFound(
        count === 0
          ? "Nothing on the screen matches the target."
          : `The target matches ${count} elements.`,
      ),
    };
  }

  async candidates(ref: string): Promise<CandidatesResult> {
    const screen = await this.#screen();
    const key = this.#refs.get(ref);
    const entry = screen && key ? screen.find(key) : undefined;
    if (!screen || !entry) return { status: "not_found", candidates: [], facts: null };
    return candidatesFor(screen, entry, this.#redact);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async act(action: AndroidAction): Promise<AndroidActionOutcome> {
    const started = Date.now();
    const timeout = this.#options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    const before = await this.#clearScreen();
    const requestMark = this.#requests.length;
    const refusalMark = this.#refusals.length;
    const logMark = this.#logcat.position;
    const beforeElements = before
      ? buildObservation(before, { maxElements: MAX_ELEMENTS, redact: this.#redact, refused: [] })
          .observation.elements
      : [];
    const beforeWindows = before ? dialogWindows(before) : [];
    await this.#driver.call("events").catch(() => {});

    let result: Result;
    const problem = this.#problem();
    if (problem || !before) {
      result = {
        status: "error",
        problem: problem ?? "driver_lost",
        message: messageFor(problem ?? "driver_lost"),
      };
    } else {
      try {
        result = await this.#perform(action, before, timeout);
      } catch (error) {
        const lost = this.#problem();
        result = lost
          ? { status: "error", problem: lost, message: messageFor(lost) }
          : error instanceof DriverError && error.code === "driver_timeout"
            ? { status: "timeout", message: error.message }
            : { status: "error", message: error instanceof Error ? error.message : String(error) };
      }
    }
    const ms = Date.now() - started;
    const settle =
      result.status === "ok"
        ? await this.settle()
        : {
            settledMs: 0,
            timedOut: false,
            waitedFor: { network: 0, dom: 0, busy: 0 },
            inflight: 0,
          };

    // What happened (VER-5). Toasts are drained from the driver, so they add up over looks.
    const toasts: { text: string }[] = [];
    const look = async () => {
      let appEvents = this.#logcat.eventsSince(logMark, this.#appPackage);
      let app: AppState = "running";
      if (!this.#problem()) {
        const state = (await this.#driver
          .call("app_state", { package: this.#appPackage })
          .catch(() => null)) as { running?: boolean } | null;
        if (state && state.running === false && appEvents.length === 0) {
          await sleep(500); // the crash may still be on its way through logcat
          appEvents = this.#logcat.eventsSince(logMark, this.#appPackage);
        }
        app = state?.running === false ? "not_running" : "running";
      }
      if (appEvents.some((e) => e.kind === "crashed")) app = "crashed";
      else if (appEvents.some((e) => e.kind === "not_responding")) app = "not_responding";
      // Never read the post-state off a screen that is between windows (one gone,
      // the next not reported yet: settle can end just before a new window shows).
      const after = await this.#readyScreen();
      const notices =
        (
          (await this.#driver.call("events").catch(() => ({ toasts: [] }))) as {
            toasts?: { text: string; toast?: boolean }[];
          }
        ).toasts ?? [];
      toasts.push(...notices.filter((n) => n.toast !== false));
      await this.#firewallRefusals().catch(() => []);
      const afterElements = after
        ? buildObservation(after, { maxElements: MAX_ELEMENTS, redact: this.#redact, refused: [] })
            .observation.elements
        : [];
      const { added, removed } = diffElements(beforeElements, afterElements);
      const opened = after
        ? dialogWindows(after).filter((w) => !beforeWindows.some((b) => b.key === w.key))
        : [];
      const dialogs: DialogSummary[] = opened.map((w) => ({
        type: w.type,
        message: this.#redact(w.title),
      }));
      const requests = this.#requests.slice(requestMark).map((r) => r.summary);
      const refusedNow = this.#refusals.slice(refusalMark);
      const urlBefore = this.#redact(before?.url ?? "");
      const urlAfter = this.#redact(after?.url ?? urlBefore);
      const reordered =
        added.length === 0 &&
        removed.length === 0 &&
        reorderedElements(beforeElements, afterElements);
      const post: AndroidPostState = {
        urlBefore,
        urlAfter,
        added,
        removed,
        reordered,
        requests,
        dialogs,
        popups: opened
          .filter((w) => w.package !== this.#appPackage)
          .map((w) => this.#redact(`android-app://${w.package}`)),
        refused: refusedNow,
        toasts: toasts.map((t) => this.#redact(t.text)),
        app,
        changed:
          urlBefore !== urlAfter ||
          added.length > 0 ||
          removed.length > 0 ||
          reordered ||
          requests.length > 0 ||
          dialogs.length > 0 ||
          toasts.length > 0 ||
          app === "crashed" ||
          app === "not_responding",
      };
      return { post, app, appEvents };
    };
    let { post, app, appEvents } = await look();
    // A second look when nothing changed: apps sometimes react a second or more
    // after a tap with nothing in between (no event, no request, no log line), so
    // settle can't see it coming. A tap that really does nothing (the VER-5 trap)
    // still reports changed: false, one look later.
    if (result.status === "ok" && !post.changed && action.type !== "waitFor" && !this.#problem()) {
      await sleep(SECOND_LOOK_MS);
      const again = await this.settle();
      settle.settledMs += SECOND_LOOK_MS + again.settledMs;
      settle.timedOut = again.timedOut;
      ({ post, app, appEvents } = await look());
    }
    if (result.status === "ok" && (app === "crashed" || app === "not_responding")) {
      const detail = appEvents[appEvents.length - 1]?.detail;
      result = {
        status: "error",
        problem: app === "crashed" ? "app_crashed" : "app_not_responding",
        message: `${app === "crashed" ? "The app crashed" : "The app stopped responding"}${detail ? `: ${detail}` : "."}`,
      };
    }
    const outcome: AndroidActionOutcome = {
      action: this.#scrubAction(action),
      status: result.status,
      ms,
      settledMs: settle.settledMs,
      settle,
      post,
    };
    if (result.reason) outcome.reason = result.reason;
    if (result.problem) outcome.problem = result.problem;
    if (result.message !== undefined) outcome.message = this.#redact(result.message);
    return outcome;
  }

  #scrubAction(action: AndroidAction): AndroidAction {
    if ((action.type === "type" || action.type === "fill") && typeof action.value === "string") {
      return { ...action, value: this.#redact(action.value) };
    }
    if (action.type === "open_deep_link") return { ...action, url: this.#redact(action.url) };
    if (action.type === "waitFor" && action.text !== undefined)
      return { ...action, text: this.#redact(action.text) };
    return action;
  }

  /** Brings a node into view by scrolling its scrollable ancestor. Returns the fresh node and screen. */
  async #visible(
    entry: ScreenNode,
    screen: Screen,
  ): Promise<{ entry: ScreenNode; screen: Screen } | null> {
    let current = entry;
    let now = screen;
    for (let i = 0; i < 10; i++) {
      const window = now.dump.windows.find((w) => w.id === current.node.window);
      const [l, t, r, b] = current.node.bounds;
      const inWindow =
        !window || (t >= window.bounds[1] && b <= window.bounds[3] && r > l && b > t);
      if (current.visible && inWindow) return { entry: current, screen: now };
      const scroller = now.scrollableAncestor(current);
      if (!scroller) return current.visible ? { entry: current, screen: now } : null;
      const below = !window || t >= (window.bounds[1] + window.bounds[3]) / 2;
      await this.#driver.call("scroll", {
        node: scroller.index,
        direction: below ? "forward" : "backward",
      });
      await this.#driver.call("idle", { quietMs: 200, timeoutMs: 2_000 });
      const key = now.keyOf(current);
      const next = await this.#screen();
      const found = next?.find(key);
      if (!next || !found) return null;
      current = found;
      now = next;
    }
    return null;
  }

  static #center(entry: ScreenNode, screen: Screen): { x: number; y: number } {
    const window = screen.dump.windows.find((w) => w.id === entry.node.window);
    let [l, t, r, b] = entry.node.bounds;
    if (window) {
      l = Math.max(l, window.bounds[0]);
      t = Math.max(t, window.bounds[1]);
      r = Math.min(r, window.bounds[2]);
      b = Math.min(b, window.bounds[3]);
    }
    return { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) };
  }

  async #target(
    target: Target,
    screen: Screen,
  ): Promise<{ entry: ScreenNode; screen: Screen } | { result: Result }> {
    const resolved = this.#resolve(target, screen);
    if ("result" in resolved) return resolved;
    if (!screen.touchable(resolved.entry)) {
      return {
        result: refused(
          "outside_app",
          `The target is on a screen of ${screen.packageOf(resolved.entry)}, not the app under test.`,
        ),
      };
    }
    const shown = await this.#visible(resolved.entry, screen);
    if (!shown)
      return {
        result: notFound("The target is not on the screen and could not be scrolled into view."),
      };
    return shown;
  }

  async #perform(action: AndroidAction, screen: Screen, timeout: number): Promise<Result> {
    switch (action.type) {
      case "tap":
      case "click":
      case "long_press": {
        const found = await this.#target(action.target, screen);
        if ("result" in found) return found.result;
        const at = AndroidSession.#center(found.entry, found.screen);
        if (action.type === "long_press") {
          await this.#driver.call("long_press", { ...at, ms: action.ms ?? 900 });
        } else {
          await this.#driver.call("tap", at);
        }
        return ok;
      }
      case "type":
      case "fill":
      case "clear": {
        const found = await this.#target(action.target, screen);
        if ("result" in found) return found.result;
        if (found.entry.role !== "textbox")
          return refused("invalid_action", "The target is not a text field.");
        // Tap the field first, as a person would: it takes focus by touch, so the
        // window stays in touch mode and the next tap elsewhere is a plain tap.
        if (!found.entry.node.flags.includes("focused")) {
          await this.#driver.call("tap", AndroidSession.#center(found.entry, found.screen));
          await this.#driver.call("idle", { quietMs: 150, timeoutMs: 1_500 });
        }
        if (action.type === "clear") {
          await this.#driver.call("set_text", { node: found.entry.index, text: "" });
          this.#secretFields.delete(found.entry.path);
          return ok;
        }
        if (typeof action.value === "string") {
          await this.#driver.call("set_text", { node: found.entry.index, text: action.value });
          this.#secretFields.delete(found.entry.path);
          return ok;
        }
        return this.#typeSecret(found.entry, found.screen, action.value.secret);
      }
      case "press": {
        const code = KEYS[action.key.toLowerCase()];
        if (code === undefined) return refused("invalid_action", `Unknown key "${action.key}".`);
        if (action.target) {
          const found = await this.#target(action.target, screen);
          if ("result" in found) return found.result;
          await this.#driver.call("tap", AndroidSession.#center(found.entry, found.screen));
        }
        await this.#driver.call("key", { code });
        return ok;
      }
      case "swipe": {
        let area = mainArea(screen);
        if (action.target) {
          const found = await this.#target(action.target, screen);
          if ("result" in found) return found.result;
          area = found.entry.node.bounds;
        }
        const [l, t, r, b] = area;
        const cx = (l + r) / 2;
        const cy = (t + b) / 2;
        const dx = (r - l) * 0.3;
        const dy = (b - t) * 0.3;
        const path = {
          up: [cx, cy + dy, cx, cy - dy],
          down: [cx, cy - dy, cx, cy + dy],
          left: [cx + dx, cy, cx - dx, cy],
          right: [cx - dx, cy, cx + dx, cy],
        }[action.direction];
        const [x1, y1, x2, y2] = path.map(Math.round) as [number, number, number, number];
        await this.#driver.call("swipe", { x1, y1, x2, y2, ms: 350 });
        return ok;
      }
      case "scroll": {
        if (action.target) {
          const found = await this.#target(action.target, screen);
          return "result" in found ? found.result : ok;
        }
        const scroller = mainScroller(screen);
        if (!scroller) return notFound("Nothing on the screen scrolls.");
        await this.#driver.call("scroll", {
          node: scroller.index,
          direction: action.direction === "up" ? "backward" : "forward",
        });
        return ok;
      }
      case "back":
        await this.#driver.call("global", { action: "back" });
        return ok;
      case "home":
        await this.#driver.call("global", { action: "home" });
        return ok;
      case "launch_app": {
        const started = (await this.#driver.call("launch", { package: this.#appPackage })) as {
          started?: boolean;
        };
        return started.started
          ? ok
          : { status: "error", message: "The app has no launcher screen." };
      }
      case "rotate":
        await this.#driver.call("rotate", { degrees: action.orientation === "landscape" ? 90 : 0 });
        return ok;
      case "open_deep_link": {
        let url: URL;
        try {
          url = new URL(action.url);
        } catch {
          return refused("invalid_action", "The link is not a URL.");
        }
        const scheme = url.protocol.replace(/:$/, "").toLowerCase();
        if (BLOCKED_SCHEMES.has(scheme))
          return refused("invalid_action", `${scheme}: links can't be opened.`);
        if ((scheme === "http" || scheme === "https") && !this.#allowlist.allowsUrl(url)) {
          return refused("disallowed_domain", `${url.host} is not in the allowed domains.`);
        }
        const started = (await this.#driver.call("open_uri", {
          uri: action.url,
          package: this.#appPackage,
        })) as {
          started?: boolean;
        };
        return started.started ? ok : notFound("The app has no screen for this link.");
      }
      case "permission": {
        const buttons = PERMISSION_BUTTONS[action.decision];
        const prompt = [...screen.shown()].filter((entry) =>
          PERMISSION_PACKAGES.test(screen.packageOf(entry)),
        );
        if (prompt.length === 0) return notFound("No permission prompt is showing.");
        for (const id of buttons) {
          const button = prompt.find((entry) => entry.testId === id && entry.visible);
          if (button) {
            await this.#driver.call("tap", AndroidSession.#center(button, screen));
            return ok;
          }
        }
        return notFound(`The permission prompt has no "${action.decision}" button.`);
      }
      case "waitFor": {
        const deadline = Date.now() + (action.timeoutMs ?? timeout);
        for (;;) {
          const now = await this.#screen();
          if (now) {
            if (action.target && "result" in this.#resolve(action.target, now) === false) return ok;
            if (action.text !== undefined) {
              const want = action.text.toLowerCase();
              for (const entry of now.shown()) {
                const text = `${entry.node.text ?? ""} ${entry.node.desc ?? ""}`.toLowerCase();
                if (entry.visible && text.includes(want)) return ok;
              }
            }
          }
          if (Date.now() > deadline)
            return { status: "timeout", message: "It did not appear in time." };
          await sleep(150);
        }
      }
      default:
        return refused(
          "invalid_action",
          `Unknown action "${(action as { type?: unknown }).type}". Use one of the Android actions.`,
        );
    }
  }

  async #typeSecret(entry: ScreenNode, screen: Screen, name: string): Promise<Result> {
    const secret = this.#options.secrets?.[name];
    if (!secret) return refused("missing_secret", `Secret ${name} is not available.`);
    const pkg = screen.packageOf(entry);
    if (pkg !== this.#appPackage || !new Allowlist(secret.domains).allowsHost(pkg)) {
      return refused(
        "disallowed_domain",
        `Secret ${name} may not be typed into ${pkg}; it is allowed in: ${secret.domains.join(", ") || "nothing"}.`,
      );
    }
    // The value to type now: a TOTP secret produces its current code here.
    const value = await prepareSecret(secret);
    this.#secretRedactor.register(value, secret.label);
    this.#secretFields.set(entry.path, secret.label);
    await this.#driver.call("set_text", { node: entry.index, text: value });
    return ok;
  }

  // ── Settle, screenshots, checks ───────────────────────────────────────────

  /** Waits until the UI is quiet, the network is idle and nothing shows progress (LRN-4). */
  async settle(options: SettleOptions = {}): Promise<SettleResult> {
    const quietMs = options.quietMs ?? this.#options.settle?.quietMs ?? DEFAULT_SETTLE.quietMs;
    const timeoutMs =
      options.timeoutMs ?? this.#options.settle?.timeoutMs ?? DEFAULT_SETTLE.timeoutMs;
    const started = Date.now();
    const deadline = started + timeoutMs;
    const waitedFor = { network: 0, dom: 0, busy: 0 };
    let timedOut = true;
    while (Date.now() < deadline && !this.#problem()) {
      const t0 = Date.now();
      const idle = (await this.#driver
        .call("idle", { quietMs, timeoutMs: Math.max(0, Math.min(deadline - t0, 3_000)) }, 5_000)
        .catch(() => ({ idle: false }))) as { idle?: boolean };
      if (!idle.idle) {
        waitedFor.dom += Date.now() - t0;
        continue;
      }
      const network = this.#emulator.guard.activity();
      // A response may take the app a moment to act on (start a screen, show a result):
      // after traffic, wait longer before calling the screen settled.
      const networkQuiet =
        network.lastActivityAt > started ? Math.max(quietMs, AFTER_NETWORK_QUIET_MS) : quietMs;
      if (
        network.inflight > 0 ||
        Date.now() - Math.max(network.lastActivityAt, started) < networkQuiet
      ) {
        await sleep(50);
        waitedFor.network += Date.now() - t0;
        continue;
      }
      const screen = await this.#screen();
      if (this.#logcat.launching() || screen?.busy()) {
        await sleep(100);
        waitedFor.busy += Date.now() - t0;
        continue;
      }
      // The log may lag the device: read it up to now before trusting "nothing is launching".
      const mark = this.#mark++;
      await runAdb(this.#emulator.sdk, this.#emulator.serial, { name: "logcat-mark", mark }, 5_000);
      await this.#logcat.waitForMark(mark);
      if (this.#logcat.launching()) {
        waitedFor.busy += Date.now() - t0;
        continue;
      }
      timedOut = false;
      break;
    }
    return {
      settledMs: Date.now() - started,
      timedOut,
      waitedFor,
      inflight: this.#emulator.guard.activity().inflight,
    };
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const forModel = options.forModel ?? false;
    const contentType = forModel ? "image/jpeg" : "image/png";
    const fail = (status: ScreenshotResult["status"], message: string): ScreenshotResult => ({
      status,
      bytes: new Uint8Array(),
      contentType,
      message,
    });
    if (this.#problem()) return fail("error", messageFor(this.#problem() as AppProblem));
    let crop: [number, number, number, number] | undefined;
    if (options.target) {
      const screen = await this.#screen();
      if (!screen) return fail("error", "The device is gone.");
      const found = this.#resolve(options.target, screen);
      if ("result" in found) return fail("not_found", found.result.message ?? "");
      crop = found.entry.node.bounds;
    }
    try {
      const shot = (await this.#driver.call(
        "screenshot",
        {
          format: forModel ? "jpeg" : "png",
          maxWidth: forModel ? MODEL_MAX_WIDTH : 0,
          ...(crop ? { crop } : {}),
        },
        20_000,
      )) as { data: string };
      return { status: "ok", bytes: new Uint8Array(Buffer.from(shot.data, "base64")), contentType };
    } catch (error) {
      return fail("error", error instanceof Error ? error.message : String(error));
    }
  }

  /** Evaluates one typed check (read-only; not an agent action). */
  check(op: CheckOp, options: AndroidCheckOptions = {}): Promise<CheckEvaluation> {
    return evaluateCheck(op, options, {
      screen: () => this.#screen(),
      redact: this.#redact,
      mark: () => this.#requests.length,
      requestsSince: (mark) => this.#requests.slice(mark).map((r) => r.summary),
      blank: () => this.#blank(),
    });
  }

  /** Where the current step began, for network checks. */
  requestMark(): AndroidRequestMark {
    return AndroidRequestMark.create(this.#requests.length);
  }

  /** A frozen copy of the current screen, for checks that must not see later changes. */
  async screenCopy(): Promise<ScreenCopy> {
    const screen = (await this.#screen()) ?? this.#blank();
    return ScreenCopy.create(screen, this.#requests.length, this.#redact(screen.url));
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  /** Ends the session (and the emulator, if the session booted it). Returns the scrubbed evidence. Safe to call twice. */
  async close(): Promise<AndroidCloseResult> {
    if (this.#closed) return this.#closed;
    const evidence: AndroidEvidenceFile[] = [];
    const { sdk, serial } = this.#emulator;
    const wanted = this.#options.evidence ?? {};
    if (this.#video && this.#emulator.running) {
      await runAdb(sdk, serial, { name: "emu", command: { name: "screenrecord-stop" } }, 15_000);
      if (await fileSettles(this.#video)) {
        evidence.push({
          kind: "video",
          file: "video",
          path: this.#video,
          contentType: "video/webm",
          scrubbed: true,
        });
      }
    }
    await this.#driver.quit();
    this.#instrument.kill();
    await runAdb(sdk, serial, { name: "forward-remove", port: this.#forwardPort }, 5_000);
    this.#logcatProcess.kill();
    if (wanted.logcat) {
      const path = join(this.#evidenceDir, "logcat.txt");
      writeFileSync(path, this.#logcat.text());
      evidence.push({
        kind: "logcat",
        file: "logcat",
        path,
        contentType: "text/plain",
        scrubbed: true,
      });
    }
    if (wanted.network) {
      const path = join(this.#evidenceDir, "network.har");
      writeFileSync(
        path,
        JSON.stringify(har(this.#requests, this.#refusals, this.#redact), null, 1),
      );
      evidence.push({
        kind: "network",
        file: "network",
        path,
        contentType: "application/json",
        scrubbed: true,
      });
    }
    this.#emulator.guard.setPolicy(null);
    if (this.#ownsEmulator) await this.#emulator.close();
    else this.#emulator.release();
    this.#closed = { evidence, refused: [...this.#refusals] };
    return this.#closed;
  }
}

function messageFor(problem: AppProblem): string {
  switch (problem) {
    case "emulator_crashed":
      return "The emulator stopped.";
    case "driver_lost":
      return "The connection to the on-device driver was lost.";
    case "app_crashed":
      return "The app crashed.";
    case "app_not_responding":
      return "The app stopped responding.";
    case "screen_changed":
      return "The screen changed.";
  }
}

interface OpenWindow {
  key: string;
  type: string;
  title: string;
  package: string;
}

/** Windows above the app's own: dialogs, the permission prompt, system dialogs. */
function dialogWindows(screen: Screen): OpenWindow[] {
  return screen.frames
    .filter((w) => screen.isDialog(w))
    .map((w) => {
      const pkg = w.package ?? "";
      const type =
        pkg === screen.appPackage
          ? "dialog"
          : PERMISSION_PACKAGES.test(pkg)
            ? "permission"
            : "system";
      let title = w.title ?? "";
      if (!title) {
        const text = screen.nodes.find(
          (n) => n && n.node.window === w.id && (n.role === "heading" || n.role === "text"),
        );
        title = text?.name || text?.text || "";
      }
      return { key: `${pkg}|${w.title ?? ""}|${w.bounds.join(",")}`, type, title, package: pkg };
    });
}

function mainArea(screen: Screen): [number, number, number, number] {
  const window = [...screen.frames].reverse().find((w) => w.type === "application");
  return window?.bounds ?? [0, 0, 1080, 1920];
}

function mainScroller(screen: Screen): ScreenNode | undefined {
  let best: ScreenNode | undefined;
  let area = 0;
  for (const entry of screen.shown()) {
    if (!entry.visible || !entry.node.flags.includes("scrollable") || !screen.touchable(entry))
      continue;
    const [l, t, r, b] = entry.node.bounds;
    const size = (r - l) * (b - t);
    if (entry.frame > (best?.frame ?? -1) || (entry.frame === best?.frame && size > area)) {
      best = entry;
      area = size;
    }
  }
  return best;
}

async function fileSettles(path: string): Promise<boolean> {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const size = existsSync(path) ? statSync(path).size : -1;
    if (size > 0 && size === last) return true;
    last = size;
    await sleep(250);
  }
  return existsSync(path) && statSync(path).size > 0;
}

function har(
  requests: readonly LoggedRequest[],
  refusals: readonly AndroidRefusal[],
  redact: (t: string) => string,
) {
  const entry = (at: string, method: string, url: string, status: number, type: string) => ({
    startedDateTime: at,
    time: 0,
    request: {
      method,
      url: redact(url),
      httpVersion: "HTTP/1.1",
      headers: [],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: [],
      cookies: [],
      content: { size: 0, mimeType: "" },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    _resourceType: type,
  });
  return {
    log: {
      version: "1.2",
      creator: { name: "android-harness", version: "1" },
      entries: [
        ...requests.map((r) =>
          entry(
            r.at,
            r.summary.method,
            r.summary.url,
            typeof r.summary.status === "number" ? r.summary.status : 0,
            r.summary.resourceType,
          ),
        ),
        ...refusals.map((r) => entry(r.at, "CONNECT", r.url, 0, `refused:${r.type}`)),
      ].sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime)),
    },
  };
}

// ── Opening a session ────────────────────────────────────────────────────────

/**
 * Waits (up to a minute) until the system is idle on the home screen: the UI
 * quiet for a second, content on screen, no system dialog left. Returns anyway
 * when time is up; the app launch then shows what's wrong.
 */
async function waitForIdleSystem(driver: DriverClient, guard: SystemDialogGuard): Promise<void> {
  await driver.call("global", { action: "home" }).catch(() => {});
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const screen = await guard.clear();
    const idle = (await driver
      .call("idle", { quietMs: 1_000, timeoutMs: 5_000 }, 10_000)
      .catch(() => ({ idle: false }))) as { idle?: boolean };
    if (screen && idle.idle && !screen.busy() && findSystemDialogs(screen, null).length === 0)
      return;
    await sleep(500);
  }
}

const failure = (reason: OpenFailureReason, message: string): OpenSessionResult => ({
  ok: false,
  reason,
  message,
});

/** Third-party packages and their uids. */
async function listPackages(emulator: LaunchedEmulator): Promise<Map<string, number | null>> {
  const result = await runAdb(emulator.sdk, emulator.serial, { name: "list-packages" }, 20_000);
  const packages = new Map<string, number | null>();
  for (const line of result.stdout.split("\n")) {
    const match = /^package:(\S+)(?:\s+uid:(\d+))?/.exec(line.trim());
    if (match?.[1] && PACKAGE_NAME.test(match[1]))
      packages.set(match[1], match[2] ? Number(match[2]) : null);
  }
  return packages;
}

/**
 * Opens a session for one test: restores the emulator's clean snapshot, puts the
 * network guard and firewall in place, installs the APK fresh, starts the driver
 * and launches the app. App or device trouble comes back as `{ ok: false }`;
 * only setup problems (no SDK, no system image, bad options) throw
 * AndroidSetupError.
 */
export async function openAndroidSession(
  options: AndroidSessionOptions,
): Promise<OpenSessionResult> {
  const opened = Date.now();
  const allowlist = new Allowlist(options.allowedDomains);
  if (allowlist.invalid.length > 0) {
    throw new AndroidSetupError(
      `Invalid allowed domain: ${allowlist.invalid.join(", ")}.`,
      "Use host names like example.com, *.example.com or 10.0.2.2:4180.",
    );
  }
  const apk = isAbsolute(options.apk) ? options.apk : resolve(options.apk);
  if (!existsSync(apk)) return failure("app_install_failed", `The APK ${apk} does not exist.`);

  let emulator = options.emulator;
  let bootMs: number | undefined;
  const ownsEmulator = !emulator;
  if (!emulator) {
    emulator = await launchEmulator({
      ...(options.androidVersion ? { androidVersion: options.androidVersion } : {}),
      ...(options.device ? { device: options.device } : {}),
      headless: options.headless ?? true,
    });
    bootMs = emulator.timings.bootMs;
  }
  if (!emulator.running) return failure("emulator_failed", "The emulator is not running.");
  if (!emulator.claim())
    throw new AndroidSetupError(
      "The emulator is already in use by another session.",
      "Use one emulator per worker.",
    );
  const { sdk, serial } = emulator;
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  const abort = async (reason: OpenFailureReason, message: string): Promise<OpenSessionResult> => {
    for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => {});
    emulator.guard.setPolicy(null);
    if (ownsEmulator) await emulator.close();
    else emulator.release();
    return failure(reason, message);
  };

  // 1. A clean device: a used emulator reboots from its clean snapshot (no app, no data, no leftovers).
  const resetStarted = Date.now();
  emulator.guard.setPolicy(null);
  const reset = await emulator.reset();
  if (reset) return abort("emulator_failed", `Restoring the clean snapshot failed: ${reset}`);
  if (!(await ensureRoot(sdk, serial)))
    return abort("emulator_failed", "adb is not running as root after the reset.");
  // Animations off and the other calm settings, again: a snapshot made on another
  // machine (or an older driver) may not have them.
  await runAdb(sdk, serial, { name: "prepare-device" }, 30_000);
  const resetMs = Date.now() - resetStarted;

  // 2. The session's scrubbing: every secret is known before anything is read from the device.
  const own = new Redactor();
  for (const secret of Object.values(options.secrets ?? {}))
    own.register(revealSecret(secret), secret.label);
  const outer = options.redact ?? ((text: string) => defaultRedactor.redact(text));
  const redact = (text: string) => outer(own.redact(text));
  const requests: LoggedRequest[] = [];
  const refusals: AndroidRefusal[] = [];

  // 3. The device log (crash detection; evidence when asked).
  const evidenceDir = options.evidence?.dir ?? mkdtempSync(join(tmpdir(), "android-evidence-"));
  await runAdb(sdk, serial, { name: "logcat-clear" }, 10_000);
  const logcat = new Logcat(redact);
  const logcatProcess = startAdb(sdk, serial, { name: "logcat" });
  logcatProcess.child.stdout?.setEncoding("utf8").on("data", (chunk: string) => logcat.feed(chunk));
  cleanups.push(() => logcatProcess.kill());

  // 4. A fresh install of the app under test.
  const installStarted = Date.now();
  const beforePackages = await listPackages(emulator);
  // A link that drops mid-transfer hangs adb: a minute per try, retried (see runAdb).
  const install = await runAdb(sdk, serial, { name: "install", apk }, 60_000);
  if (!/\bSuccess\b/.test(install.stdout)) {
    const reason =
      /INSTALL_[A-Z_]+/.exec(`${install.stdout}${install.stderr}`)?.[0] ??
      install.stderr.trim().split("\n").pop() ??
      "unknown error";
    return abort("app_install_failed", `The APK did not install: ${reason}`);
  }
  const added = [...(await listPackages(emulator))].filter(([pkg]) => !beforePackages.has(pkg));
  if (added.length !== 1)
    return abort("app_install_failed", "Could not tell which package the APK installed.");
  const [appPackage, appUid] = added[0] as [string, number | null];
  if (appUid === null)
    return abort("app_install_failed", `Could not read the uid of ${appPackage}.`);

  // The device firewall (non-TCP traffic), before the app first runs.
  const rules = [...resetRules(), ...firewallRules(appUid)];
  await runAdb(sdk, serial, { name: "firewall", rules }, 20_000);
  const verify = await runAdb(sdk, serial, { name: "firewall", rules: COUNTERS_COMMAND }, 10_000);
  if (!/-j REJECT/.test(verify.stdout))
    return abort("emulator_failed", "The device firewall could not be set up.");
  const counters = parseCounters(verify.stdout);
  // The network guard's policy: from here on the app reaches only the allowed hosts.
  // (Until now the guard refused everything, silently.)
  emulator.guard.setPolicy({
    allowlist,
    onRefused: (refusal) => refusals.push({ ...refusal, url: redact(refusal.url) }),
    onRequest: (request) =>
      requests.push({
        summary: { ...request, url: redact(request.url) },
        at: new Date().toISOString(),
      }),
  });
  const installMs = Date.now() - installStarted;

  // 5. The driver.
  const driverStarted = Date.now();
  let driverRestarts = 0;
  const socket = `uih-${randomBytes(6).toString("hex")}`;
  const token = randomBytes(24).toString("hex");
  // The instrumentation's own output says why it didn't start (kept for the message).
  let instrumentOutput = "";
  let instrument: Running | null = null;
  let forwardPort = 0;
  cleanups.push(() => instrument?.kill());
  cleanups.push(() =>
    forwardPort ? runAdb(sdk, serial, { name: "forward-remove", port: forwardPort }, 5_000) : null,
  );
  let connected: { client: DriverClient; hello: Hello } | null = null;
  let attempts = 0;
  // Each attempt starts from the device being there: adb's link to a busy emulator
  // can drop for a moment ("device offline"), and a dropped link loses its forwards.
  while (!connected && attempts < 3) {
    attempts++;
    await runAdb(sdk, serial, { name: "wait-for-device" }, 30_000).catch(() => null);
    if (forwardPort) {
      await runAdb(sdk, serial, { name: "forward-remove", port: forwardPort }, 5_000).catch(
        () => null,
      );
    }
    const forward = await runAdb(sdk, serial, { name: "forward", socket }, 10_000).catch(
      () => null,
    );
    forwardPort = Number(forward?.stdout.trim());
    if (!Number.isInteger(forwardPort) || forwardPort <= 0) {
      forwardPort = 0;
      instrumentOutput += `\nadb could not forward to the driver: ${forward?.stderr.trim() ?? ""}`;
      continue;
    }
    instrument?.kill();
    const running = startAdb(sdk, serial, { name: "instrument", token, socket });
    instrument = running;
    let exited = false;
    void running.exited.then(() => {
      exited = true;
    });
    const keep = (chunk: Buffer) => {
      instrumentOutput = (instrumentOutput + chunk.toString("utf8")).slice(-2_000);
    };
    running.child.stdout?.on("data", keep);
    running.child.stderr?.on("data", keep);
    // Slow machines take a while to start the instrumentation.
    const deadline = Date.now() + 45_000;
    while (!connected && Date.now() < deadline) {
      await sleep(250);
      connected = await DriverClient.connect(forwardPort, token, 5_000).catch(() => null);
      if (!connected && exited) break;
    }
  }
  if (!connected || !instrument) {
    const said = redact(instrumentOutput.replaceAll(token, "[token]")).trim();
    return abort(
      "driver_failed",
      `The on-device driver did not start (${attempts} attempt(s))${said ? `: ${said.slice(-500)}` : "."}`,
    );
  }
  driverRestarts = attempts - 1;
  const driver = connected.client;
  cleanups.push(() => driver.quit());
  const driverMs = Date.now() - driverStarted;

  // 6. Evidence: the screen recording runs on the host.
  let video: string | null = null;
  const notes: string[] = [];
  if (options.evidence?.video) {
    video = join(evidenceDir, "video.webm");
    // The emulator console splits on spaces, so a path with one (a Windows or macOS
    // user folder like "Jane Doe") can't be recorded to: no video, said so, no throw.
    const started = await runAdb(
      sdk,
      serial,
      { name: "emu", command: { name: "screenrecord-start", path: video } },
      15_000,
    ).catch((error: unknown) => ({ stdout: "", stderr: String(error) }));
    if (!/OK/.test(started.stdout)) {
      notes.push(
        /\s/.test(video)
          ? `No screen recording: the evidence folder's path has a space (${redact(evidenceDir)}); pass evidence.dir without one.`
          : "No screen recording: the emulator did not start recording.",
      );
      video = null;
    }
  }

  // 7. A calm, idle system first: the launcher up, and any system dialog about
  // another package (System UI or the launcher not responding, on a slow
  // machine) dismissed and recorded.
  const readyStarted = Date.now();
  const label = (await driver.call("label", { package: appPackage }).catch(() => ({}))) as {
    label?: string;
  };
  const systemDialogs: DismissedDialog[] = [];
  const guard = new SystemDialogGuard({
    driver,
    appPackage,
    appLabel: label.label ?? null,
    record: systemDialogs,
    redact,
  });
  await waitForIdleSystem(driver, guard);
  const readyMs = Date.now() - readyStarted;

  // 8. Launch the app.
  const launchStarted = Date.now();
  const launched = (await driver
    .call("launch", { package: appPackage }, 60_000)
    .catch(() => ({}))) as {
    started?: boolean;
  };
  if (!launched.started) return abort("app_launch_failed", `${appPackage} has no launcher screen.`);
  const timings: SessionTimings = {
    resetMs,
    installMs,
    driverMs,
    driverRestarts,
    readyMs,
    launchMs: 0,
    totalMs: 0,
    systemDialogs,
    notes,
    ...(bootMs !== undefined ? { bootMs } : {}),
  };
  const session = new AndroidSession({
    emulator,
    ownsEmulator,
    options,
    allowlist,
    redact,
    secretRedactor: own,
    appPackage,
    driver,
    instrument,
    forwardPort,
    logcat,
    logcatProcess,
    hello: connected.hello,
    evidenceDir,
    video,
    requests,
    refusals,
    counters,
    timings,
    systemDialogs: guard,
  });
  await session.settle({ timeoutMs: 30_000 });
  await guard.clear();
  const state = (await driver.call("app_state", { package: appPackage }).catch(() => ({}))) as {
    running?: boolean;
  };
  if (!state.running || logcat.eventsSince(0, appPackage).some((e) => e.kind === "crashed")) {
    await session.close();
    return failure(
      "app_launch_failed",
      `${appPackage} did not start (it crashed or exited at launch).`,
    );
  }
  timings.launchMs = Date.now() - launchStarted;
  timings.totalMs = Date.now() - opened;
  return { ok: true, session };
}
