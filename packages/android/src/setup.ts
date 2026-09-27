import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { brand } from "@testament/brand";
import { snapshotName } from "./emulator.js";
import {
  ANDROID_VERSIONS,
  avdHome,
  DEFAULT_ANDROID_VERSION,
  findDriverApk,
  findSdk,
  hostAbi,
  type Sdk,
  SYSTEM_IMAGE_INSTALLED_FACTOR,
  systemImages,
  TOOL_SIZES,
  toolVersion,
} from "./sdk.js";
import { runEmulatorInfo, startSdkManager } from "./tools.js";

// `android setup` and `android doctor` (MOB-8 groundwork). Setup never downloads
// anything by itself: it lists what is missing, how big it is and the exact
// commands. `installAndroidSdk` runs sdkmanager only when the CLI got an explicit
// `--install` and the user confirmed after seeing the sizes. Accepting the SDK
// licence (`sdkmanager --licenses`) stays the user's own step.

export interface SetupItem {
  package: string;
  what: string;
  downloadMb: number;
  installedMb: number;
  installed: boolean;
}

export interface AndroidSetupPlan {
  sdkRoot: string | null;
  sdkmanager: string | null;
  items: SetupItem[];
  missing: SetupItem[];
  downloadMb: number;
  installedMb: number;
  /** Commands to run, in order, for what is missing. */
  commands: string[];
  notes: string[];
}

const quote = (text: string) => (/[\s;]/.test(text) ? `"${text}"` : text);

/** What `android setup` needs for these versions (default: the default version). */
export function androidSetupPlan(
  versions: readonly string[] = [DEFAULT_ANDROID_VERSION],
  env: NodeJS.ProcessEnv = process.env,
): AndroidSetupPlan {
  const sdk = findSdk(env);
  const root = sdk?.root ?? null;
  const items: SetupItem[] = [
    {
      package: "platform-tools",
      what: "adb",
      downloadMb: TOOL_SIZES["platform-tools"].downloadMb,
      installedMb: TOOL_SIZES["platform-tools"].installedMb,
      installed: root !== null && toolVersion(root, "platform-tools") !== null,
    },
    {
      package: "emulator",
      what: "the Android emulator",
      downloadMb: TOOL_SIZES.emulator.downloadMb,
      installedMb: TOOL_SIZES.emulator.installedMb,
      installed: root !== null && toolVersion(root, "emulator") !== null,
    },
  ];
  for (const release of versions) {
    const images = systemImages(root, release);
    const installed = images.find((image) => image.installed);
    const image = installed ?? images[0];
    if (!image) continue;
    const version = ANDROID_VERSIONS[release];
    const download = version?.downloadMb ?? 1500;
    items.push({
      package: image.package,
      what: `Android ${release} system image (${image.tag})`,
      downloadMb: download,
      installedMb: Math.round(download * SYSTEM_IMAGE_INSTALLED_FACTOR),
      installed: Boolean(installed),
    });
  }
  const missing = items.filter((item) => !item.installed);
  const commands: string[] = [];
  const notes: string[] = [];
  const sdkmanager = sdk?.sdkmanager ?? null;
  if (!sdkmanager) {
    notes.push(
      "sdkmanager (Android command-line tools) is not installed; it needs Java 17 or newer.",
    );
    if (process.platform === "darwin")
      commands.push("brew install --cask android-commandlinetools");
    else
      notes.push(
        "Download the command-line tools from https://developer.android.com/studio#command-line-tools-only",
      );
  }
  if (missing.length > 0) {
    const tool = sdkmanager ? quote(sdkmanager) : "sdkmanager";
    const target =
      root ?? (process.platform === "darwin" ? "$HOME/Library/Android/sdk" : "$HOME/Android/Sdk");
    commands.push(`${tool} --sdk_root=${quote(target)} --licenses`);
    commands.push(
      `${tool} --sdk_root=${quote(target)} ${missing.map((item) => `"${item.package}"`).join(" ")}`,
    );
    if (!root) notes.push(`Then set ANDROID_HOME=${target}.`);
  }
  if (process.platform === "linux") {
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    } catch {
      notes.push(
        "/dev/kvm is not usable: the emulator needs hardware virtualization (KVM) and your user in the kvm group.",
      );
    }
  }
  if (!findDriverApk(env)) {
    notes.push(
      `The on-device driver is not built: pnpm --filter ${brand.npmScope}/android build:driver (needs Java and Gradle).`,
    );
  }
  return {
    sdkRoot: root,
    sdkmanager,
    items,
    missing,
    downloadMb: missing.reduce((sum, item) => sum + item.downloadMb, 0),
    installedMb: missing.reduce((sum, item) => sum + item.installedMb, 0),
    commands,
    notes,
  };
}

