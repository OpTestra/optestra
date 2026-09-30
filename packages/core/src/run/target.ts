import { rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { LaunchedEmulator } from "@testament/android";
import type { BrowserName, LaunchedBrowser, Session } from "@testament/browser";
import type { Config, EnvironmentSettings, ProtectedHeaderSpec } from "@testament/config";
import type { SecretValue } from "@testament/config/node";
import type { ArtifactKind, AttemptFile, BlockedReason, MatrixEntry } from "@testament/contract";
import type { HarnessSession, TargetName } from "../target/harness.js";

// The runner's target layer (MOB-1): what a run needs from its target, behind one
// interface. A run tests a matrix of cells (TGT-5): web = browser × device,
// Android = Android version × device. A worker launches an engine per kind of
// cell it meets (a browser per browser name, an emulator per version and device)
// and keeps it; each test attempt gets a fresh session on it (a new browser
// context, or the clean snapshot with the APK installed fresh). Everything after
// that talks to a HarnessSession.

/** One entry of the run's matrix. */
export type TargetCell =
  | { target: "web"; browser: BrowserName; device: string }
  | { target: "android"; androidVersion: string; device: string };

/** The target a run tests, resolved from the project, its environment and the run options. */
export type RunTarget =
  | { name: "web"; baseUrl: string; cells: TargetCell[] }
  | {
      name: "android";
      /** The APK, absolute. */
      apk: string;
      baseUrl: string | undefined;
      cells: TargetCell[];
    };

export interface TargetRunOptions {
  browser?: BrowserName;
  /** A web device preset, or an Android device profile (by target). */
  device?: string;
  androidVersion?: string;
  /** Matrix: every combination runs (override the single values above). */
  browsers?: readonly BrowserName[];
  devices?: readonly string[];
  androidVersions?: readonly string[];
}

/** The contract's matrix entry for a cell. */
export function matrixOf(cell: TargetCell): MatrixEntry {
  return cell.target === "web"
    ? { target: "web", browser: cell.browser, device: cell.device }
    : { target: "android", androidVersion: cell.androidVersion, device: cell.device };
}

/** A cell's name in a result id (`<test>@<label>`): chromium-desktop, android16-pixel-8. */
export function cellLabel(cell: TargetCell): string {
  return cell.target === "web"
    ? `${cell.browser}-${cell.device}`
    : `android${cell.androidVersion}-${cell.device}`;
}

/** Cells sharing an engine (one browser per name, one emulator per version and device). */
export function engineKey(cell: TargetCell): string {
  return cell.target === "web" ? cell.browser : `android${cell.androidVersion}-${cell.device}`;
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** The run's target and matrix, or why it can't run (a config error). */
export async function resolveTarget(
  projectDir: string,
  config: Config,
  environment: { name: string; settings: EnvironmentSettings },
  options: TargetRunOptions,
): Promise<{ ok: true; target: RunTarget } | { ok: false; message: string }> {
  const { settings } = environment;
  const devices = options.devices?.length
    ? unique(options.devices)
    : options.device
      ? [options.device]
      : undefined;
  if ((config.project?.target ?? "web") !== "android") {
    if (!settings.baseUrl)
      return {
        ok: false,
        message: `The environment "${environment.name}" has no baseUrl. Choose one with --env, or set baseUrl.`,
      };
    const browserModule = await import("@testament/browser");
    const browsers: BrowserName[] = options.browsers?.length
      ? unique(options.browsers)
      : [options.browser ?? "chromium"];
    const webDevices = devices ?? [browserModule.DEFAULT_DEVICE];
    const unknown = webDevices.filter((d) => !(d in browserModule.DEVICE_PRESETS));
    if (unknown.length > 0)
      return {
        ok: false,
        message: `Unknown device ${unknown.join(", ")}. Choose one of: ${Object.keys(browserModule.DEVICE_PRESETS).join(", ")}.`,
      };
    return {
      ok: true,
      target: {
        name: "web",
        baseUrl: settings.baseUrl,
        cells: browsers.flatMap((browser) =>
          webDevices.map((device) => ({ target: "web" as const, browser, device })),
        ),
      },
    };
  }
  const android = await import("@testament/android");
  if (!settings.app)
    return {
      ok: false,
      message: `The environment "${environment.name}" has no app. Set app: to the APK to test.`,
    };
  // An environment may override the android section (version, device); run options override both.
  const override = (settings as { android?: { version?: string; device?: string } }).android;
  const section = (config as { android?: { version?: string; device?: string } }).android;
  const versions = options.androidVersions?.length
    ? unique(options.androidVersions)
    : [
        options.androidVersion ??
          override?.version ??
          section?.version ??
          android.DEFAULT_ANDROID_VERSION,
      ];
  const profiles = devices ?? [
    override?.device ?? section?.device ?? android.DEFAULT_DEVICE_PROFILE,
  ];
  const badVersion = versions.find((v) => !(v in android.ANDROID_VERSIONS));
  if (badVersion)
    return {
      ok: false,
      message: `Android ${badVersion} is not supported. Use one of ${Object.keys(android.ANDROID_VERSIONS).join(", ")}.`,
    };
  const badDevice = profiles.find((d) => !(d in android.DEVICE_PROFILES));
  if (badDevice)
    return {
      ok: false,
      message: `"${badDevice}" is not an Android device profile. Use one of ${Object.keys(android.DEVICE_PROFILES).join(", ")}.`,
    };
  return {
    ok: true,
    target: {
      name: "android",
      apk: isAbsolute(settings.app) ? settings.app : resolve(projectDir, settings.app),
      baseUrl: settings.baseUrl,
      cells: versions.flatMap((androidVersion) =>
        profiles.map((device) => ({ target: "android" as const, androidVersion, device })),
      ),
    },
  };
}

/** One evidence file of an attempt, scrubbed. */
export interface AttemptEvidence {
  kind: ArtifactKind;
  file: AttemptFile;
  path: string;
  contentType: string;
}

/** Evidence a clean first attempt may drop (evidence mode `failures`). */
export type DiscardableEvidence = "trace" | "network";

/** A test attempt's session: the harness, and closing it (its evidence). */
export type AttemptSession = HarnessSession & {
  close(options?: {
    discard?: readonly DiscardableEvidence[];
  }): Promise<{ evidence: readonly AttemptEvidence[] }>;
};

export interface AttemptSessionOptions {
  allowedDomains: readonly string[];
  secrets: Readonly<Record<string, SecretValue>>;
  protectedHeaders?: readonly ProtectedHeaderSpec[];
  /** Web: files the test may upload come from here. */
  uploadDir: string;
  evidenceDir: string;
  video: boolean;
  /** Evidence mode (PERF-0): the web trace and the network log (HAR) of either target. */
  capture?: { trace: boolean; network: boolean };
  /** ENV-5: the browser's, or the device's, locale and timezone. */
  locale?: string;
  timezone?: string;
  /** Web (TGT-3): a custom size instead of the device preset's. */
  viewport?: { width: number; height: number };
  /** Default: the harness's own (the config's default redactor). */
  redact?: (text: string) => string;
}

export type OpenedAttempt =
  | {
      ok: true;
      session: AttemptSession;
      /** The web Session itself (auth profiles need its storage state). */
      web?: Session;
    }
  | { ok: false; reason: BlockedReason; message: string };

/** A worker's engine for one kind of cell: a browser, or an emulator. */
export interface TargetWorker {
  readonly target: TargetName;
  openAttempt(options: AttemptSessionOptions): Promise<OpenedAttempt>;
  /** Web: a login session for an auth profile's flow (no trace, video or HAR). */
  openLoginSession?(
    options: Pick<
      AttemptSessionOptions,
      "allowedDomains" | "secrets" | "locale" | "timezone" | "viewport" | "redact"
    >,
  ): Promise<Session>;
  close(): Promise<void>;
}

export class TargetLaunchError extends Error {
  constructor(
    message: string,
    readonly reason: BlockedReason,
  ) {
    super(message);
    this.name = "TargetLaunchError";
  }
}

/**
 * Launches the browser or emulator for a cell. Throws TargetLaunchError. A shared
 * emulator (tests, Bench) is used as it is and left running.
 */
export async function launchWorker(
  target: RunTarget,
  cell: TargetCell,
  options: { headless: boolean; emulator?: LaunchedEmulator },
): Promise<TargetWorker> {
  if (target.name === "web" && cell.target === "web") {
    const browserModule = await import("@testament/browser");
    let launched: LaunchedBrowser;
    try {
      launched = await browserModule.launchBrowser({
        browser: cell.browser,
        headless: options.headless,
      });
    } catch (error) {
      const fix = error instanceof browserModule.BrowserSetupError ? ` Fix: ${error.fix}` : "";
      throw new TargetLaunchError(
        `The browser could not start: ${error instanceof Error ? error.message : String(error)}${fix}`,
        "config_error",
      );
    }
    const place = (o: {
      locale?: string;
      timezone?: string;
      viewport?: { width: number; height: number };
    }) => ({
      ...(o.locale ? { locale: o.locale } : {}),
      ...(o.timezone ? { timezone: o.timezone } : {}),
      ...(o.viewport ? { viewport: o.viewport } : {}),
    });
    return {
      target: "web",
      openAttempt: async (o) => {
        try {
          const session = await browserModule.openSession({
            browser: launched,
            device: cell.device,
            baseUrl: target.baseUrl,
            allowedDomains: o.allowedDomains,
            secrets: o.secrets,
            ...(o.protectedHeaders && o.protectedHeaders.length > 0
              ? { protectedHeaders: o.protectedHeaders }
              : {}),
            allowUpload: { dir: o.uploadDir },
            ...place(o),
            evidence: {
              trace: o.capture?.trace ?? true,
              console: true,
              network: o.capture?.network ?? true,
              video: o.video,
              dir: o.evidenceDir,
            },
            ...(o.redact ? { redact: o.redact } : {}),
          });
          return { ok: true, session, web: session };
        } catch (error) {
          return {
            ok: false,
            reason: "config_error",
            message: `The browser could not start: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
      openLoginSession: (o) =>
        browserModule.openSession({
          browser: launched,
          device: cell.device,
          baseUrl: target.baseUrl,
          allowedDomains: o.allowedDomains,
          secrets: o.secrets,
          ...place(o),
          evidence: { trace: false, console: false, network: false, video: false },
          ...(o.redact ? { redact: o.redact } : {}),
        }),
      close: () => launched.close(),
    };
  }
  if (target.name !== "android" || cell.target !== "android")
    throw new TargetLaunchError(
      `A ${cell.target} cell can't run in a ${target.name} project.`,
      "config_error",
    );

  const android = await import("@testament/android");
  let emulator = options.emulator;
  const owns = !emulator;
  if (!emulator) {
    try {
      emulator = await android.launchEmulator({
        androidVersion: cell.androidVersion,
        device: cell.device,
        headless: options.headless,
      });
    } catch (error) {
      const setup = error instanceof android.AndroidSetupError;
      throw new TargetLaunchError(
        `The emulator could not start: ${error instanceof Error ? error.message : String(error)}${setup ? ` Fix: ${error.fix}` : ""}`,
        setup ? "config_error" : "emulator_failed",
      );
    }
  }
  const shared = emulator;
  return {
    target: "android",
    openAttempt: async (o) => {
      try {
        const opened = await android.openAndroidSession({
          apk: target.apk,
          emulator: shared,
          allowedDomains: o.allowedDomains,
          ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
          secrets: o.secrets,
          ...(o.locale ? { locale: o.locale } : {}),
          ...(o.timezone ? { timezone: o.timezone } : {}),
          evidence: {
            video: o.video,
            logcat: true,
            network: o.capture?.network ?? true,
            dir: o.evidenceDir,
          },
          ...(o.redact ? { redact: o.redact } : {}),
        });
        if (!opened.ok) return { ok: false, reason: opened.reason, message: opened.message };
        const session = opened.session;
        // The harness has no trace; a discarded network log is dropped here.
        const close: AttemptSession["close"] = async (options = {}) => {
          const closed = await session.close();
          const discard = new Set<string>(options.discard ?? []);
          for (const file of closed.evidence)
            if (discard.has(file.kind)) rmSync(file.path, { force: true });
          return { evidence: closed.evidence.filter((file) => !discard.has(file.kind)) };
        };
        // The session itself, with that close (its methods bound: it keeps private state).
        const wrapped = new Proxy(session, {
          get(t, key) {
            if (key === "close") return close;
            const value = Reflect.get(t, key, t) as unknown;
            return typeof value === "function" ? value.bind(t) : value;
          },
        }) as unknown as AttemptSession;
        return { ok: true, session: wrapped };
      } catch (error) {
        const setup = error instanceof android.AndroidSetupError;
        return {
          ok: false,
          reason: setup ? "config_error" : "emulator_failed",
          message: `The app session could not start: ${error instanceof Error ? error.message : String(error)}${setup ? ` Fix: ${error.fix}` : ""}`,
        };
      }
    },
    close: async () => {
      if (owns) await shared.close();
    },
  };
}
