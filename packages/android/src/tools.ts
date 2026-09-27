import { type ChildProcess, spawn } from "node:child_process";
import type { Sdk } from "./sdk.js";

// The one place the Android harness starts programs (guarantee 5, SAF-2): adb with
// a closed list of commands, the emulator, and sdkmanager for `android setup
// --install`. Every argument is built here from validated values; nothing a test,
// a model or an app wrote is ever passed through, and no shell runs on the host.
// `adb shell` joins its arguments into one device command line, so every token
// sent there must match SAFE_TOKEN (no spaces, quotes or shell characters).

/** Every adb command the harness can run. The guard test pins this list. */
export const ADB_COMMANDS = [
  "devices",
  "wait-for-device",
  "getprop",
  "root",
  "whoami",
  "install",
  "list-packages",
  "forward",
  "forward-remove",
  "instrument",
  "logcat",
  "logcat-clear",
  "logcat-mark",
  "prepare-device",
  "firewall",
  "emu",
] as const;

export type AdbCommandName = (typeof ADB_COMMANDS)[number];

const PROPS = [
  "sys.boot_completed",
  "init.svc.bootanim",
  "ro.build.version.release",
  "ro.build.version.sdk",
] as const;

export type EmuCommand =
  | { name: "snapshot-save"; snapshot: string }
  | { name: "screenrecord-start"; path: string }
  | { name: "screenrecord-stop" }
  | { name: "kill" };

export type AdbCommand =
  | { name: "devices" }
  | { name: "wait-for-device" }
  | { name: "getprop"; key: (typeof PROPS)[number] }
  | { name: "root" }
  | { name: "whoami" }
  | { name: "install"; apk: string }
  | { name: "list-packages" }
  | { name: "forward"; socket: string }
  | { name: "forward-remove"; port: number }
  | { name: "instrument"; token: string; socket: string }
  | { name: "logcat" }
  | { name: "logcat-clear" }
  | { name: "logcat-mark"; mark: number }
  | { name: "prepare-device" }
  | { name: "firewall"; rules: readonly (readonly string[])[] }
  | { name: "emu"; command: EmuCommand };

/** Tokens that may go into a device command line. */
export const SAFE_TOKEN = /^[A-Za-z0-9_.:/,=+-]+$/;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const HEX = /^[0-9a-f]{16,64}$/;
export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const DRIVER = "dev.uiharness.driver/.Driver";

/**
 * Device settings for a calm, deterministic screen, applied once before the
 * clean snapshot is saved: no animations, no password echo, no private DNS
 * (its DNS-over-TLS would be refused), no captive-portal probes, stay awake.
 */
export const DEVICE_SETTINGS: readonly (readonly [string, string, string])[] = [
  ["global", "window_animation_scale", "0"],
  ["global", "transition_animation_scale", "0"],
  ["global", "animator_duration_scale", "0"],
  ["system", "show_password", "0"],
  ["global", "private_dns_mode", "off"],
  ["global", "captive_portal_mode", "0"],
  ["global", "captive_portal_detection_enabled", "0"],
  ["global", "stay_on_while_plugged_in", "7"],
  ["secure", "show_ime_with_hard_keyboard", "0"],
  ["global", "package_verifier_user_consent", "-1"],
];

/** On-screen keyboards of the supported system images, disabled before the clean snapshot. */
export const ON_SCREEN_KEYBOARDS: readonly string[] = [
  "com.android.inputmethod.latin/.LatinIME",
  "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME",
];

export class InvalidToolCommand extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidToolCommand";
  }
}

function check(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value))
    throw new InvalidToolCommand(`invalid ${what}: ${JSON.stringify(value)}`);
  return value;
}

