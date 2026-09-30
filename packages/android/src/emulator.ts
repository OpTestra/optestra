import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ENV_PREFIX } from "@testament/config";
import { NetworkGuard } from "./guard.js";
import {
  AndroidSetupError,
  androidVersion,
  avdHome,
  type DeviceProfile,
  deviceProfile,
  installedImage,
  requireDriverApk,
  requireSdk,
  type Sdk,
  type SystemImage,
} from "./sdk.js";
import { adbArgs, type Running, runAdb, startEmulator } from "./tools.js";

// Emulators the harness owns (MOB-2, SAF-7). Each version × device profile gets
// an AVD in the harness's own folder, written from the data files (no Java, no
// avdmanager). Once per AVD and driver build, a cold boot prepares a clean
// snapshot: calm settings, root adb (for the firewall), the driver installed, and
// nothing else. Every boot after that starts read-only from the snapshot and
// never saves anything. A used emulator is rebooted from the snapshot before the
// next session (a few seconds), so no run sees another's data or processes, and
// several read-only instances of one AVD can run side by side.

const BOOT_TIMEOUT_MS = 240_000;
const FIRST_PORT = 5580;
const LAST_PORT = 5680;

export interface EmulatorOptions {
  /** Android version from versions.json (default "16"). */
  androidVersion?: string;
  /** Device profile from devices.json (default "pixel-8"). */
  device?: string;
  /** Show the emulator window (default: headless). */
  headless?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Progress lines (preparing the snapshot takes a minute the first time). */
  onProgress?: (message: string) => void;
}

export interface EmulatorTimings {
  /** Cold boot while preparing the clean snapshot (only when it had to be made). */
  coldBootMs?: number;
  /** Boot from the clean snapshot until adb and the driver are ready. */
  bootMs: number;
}

const avdName = (version: string, profile: DeviceProfile, image: SystemImage, cores: number) =>
  `h-${version}-${profile.name}-${image.tag}${cores === DEFAULT_CORES ? "" : `-${cores}core`}`.replace(
    /[^A-Za-z0-9_-]/g,
    "-",
  );

const DEFAULT_CORES = 2;

/**
 * Virtual CPUs of the harness's AVDs (default 2). `<ENV_PREFIX>ANDROID_CORES=1`
 * makes a slow device on a fast machine, to reproduce what slow CI runners see;
 * such an AVD has its own name, so it never shares the default one's snapshot.
 */
export function avdCores(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[`${ENV_PREFIX}ANDROID_CORES`];
  if (raw === undefined || raw === "") return DEFAULT_CORES;
  const cores = Number(raw);
  if (!Number.isInteger(cores) || cores < 1 || cores > 8)
    throw new AndroidSetupError(
      `${ENV_PREFIX}ANDROID_CORES is "${raw}".`,
      "Set it to a whole number of virtual CPUs from 1 to 8, or unset it (2).",
    );
  return cores;
}

