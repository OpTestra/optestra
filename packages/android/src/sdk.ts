import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import devicesData from "./devices.json" with { type: "json" };
import versionsData from "./versions.json" with { type: "json" };

// Where the Android SDK is, which versions and device profiles exist (data files,
// TGT-4/TGT-6), and where the harness keeps its own emulators. Nothing here runs
// a program; see tools.ts for that.

/** A setup problem: no SDK, no emulator, no system image, no driver. Carries the fix. */
export class AndroidSetupError extends Error {
  readonly fix: string;
  constructor(message: string, fix: string) {
    super(message);
    this.name = "AndroidSetupError";
    this.fix = fix;
  }
}

export interface AndroidVersion {
  /** Major version, e.g. "16". */
  release: string;
  api: number;
  /** SDK package part, e.g. "android-36" (system-images;android-36;…). */
  platform: string;
  /** System image tags, preferred first. */
  images: readonly string[];
  downloadMb: number;
}

export interface DeviceProfile {
  name: string;
  label: string;
  category: "phone" | "tablet";
  width: number;
  height: number;
  density: number;
  ramMb: number;
}

export const ANDROID_VERSIONS: Readonly<Record<string, AndroidVersion>> = Object.freeze(
  Object.fromEntries(
    Object.entries(versionsData.versions).map(([release, v]) => [release, { release, ...v }]),
  ),
);
export const DEFAULT_ANDROID_VERSION: string = versionsData.default;

export const DEVICE_PROFILES: Readonly<Record<string, DeviceProfile>> = Object.freeze(
  Object.fromEntries(
    Object.entries(devicesData.profiles).map(([name, p]) => [
      name,
      { name, ...p, category: p.category as DeviceProfile["category"] },
    ]),
  ),
);
export const DEFAULT_DEVICE_PROFILE: string = devicesData.default;

export const TOOL_SIZES = versionsData.tools;
export const SYSTEM_IMAGE_INSTALLED_FACTOR = versionsData.systemImageInstalledFactor;

export function androidVersion(release: string = DEFAULT_ANDROID_VERSION): AndroidVersion {
  const version = ANDROID_VERSIONS[release];
  if (!version) {
    throw new AndroidSetupError(
      `Android ${release} is not a known version.`,
      `Use one of: ${Object.keys(ANDROID_VERSIONS).join(", ")}.`,
    );
  }
  return version;
}

export function deviceProfile(name: string = DEFAULT_DEVICE_PROFILE): DeviceProfile {
  const profile = DEVICE_PROFILES[name];
  if (!profile) {
    throw new AndroidSetupError(
      `"${name}" is not a known device profile.`,
      `Use one of: ${Object.keys(DEVICE_PROFILES).join(", ")}.`,
    );
  }
  return profile;
}

/** The emulator ABI for this machine. */
export function hostAbi(arch: string = process.arch): "arm64-v8a" | "x86_64" {
  return arch === "arm64" ? "arm64-v8a" : "x86_64";
}

export interface Sdk {
  root: string;
  adb: string;
  emulator: string;
  /** sdkmanager, when the command-line tools are installed (it needs Java). */
  sdkmanager: string | null;
}

type Platform = NodeJS.Platform;

/** Program file names to look for: Windows ships `.exe` (adb, emulator) and `.bat` (sdkmanager). */
const programNames = (name: string, platform: Platform, windowsExt: ".exe" | ".bat") =>
  platform === "win32" ? [`${name}${windowsExt}`, name] : [name];

function program(
  dir: string,
  name: string,
  platform: Platform,
  windowsExt: ".exe" | ".bat",
): string | null {
  for (const file of programNames(name, platform, windowsExt)) {
    const path = join(dir, file);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Places the SDK usually lives, first match wins. */
export function sdkCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): string[] {
  const home = homedir();
  const list = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    platform === "darwin" ? join(home, "Library", "Android", "sdk") : undefined,
    platform === "linux" ? join(home, "Android", "Sdk") : undefined,
    platform === "win32" && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    platform === "darwin" ? "/opt/homebrew/share/android-commandlinetools" : undefined,
    platform === "linux" ? "/usr/local/lib/android/sdk" : undefined,
  ];
  return [...new Set(list.filter((path): path is string => Boolean(path)))];
}

