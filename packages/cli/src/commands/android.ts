import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { CommandIo } from "./config.js";

// Android commands. The harness is imported only when one of these runs, so no
// other command loads it.

export interface AndroidSetupOptions {
  android?: string[];
  install?: boolean;
  yes?: boolean;
  json?: boolean;
}

export interface AndroidDoctorOptions {
  json?: boolean;
}

export interface AndroidSnapshotOptions {
  allow?: string[];
  android?: string;
  device?: string;
  screenshot?: string;
  window?: boolean;
  json?: boolean;
}

export interface AndroidIo extends CommandIo {
  confirm?: (question: string) => Promise<boolean>;
}

const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);

export async function runAndroidSetupCommand(
  options: AndroidSetupOptions,
  io: AndroidIo,
): Promise<number> {
  const android = await import("@optestra/android");
  const versions = options.android?.length ? options.android : [android.DEFAULT_ANDROID_VERSION];
  let plan: import("@optestra/android").AndroidSetupPlan;
  try {
    plan = android.androidSetupPlan(versions, io.env as NodeJS.ProcessEnv);
  } catch (error) {
    io.stdout(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (options.json) {
    io.stdout(`${JSON.stringify(plan, null, 2)}\n`);
    return plan.missing.length === 0 ? 0 : 1;
  }
  io.stdout(`Android SDK: ${plan.sdkRoot ?? "not found"}\n\n`);
  for (const item of plan.items) {
    const state = item.installed
      ? "installed"
      : `missing (download ${mb(item.downloadMb)}, ${mb(item.installedMb)} on disk)`;
    io.stdout(`  ${item.installed ? "✓" : "✗"} ${item.what.padEnd(40)} ${state}\n`);
  }
  if (plan.missing.length === 0 && plan.notes.length === 0) {
    io.stdout("\nEverything needed for local Android runs is installed.\n");
    return 0;
  }
  if (plan.missing.length > 0) {
    io.stdout(
      `\nTo install: about ${mb(plan.downloadMb)} to download, ${mb(plan.installedMb)} on disk.\n`,
    );
  }
  if (plan.commands.length > 0) {
    io.stdout("\nRun:\n");
    for (const command of plan.commands) io.stdout(`  ${command}\n`);
  }
  for (const note of plan.notes) io.stdout(`\nNote: ${note}\n`);
  if (!options.install || plan.missing.length === 0) return plan.missing.length === 0 ? 0 : 1;
  if (!plan.sdkmanager) {
    io.stdout("\n--install needs sdkmanager; install the command-line tools first (above).\n");
    return 1;
  }
  const question = `Download and install ${plan.missing.map((item) => item.package).join(", ")} (${mb(plan.downloadMb)})?`;
  const agreed = options.yes || (io.confirm ? await io.confirm(question) : false);
  if (!agreed) {
    io.stdout(options.yes ? "" : "\nNot installed. Re-run with --yes to install without asking.\n");
    return 1;
  }
  io.stdout("\nThe Android SDK licence must be accepted first (the --licenses command above).\n");
  const code = await android.installAndroidSdk(plan, io.stdout, io.env as NodeJS.ProcessEnv);
  return code === 0 ? 0 : 1;
}

export async function runAndroidDoctorCommand(
  options: AndroidDoctorOptions,
  io: CommandIo,
): Promise<number> {
  const android = await import("@optestra/android");
  const report = await android.androidDoctor(io.env as NodeJS.ProcessEnv);
  if (options.json) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }
  for (const check of report.checks) {
    io.stdout(`  ${check.ok ? "✓" : "✗"} ${check.id.padEnd(14)} ${check.detail}\n`);
    if (!check.ok && check.fix) io.stdout(`    fix: ${check.fix}\n`);
  }
  io.stdout(
    report.ok ? "\nReady for local Android runs.\n" : "\nNot ready for local Android runs yet.\n",
  );
  return report.ok ? 0 : 1;
}

export async function runAndroidSnapshotCommand(
  apk: string,
  options: AndroidSnapshotOptions,
  io: CommandIo,
): Promise<number> {
  const android = await import("@optestra/android");
  let opened: import("@optestra/android").OpenSessionResult;
  try {
    opened = await android.openAndroidSession({
      apk: resolve(io.cwd, apk),
      allowedDomains: options.allow ?? [],
      headless: !options.window,
      ...(options.android ? { androidVersion: options.android } : {}),
      ...(options.device ? { device: options.device } : {}),
    });
  } catch (error) {
    const fix = error instanceof android.AndroidSetupError ? `\nFix: ${error.fix}` : "";
    io.stdout(`${error instanceof Error ? error.message : String(error)}${fix}\n`);
    return 2;
  }
  if (!opened.ok) {
    io.stdout(`The app could not be started: ${opened.reason}: ${opened.message}\n`);
    return 1;
  }
  const session = opened.session;
  try {
    const observation = await session.observe();
    if (options.screenshot) {
      const shot = await session.screenshot();
      if (shot.status === "ok") writeFileSync(resolve(io.cwd, options.screenshot), shot.bytes);
    }
    if (options.json) {
      io.stdout(
        `${JSON.stringify({ observation, timings: session.timings(), device: session.device() }, null, 2)}\n`,
      );
    } else {
      io.stdout(`${android.renderForModel(observation)}\n`);
      const t = session.timings();
      io.stdout(
        `\nStarted in ${t.totalMs} ms${t.bootMs !== undefined ? ` (emulator boot ${t.bootMs} ms)` : ""}.\n`,
      );
    }
    return 0;
  } finally {
    await session.close();
  }
}

export function registerAndroidCommands(program: Command, io: () => AndroidIo): void {
  const android = program
    .command("android")
    .description("local Android emulator runs: setup, doctor, snapshot");

  android
    .command("setup")
    .description(
      "check the Android SDK, emulator and system images; print the exact install commands and sizes",
    )
    .option("--android <versions...>", "Android versions to set up (default: 16)")
    .option("--install", "run sdkmanager for what is missing, after showing the sizes and asking")
    .option("-y, --yes", "with --install: install without asking")
    .option("--json", "print machine-readable JSON")
    .action(async (options: AndroidSetupOptions) => {
      process.exitCode = await runAndroidSetupCommand(options, io());
    });

  android
    .command("doctor")
    .description("check everything a local Android run needs, without changing anything")
    .option("--json", "print machine-readable JSON")
    .action(async (options: AndroidDoctorOptions) => {
      process.exitCode = await runAndroidDoctorCommand(options, io());
    });

  android
    .command("snapshot")
    .description(
      "debug: install an APK on a fresh emulator and print what the agent sees on its first screen",
    )
    .argument("<apk>", "the APK to install")
    .option(
      "--allow <domains...>",
      "hosts the app may reach, e.g. api.example.com or 10.0.2.2:4180",
    )
    .option("--android <version>", "Android version (default: 16)")
    .option("--device <profile>", "device profile, e.g. pixel-8, small-phone, pixel-tablet")
    .option("--screenshot <file>", "also save a PNG screenshot")
    .option("--window", "show the emulator window")
    .option("--json", "print machine-readable JSON")
    .action(async (apk: string, options: AndroidSnapshotOptions) => {
      process.exitCode = await runAndroidSnapshotCommand(apk, options, io());
    });
}