/** The config.ini for an AVD: the device profile's screen on the version's system image. */
export function avdConfig(
  name: string,
  profile: DeviceProfile,
  image: SystemImage,
  cores: number = DEFAULT_CORES,
): string {
  const arch = image.abi === "arm64-v8a" ? "arm64" : "x86_64";
  const lines: Record<string, string> = {
    "avd.ini.encoding": "UTF-8",
    AvdId: name,
    "avd.ini.displayname": name,
    "abi.type": image.abi,
    "hw.cpu.arch": arch,
    "hw.cpu.ncore": String(cores),
    "image.sysdir.1": image.sysdir,
    "tag.id": image.tag,
    "PlayStore.enabled": "false",
    "hw.lcd.width": String(profile.width),
    "hw.lcd.height": String(profile.height),
    "hw.lcd.density": String(profile.density),
    "hw.ramSize": String(profile.ramMb),
    "vm.heapSize": "256",
    // A hardware keyboard keeps the on-screen keyboard from covering the app.
    "hw.keyboard": "yes",
    "hw.mainKeys": "no",
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": "swiftshader_indirect",
    "hw.audioInput": "no",
    "hw.audioOutput": "no",
    "hw.camera.back": "none",
    "hw.camera.front": "none",
    "hw.gps": "no",
    "hw.sensors.orientation": "yes",
    "hw.accelerometer": "yes",
    "disk.dataPartition.size": "4G",
    "fastboot.forceColdBoot": "no",
    showDeviceFrame: "no",
    "skin.dynamic": "yes",
  };
  return `${Object.entries(lines)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

export interface Avd {
  name: string;
  dir: string;
  profile: DeviceProfile;
  image: SystemImage;
  release: string;
}

/** Writes (or keeps) the AVD for a version × profile. Throws AndroidSetupError without its system image. */
export function ensureAvd(
  sdk: Sdk,
  release: string,
  device: string,
  env: NodeJS.ProcessEnv = process.env,
): Avd {
  const version = androidVersion(release);
  const profile = deviceProfile(device);
  const image = installedImage(sdk.root, version.release);
  if (!image) {
    throw new AndroidSetupError(
      `No system image for Android ${version.release} is installed.`,
      `Run \`android setup --android ${version.release}\` for the install command.`,
    );
  }
  const home = avdHome(env);
  const cores = avdCores(env);
  const name = avdName(version.release, profile, image, cores);
  const dir = join(home, `${name}.avd`);
  mkdirSync(dir, { recursive: true });
  // The emulator adds keys to config.ini when it boots, so what we wrote is
  // remembered by its hash: a changed profile rewrites it and drops the snapshot.
  const config = avdConfig(name, profile, image, cores);
  const hash = createHash("sha256").update(config).digest("hex");
  const hashPath = join(dir, "harness-config.sha256");
  if (!existsSync(hashPath) || readFileSync(hashPath, "utf8") !== hash) {
    rmSync(join(dir, "snapshots"), { recursive: true, force: true });
    writeFileSync(join(dir, "config.ini"), config);
    writeFileSync(hashPath, hash);
  }
  writeFileSync(
    join(home, `${name}.ini`),
    `avd.ini.encoding=UTF-8\npath=${dir}\ntarget=${version.platform}\n`,
  );
  return { name, dir, profile, image, release: version.release };
}

/** The clean snapshot's name: tied to the driver build and the device settings, so a change makes a new one. */
export function snapshotName(driverApk: string): string {
  const digest = createHash("sha256")
    .update(readFileSync(driverApk))
    .update(JSON.stringify(adbArgs({ name: "prepare-device" })))
    .digest("hex")
    .slice(0, 10);
  return `clean-${digest}`;
}

const hasSnapshot = (avd: Avd, snapshot: string) =>
  existsSync(join(avd.dir, "snapshots", snapshot, "snapshot.pb"));

function emulatorEnv(sdk: Sdk, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ANDROID_HOME: sdk.root, ANDROID_SDK_ROOT: sdk.root, ANDROID_AVD_HOME: avdHome(env) };
}

async function usedSerials(sdk: Sdk): Promise<Set<string>> {
  const result = await runAdb(sdk, null, { name: "devices" }, 15_000);
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.split("\t")[0]?.trim() ?? "")
      .filter((serial) => serial.startsWith("emulator-")),
  );
}

/** Waits until adb no longer lists `serial` (the emulator has really stopped). */
async function serialGone(sdk: Sdk, serial: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await usedSerials(sdk)).has(serial)) return true;
    await sleep(250);
  }
  return false;
}

async function waitForBoot(
  sdk: Sdk,
  serial: string,
  process: Running,
  deadline: number,
): Promise<string | null> {
  let exited = false;
  void process.exited.then(() => {
    exited = true;
  });
  await runAdb(sdk, serial, { name: "wait-for-device" }, Math.max(1_000, deadline - Date.now()));
  while (Date.now() < deadline) {
    if (exited) return "The emulator stopped while booting.";
    const result = await runAdb(
      sdk,
      serial,
      { name: "getprop", key: "sys.boot_completed" },
      10_000,
    );
    if (result.stdout.trim() === "1") {
      // Fully up: the boot animation has stopped too (slow machines report boot_completed first).
      const animation = await runAdb(
        sdk,
        serial,
        { name: "getprop", key: "init.svc.bootanim" },
        10_000,
      );
      if (animation.stdout.trim() === "stopped" || animation.stdout.trim() === "") return null;
    }
    await sleep(500);
  }
  return "The emulator did not finish booting in time.";
}

/** Root adb (the firewall needs it) and confirm it. */
async function ensureRoot(sdk: Sdk, serial: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = await runAdb(sdk, serial, { name: "whoami" }, 10_000);
    if (id.stdout.trim() === "0") return true;
    await runAdb(sdk, serial, { name: "root" }, 15_000);
    await runAdb(sdk, serial, { name: "wait-for-device" }, 30_000);
    await sleep(500);
  }
  return false;
}

/**
 * A running emulator for one worker: booted from its AVD's clean snapshot, with
 * its own network guard (every TCP connection of the device goes there). Share it
 * between sessions; each session restores the clean snapshot first.
 */