/**
 * Runs sdkmanager for the plan's missing packages. Only for an explicit
 * `--install` after the user saw the sizes. Needs the licences accepted first.
 */
export async function installAndroidSdk(
  plan: AndroidSetupPlan,
  onOutput: (text: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const sdk =
    findSdk(env) ??
    (plan.sdkmanager
      ? ({ root: plan.sdkRoot ?? "", adb: "", emulator: "", sdkmanager: plan.sdkmanager } as Sdk)
      : null);
  if (!sdk?.sdkmanager || !sdk.root) {
    onOutput("sdkmanager or the SDK folder is missing; run the commands above yourself.\n");
    return 1;
  }
  const running = startSdkManager(
    sdk,
    plan.missing.map((item) => item.package),
  );
  running.child.stdout?.setEncoding("utf8").on("data", onOutput);
  running.child.stderr?.setEncoding("utf8").on("data", onOutput);
  return (await running.exited) ?? 1;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface AndroidDoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** Checks everything a local Android run needs, without changing anything. */
export async function androidDoctor(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AndroidDoctorReport> {
  const checks: DoctorCheck[] = [];
  const setupFix = `${brand.cliName} android setup`;
  const sdk = findSdk(env);
  checks.push(
    sdk
      ? { id: "sdk", ok: true, detail: sdk.root }
      : {
          id: "sdk",
          ok: false,
          detail: "No Android SDK with adb and the emulator found.",
          fix: setupFix,
        },
  );
  if (sdk) {
    checks.push({
      id: "adb",
      ok: true,
      detail: `platform-tools ${toolVersion(sdk.root, "platform-tools") ?? "?"}`,
    });
    const version = await runEmulatorInfo(sdk, "version");
    const line = version.stdout
      .split("\n")
      .find((l) => /emulator version/i.test(l))
      ?.trim();
    checks.push({
      id: "emulator",
      ok: version.code === 0,
      detail: line ?? `emulator ${toolVersion(sdk.root, "emulator") ?? "?"}`,
    });
    const accel = await runEmulatorInfo(sdk, "accel-check");
    // Output: "accel:", a status code, a description, "accel".
    const accelText =
      `${accel.stdout}${accel.stderr}`
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !/^accel:?$/.test(line) && !/^\d+$/.test(line))
        .join("; ") || "";
    checks.push({
      id: "acceleration",
      ok: accel.code === 0,
      detail: accelText || (accel.code === 0 ? "usable" : "not usable"),
      ...(accel.code === 0
        ? {}
        : {
            fix: "Enable hardware virtualization (KVM on Linux, Hypervisor.framework on macOS, WHPX on Windows), or run in the cloud.",
          }),
    });
    for (const release of Object.keys(ANDROID_VERSIONS)) {
      const image = systemImages(sdk.root, release).find((i) => i.installed);
      checks.push({
        id: `image-${release}`,
        ok: Boolean(image),
        detail: image
          ? `Android ${release}: ${image.package}`
          : `Android ${release}: no system image (${hostAbi()})`,
        ...(image ? {} : { fix: `${setupFix} --android ${release}` }),
      });
    }
  }
  const driver = findDriverApk(env);
  checks.push(
    driver
      ? { id: "driver", ok: true, detail: driver }
      : {
          id: "driver",
          ok: false,
          detail: "The on-device driver APK is missing.",
          fix: `pnpm --filter ${brand.npmScope}/android build:driver`,
        },
  );
  const home = avdHome(env);
  const avds = existsSync(home) ? readdirSync(home).filter((name) => name.endsWith(".avd")) : [];
  const snapshot = driver ? snapshotName(driver) : null;
  const ready = avds.filter(
    (name) => snapshot && existsSync(join(home, name, "snapshots", snapshot, "snapshot.pb")),
  );
  checks.push({
    id: "emulators",
    ok: true,
    detail: avds.length
      ? `${avds.length} emulator(s) in ${home}, ${ready.length} with a clean snapshot for this driver`
      : `none yet in ${home} (the first run prepares one, about a minute)`,
  });
  // Optional checks (informational) don't decide `ok`: images for versions not in use.
  const required = checks.filter(
    (check) => !check.id.startsWith("image-") || check.id === `image-${DEFAULT_ANDROID_VERSION}`,
  );
  return { ok: required.every((check) => check.ok), checks };
}