function findSdkManager(root: string, platform: Platform): string | null {
  const direct = program(
    join(root, "cmdline-tools", "latest", "bin"),
    "sdkmanager",
    platform,
    ".bat",
  );
  if (direct) return direct;
  const tools = join(root, "cmdline-tools");
  if (!existsSync(tools)) return null;
  for (const entry of readdirSync(tools).sort().reverse()) {
    const path = program(join(tools, entry, "bin"), "sdkmanager", platform, ".bat");
    if (path) return path;
  }
  return null;
}

/** The SDK with adb and the emulator, or null. `platform` is for tests of other systems' layouts. */
export function findSdk(
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): Sdk | null {
  for (const root of sdkCandidates(env, platform)) {
    const adb = program(join(root, "platform-tools"), "adb", platform, ".exe");
    const emulator = program(join(root, "emulator"), "emulator", platform, ".exe");
    if (adb && emulator) return { root, adb, emulator, sdkmanager: findSdkManager(root, platform) };
  }
  return null;
}

export function requireSdk(env: NodeJS.ProcessEnv = process.env): Sdk {
  const sdk = findSdk(env);
  if (!sdk) {
    throw new AndroidSetupError(
      "No Android SDK with adb and the emulator was found.",
      `Run \`${brand.cliName} android setup\` for the exact install commands, or set ANDROID_HOME.`,
    );
  }
  return sdk;
}

export interface SystemImage {
  version: AndroidVersion;
  tag: string;
  abi: string;
  /** e.g. system-images;android-36;aosp_atd;arm64-v8a */
  package: string;
  /** Relative to the SDK root, with a trailing slash (AVD config `image.sysdir.1`). */
  sysdir: string;
  installed: boolean;
}

/** The system images for a version, preferred first, with what's installed. */
export function systemImages(
  sdkRoot: string | null,
  release: string,
  abi = hostAbi(),
): SystemImage[] {
  const version = androidVersion(release);
  return version.images.map((tag) => {
    const sysdir = `system-images/${version.platform}/${tag}/${abi}/`;
    return {
      version,
      tag,
      abi,
      package: `system-images;${version.platform};${tag};${abi}`,
      sysdir,
      installed: sdkRoot !== null && existsSync(join(sdkRoot, sysdir, "system.img")),
    };
  });
}

/** The system image to use: the first installed one in preference order, else null. */
export function installedImage(
  sdkRoot: string,
  release: string,
  abi = hostAbi(),
): SystemImage | null {
  return systemImages(sdkRoot, release, abi).find((image) => image.installed) ?? null;
}

/** Where the harness keeps its own emulators, apart from the user's. */
export function harnessHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[`${ENV_PREFIX}ANDROID_HOME`] || join(homedir(), brand.dataDirName, "android");
}

export const avdHome = (env: NodeJS.ProcessEnv = process.env) => join(harnessHome(env), "avd");

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The driver APK: an override, the published copy, or the local Gradle build. */
export function findDriverApk(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env[`${ENV_PREFIX}ANDROID_DRIVER_APK`],
    join(PACKAGE_ROOT, "driver.apk"),
    join(PACKAGE_ROOT, "driver", "build", "outputs", "apk", "debug", "android-driver-debug.apk"),
  ];
  return (
    candidates.find((path): path is string => Boolean(path) && existsSync(path as string)) ?? null
  );
}

export function requireDriverApk(env: NodeJS.ProcessEnv = process.env): string {
  const apk = findDriverApk(env);
  if (!apk) {
    throw new AndroidSetupError(
      "The on-device driver APK is missing.",
      `Build it with \`pnpm --filter ${brand.npmScope}/android build:driver\` (needs Java and Gradle), or set ${ENV_PREFIX}ANDROID_DRIVER_APK.`,
    );
  }
  return apk;
}

/** Version strings of the installed tools, read from their package files (no program runs). */
export function toolVersion(sdkRoot: string, tool: "platform-tools" | "emulator"): string | null {
  const file = join(sdkRoot, tool, "source.properties");
  if (!existsSync(file)) return null;
  const match = /^Pkg\.Revision=(.+)$/m.exec(readFileSync(file, "utf8"));
  return match?.[1]?.trim() ?? null;
}