export class LaunchedEmulator {
  readonly sdk: Sdk;
  readonly serial: string;
  readonly avd: Avd;
  readonly snapshot: string;
  readonly driverApk: string;
  readonly timings: EmulatorTimings;
  /** @internal The emulator's network guard; sessions set its policy. */
  readonly guard: NetworkGuard;
  #process: Running;
  readonly #boot: BootSettings;
  #closed = false;
  #busy = false;
  #dirty = false;
  #rebooting = false;

  /** @internal */
  constructor(init: {
    sdk: Sdk;
    serial: string;
    avd: Avd;
    snapshot: string;
    driverApk: string;
    timings: EmulatorTimings;
    guard: NetworkGuard;
    process: Running;
    boot: BootSettings;
  }) {
    this.sdk = init.sdk;
    this.serial = init.serial;
    this.avd = init.avd;
    this.snapshot = init.snapshot;
    this.driverApk = init.driverApk;
    this.timings = init.timings;
    this.guard = init.guard;
    this.#process = init.process;
    this.#boot = init.boot;
    this.#watch(init.process);
  }

  #watch(process: Running): void {
    void process.exited.then(() => {
      if (this.#process === process && !this.#rebooting) this.#closed = true;
    });
  }

  get androidVersion(): string {
    return this.avd.release;
  }

  get device(): string {
    return this.avd.profile.name;
  }

  /** False once the emulator process has ended (crashed or closed). */
  get running(): boolean {
    return !this.#closed;
  }

  /** @internal One session at a time. */
  claim(): boolean {
    if (this.#busy || this.#closed) return false;
    this.#busy = true;
    return true;
  }

  /** @internal */
  release(): void {
    this.#busy = false;
    this.#dirty = true;
  }

  /**
   * @internal Makes the device clean for the next session: a no-op after a fresh
   * boot, else a reboot from the clean snapshot. Returns an error message or null.
   */
  async reset(): Promise<string | null> {
    if (this.#closed) return "The emulator is not running.";
    if (!this.#dirty) return null;
    const old = this.#process;
    this.#rebooting = true;
    try {
      await runAdb(this.sdk, this.serial, { name: "emu", command: { name: "kill" } }, 10_000);
      const timer = setTimeout(() => old.kill("SIGKILL"), 15_000);
      await old.exited;
      clearTimeout(timer);
      // The emulator itself (qemu) can outlive its launcher: wait until adb lets go of it.
      if (!(await serialGone(this.sdk, this.serial, 30_000))) {
        this.#closed = true;
        return "The old emulator did not stop.";
      }
      const port = Number(this.serial.replace("emulator-", ""));
      const booted = await bootOnce(
        this.sdk,
        this.avd,
        this.guard,
        { ...this.#boot, snapshot: this.snapshot, port },
        this.#boot.env,
      );
      if ("error" in booted) {
        this.#closed = true;
        return booted.error;
      }
      this.#process = booted.process;
      this.#watch(booted.process);
      this.#dirty = false;
      return null;
    } finally {
      this.#rebooting = false;
    }
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      await runAdb(this.sdk, this.serial, { name: "emu", command: { name: "kill" } }, 10_000);
      const timer = setTimeout(() => this.#process.kill("SIGKILL"), 10_000);
      await this.#process.exited;
      clearTimeout(timer);
      this.#closed = true;
    }
    await this.guard.close();
  }
}

interface BootSettings {
  headless: boolean;
  env: NodeJS.ProcessEnv;
}

async function bootOnce(
  sdk: Sdk,
  avd: Avd,
  guard: NetworkGuard,
  options: { headless: boolean; snapshot?: string; prepare?: boolean; port?: number },
  env: NodeJS.ProcessEnv,
): Promise<{ serial: string; process: Running; ms: number } | { error: string }> {
  const used = await usedSerials(sdk);
  // A reboot keeps its own port (adb may still list the old instance as offline).
  const ports: number[] = [];
  if (options.port) ports.push(options.port);
  else
    for (let port = FIRST_PORT; port <= LAST_PORT; port += 2)
      if (!used.has(`emulator-${port}`)) ports.push(port);
  for (const port of ports) {
    const serial = `emulator-${port}`;
    const started = Date.now();
    const launch = {
      avd: avd.name,
      port,
      proxy: guard.url,
      headless: options.headless,
      ...(options.snapshot ? { snapshot: options.snapshot } : {}),
      ...(options.prepare ? { prepare: true } : {}),
    };
    const process = startEmulator(sdk, launch, emulatorEnv(sdk, env));
    let output = "";
    process.child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output = (output + chunk).slice(-4000);
    });
    process.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      output = (output + chunk).slice(-4000);
    });
    const problem = await waitForBoot(sdk, serial, process, started + BOOT_TIMEOUT_MS);
    if (problem === null) return { serial, process, ms: Date.now() - started };
    process.kill("SIGKILL");
    await process.exited;
    if (/address already in use|port.*(busy|in use)/i.test(output)) continue;
    return { error: `${problem}\n${output.split("\n").slice(-8).join("\n")}`.trim() };
  }
  return {
    error: options.port
      ? `Port ${options.port} is in use.`
      : "No free emulator port between 5580 and 5680.",
  };
}