/** The adb argv for a command (after `-s <serial>`). Throws for invalid values. */
export function adbArgs(command: AdbCommand): string[] {
  switch (command.name) {
    case "devices":
      return ["devices"];
    case "wait-for-device":
      return ["wait-for-device"];
    case "getprop":
      if (!PROPS.includes(command.key)) throw new InvalidToolCommand("unknown property");
      return ["shell", "getprop", command.key];
    case "root":
      return ["root"];
    case "whoami":
      return ["shell", "id", "-u"];
    case "install":
      // -r replace, -t allow test APKs. Never -g: permission dialogs stay real.
      if (command.apk.startsWith("-")) throw new InvalidToolCommand("invalid apk path");
      return ["install", "-r", "-t", command.apk];
    case "list-packages":
      return ["shell", "pm", "list", "packages", "-3", "-U"];
    case "forward":
      return ["forward", "tcp:0", `localabstract:${check(command.socket, NAME, "socket")}`];
    case "forward-remove":
      if (!Number.isInteger(command.port) || command.port < 1 || command.port > 65535) {
        throw new InvalidToolCommand("invalid port");
      }
      return ["forward", "--remove", `tcp:${command.port}`];
    case "instrument":
      return [
        "shell",
        "am",
        "instrument",
        "-w",
        "-e",
        "token",
        check(command.token, HEX, "token"),
        "-e",
        "socket",
        check(command.socket, NAME, "socket"),
        DRIVER,
      ];
    case "logcat":
      return ["logcat", "-v", "threadtime", "-b", "main,system,crash,kernel"];
    case "logcat-clear":
      return ["logcat", "-c", "-b", "main,system,crash,kernel"];
    case "logcat-mark":
      // A line the log reader waits for: everything logged before it has then been read.
      if (!Number.isInteger(command.mark) || command.mark < 0)
        throw new InvalidToolCommand("invalid mark");
      return ["shell", "log", "-t", "uih", `mark-${command.mark}`];
    case "prepare-device":
      return [
        "shell",
        [
          ...DEVICE_SETTINGS.map(([ns, key, value]) => `settings put ${ns} ${key} ${value}`),
          // No on-screen keyboard: text is set through accessibility, and a keyboard would cover the app.
          ...ON_SCREEN_KEYBOARDS.map((ime) => `ime disable ${ime}`),
        ].join(" ; "),
      ];
    case "firewall": {
      const lines = command.rules.map((rule) => {
        if (rule[0] !== "iptables" && rule[0] !== "ip6tables") {
          throw new InvalidToolCommand("firewall rules run iptables or ip6tables only");
        }
        return rule.map((token) => check(token, SAFE_TOKEN, "firewall token")).join(" ");
      });
      return ["shell", lines.join(" ; ")];
    }
    case "emu":
      return ["emu", ...emuArgs(command.command)];
    default:
      throw new InvalidToolCommand("unknown adb command");
  }
}