/** Prepares the clean snapshot for an AVD (a cold boot, once per AVD and driver build). */
async function prepareSnapshot(
  sdk: Sdk,
  avd: Avd,
  snapshot: string,
  driverApk: string,
  options: { headless: boolean; env: NodeJS.ProcessEnv; onProgress?: (message: string) => void },
): Promise<number> {
  options.onProgress?.(
    `Preparing a clean Android ${avd.release} snapshot on ${avd.profile.name} (first run only)…`,
  );
  // No network at all while preparing: the guard has no policy, so it refuses everything.
  const guard = await NetworkGuard.start();
  try {
    const booted = await bootOnce(
      sdk,
      avd,
      guard,
      { headless: options.headless, prepare: true },
      options.env,
    );
    if ("error" in booted)
      throw new AndroidSetupError(
        `The emulator failed to cold boot.\n${booted.error}`,
        "Run `android doctor`.",
      );
    const { serial, process } = booted;
    try {
      if (!(await ensureRoot(sdk, serial))) {
        throw new AndroidSetupError(
          "adb can't run as root on this system image, which the network firewall needs.",
          "Use an automated-test (aosp_atd) or Google APIs image; Google Play images are not supported.",
        );
      }
      await runAdb(sdk, serial, { name: "prepare-device" }, 30_000);
      const install = await runAdb(sdk, serial, { name: "install", apk: driverApk }, 120_000);
      if (!/Success/.test(install.stdout)) {
        throw new AndroidSetupError(
          `The driver APK didn't install: ${install.stdout}${install.stderr}`.trim(),
          "Rebuild the driver.",
        );
      }
      // Let the system settle after first boot before freezing it.
      await sleep(3_000);
      const saved = await runAdb(
        sdk,
        serial,
        { name: "emu", command: { name: "snapshot-save", snapshot } },
        120_000,
      );
      if (!/OK/.test(saved.stdout))
        throw new AndroidSetupError(
          `Saving the snapshot failed: ${saved.stdout}`,
          "Run `android doctor`.",
        );
      return booted.ms;
    } finally {
      await runAdb(sdk, serial, { name: "emu", command: { name: "kill" } }, 10_000);
      const timer = setTimeout(() => process.kill("SIGKILL"), 15_000);
      await process.exited;
      clearTimeout(timer);
    }
  } finally {
    await guard.close();
  }
}

/**
 * Boots an emulator for one worker (like the web harness's launchBrowser).
 * Throws AndroidSetupError for setup problems (no SDK, no system image, no
 * driver, a failing emulator), with the fix.
 */
export async function launchEmulator(options: EmulatorOptions = {}): Promise<LaunchedEmulator> {
  const env = options.env ?? process.env;
  const sdk = requireSdk(env);
  const driverApk = requireDriverApk(env);
  const avd = ensureAvd(
    sdk,
    options.androidVersion ?? androidVersion().release,
    options.device ?? deviceProfile().name,
    env,
  );
  const headless = options.headless ?? true;
  const snapshot = snapshotName(driverApk);
  const timings: EmulatorTimings = { bootMs: 0 };
  if (!hasSnapshot(avd, snapshot)) {
    timings.coldBootMs = await prepareSnapshot(sdk, avd, snapshot, driverApk, {
      headless,
      env,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  }
  const guard = await NetworkGuard.start();
  const booted = await bootOnce(sdk, avd, guard, { headless, snapshot }, env);
  if ("error" in booted) {
    await guard.close();
    throw new AndroidSetupError(
      `The emulator failed to boot.\n${booted.error}`,
      "Run `android doctor`.",
    );
  }
  timings.bootMs = booted.ms;
  return new LaunchedEmulator({
    sdk,
    serial: booted.serial,
    avd,
    snapshot,
    driverApk,
    timings,
    guard,
    process: booted.process,
    boot: { headless, env },
  });
}

export { ensureRoot };