function emuArgs(command: EmuCommand): string[] {
  switch (command.name) {
    case "snapshot-save":
      return ["avd", "snapshot", "save", check(command.snapshot, NAME, "snapshot")];
    case "screenrecord-start":
      // The emulator writes the file on the host; the path is ours (evidence dir).
      if (/[\s;|&"'`$<>]/.test(command.path)) throw new InvalidToolCommand("invalid video path");
      return ["screenrecord", "start", "--time-limit", "1800", command.path];
    case "screenrecord-stop":
      return ["screenrecord", "stop"];
    case "kill":
      return ["kill"];
    default:
      throw new InvalidToolCommand("unknown emulator command");
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Running {
  readonly child: ChildProcess;
  /** Resolves with the exit code when the program ends. */
  readonly exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): void;
}

function launch(binary: string, args: readonly string[], env?: NodeJS.ProcessEnv): Running {
  const child = spawn(binary, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
  return {
    child,
    exited,
    kill: (signal = "SIGTERM") => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  };
}

async function collect(running: Running, timeoutMs: number): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  running.child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  running.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    running.kill("SIGKILL");
  }, timeoutMs);
  const code = await running.exited;
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

const serialArgs = (serial: string | null) =>
  serial ? ["-s", check(serial, /^[A-Za-z0-9._:-]+$/, "serial")] : [];

/**
 * Runs one adb command to completion. Never throws for a failing command; an
 * invalid one rejects (it is async, so the rejection can be caught).
 */
export async function runAdb(
  sdk: Sdk,
  serial: string | null,
  command: AdbCommand,
  timeoutMs = 30_000,
): Promise<RunResult> {
  const args = [...serialArgs(serial), ...adbArgs(command)];
  let result = await collect(launch(sdk.adb, args), timeoutMs);
  // adb's link to a busy emulator can drop for a moment: wait for the device and
  // run the command again, rather than report the app or the device as broken.
  for (let attempt = 1; attempt < 3 && serial && isTransient(result, command); attempt++) {
    await collect(launch(sdk.adb, [...serialArgs(serial), "wait-for-device"]), 30_000);
    result = await collect(launch(sdk.adb, args), timeoutMs);
  }
  return result;
}

const TRANSIENT =
  /device offline|device '[^']*' not found|no devices\/emulators found|error: closed|protocol fault/i;

/** A failure of adb's link to the device, not of the command. */
export function isTransient(result: RunResult, command: AdbCommand): boolean {
  if (command.name === "wait-for-device" || command.name === "devices") return false;
  const output = `${result.stderr}\n${result.stdout}`;
  if (command.name === "install") {
    // A real install failure always says why (INSTALL_FAILED_…, Failure [...]). One
    // that doesn't, or that hung (a link dropped mid-transfer hangs adb), is the link's.
    if (/\bSuccess\b/.test(result.stdout)) return false;
    return result.timedOut || (result.code !== 0 && !/INSTALL_[A-Z_]+|Failure \[/.test(output));
  }
  return result.code !== 0 && TRANSIENT.test(output);
}

/** Starts a long-running adb command (the driver, logcat). */
export function startAdb(sdk: Sdk, serial: string, command: AdbCommand): Running {
  return launch(sdk.adb, [...serialArgs(serial), ...adbArgs(command)]);
}

export interface EmulatorLaunch {
  avd: string;
  port: number;
  /** The network guard, `http://127.0.0.1:<port>`: every TCP connection of the device goes there. */
  proxy: string;
  headless: boolean;
  /** Boot from this snapshot (read-only, never saved) instead of cold booting. */
  snapshot?: string;
  /** Cold boot a writable instance (to prepare the clean snapshot). */
  prepare?: boolean;
}

/** The emulator argv for a launch. */
export function emulatorArgs(launch: EmulatorLaunch): string[] {
  if (
    !Number.isInteger(launch.port) ||
    launch.port < 5554 ||
    launch.port > 5682 ||
    launch.port % 2
  ) {
    throw new InvalidToolCommand("emulator port must be an even number from 5554 to 5682");
  }
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(launch.proxy)) {
    throw new InvalidToolCommand("the proxy must be the local network guard");
  }
  const args = [
    "-avd",
    check(launch.avd, NAME, "avd"),
    "-port",
    String(launch.port),
    "-http-proxy",
    launch.proxy,
    "-no-audio",
    "-no-boot-anim",
    "-no-metrics",
    "-camera-back",
    "none",
    "-camera-front",
    "none",
    "-gpu",
    "swiftshader_indirect",
  ];
  if (launch.headless) args.push("-no-window");
  if (launch.prepare) args.push("-no-snapshot-load", "-no-snapshot-save", "-wipe-data");
  else {
    args.push("-read-only", "-no-snapshot-save");
    if (launch.snapshot) args.push("-snapshot", check(launch.snapshot, NAME, "snapshot"));
  }
  return args;
}

export function startEmulator(
  sdk: Sdk,
  launchOptions: EmulatorLaunch,
  env: NodeJS.ProcessEnv,
): Running {
  return launch(sdk.emulator, emulatorArgs(launchOptions), env);
}

/** `emulator -accel-check` and `-version`, for doctor. */
export function runEmulatorInfo(sdk: Sdk, what: "accel-check" | "version"): Promise<RunResult> {
  return collect(launch(sdk.emulator, [what === "version" ? "-version" : "-accel-check"]), 30_000);
}

const SDK_PACKAGE = /^[a-z0-9-]+(;[a-z0-9._-]+)*$/i;

/** sdkmanager for `android setup --install` only, after the user saw what and how much. */
export function startSdkManager(sdk: Sdk, packages: readonly string[]): Running {
  if (!sdk.sdkmanager) throw new InvalidToolCommand("sdkmanager is not installed");
  if (process.platform === "win32")
    throw new InvalidToolCommand("run sdkmanager yourself on Windows");
  const args = [`--sdk_root=${sdk.root}`, ...packages.map((p) => check(p, SDK_PACKAGE, "package"))];
  return launch(sdk.sdkmanager, args);
}
