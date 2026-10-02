// Merges what create.sh, setup.sh and run.sh recorded into one file for the cost
// meter (COST-0): <out>/android-vm-run.json. Shape: see the README.
//
//   node report.mjs <out dir> <replay|command> <command> <exit status>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out, kind, command, exit] = process.argv.slice(2);
const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
const env = process.env;

const phases = read(join(out, "phases.json")) ?? {};
const setup = read(join(out, "setup-phases.json"));
const firstBoot = read(join(out, "vm", "first-boot.json"));
const machine = read(join(out, "vm", "machine.json"));
const run = read(join(out, "vm", "run-phases.json"));
const replay = kind === "replay" ? read(join(out, "vm", "replay.json")) : null;

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
  const mean = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
  return {
    n: sorted.length,
    mean: Math.round(mean),
    p50: rank(0.5),
    p90: rank(0.9),
    max: sorted.at(-1) ?? 0,
  };
}

let replayFacts = null;
if (replay) {
  const rows = replay.rows;
  const cost = Object.values(replay.summary.cost ?? {});
  const tests = cost.reduce((s, c) => s + c.tests, 0) || 1;
  const evidence = cost.reduce((s, c) => s + c.evidenceBytes, 0);
  replayFacts = {
    summary: {
      tests: replay.summary.tests,
      match: replay.summary.match,
      healed: replay.summary.healed,
      needsAi: replay.summary.needsAi,
      mismatch: replay.summary.mismatch,
      aiCalls: replay.summary.aiCalls,
    },
    wallMsPerTest: summary(rows.map((r) => r.durationMs)),
    machineCpuMsPerTest: Math.round(cost.reduce((s, c) => s + c.machineCpuMs, 0) / tests),
    evidenceBytes: { total: evidence, perTest: Math.round(evidence / tests) },
    variants: replay.summary.cost ?? {},
    variantWallMs: replay.summary.times,
    mismatches: rows
      .filter((r) => r.score === "mismatch")
      .map((r) => ({ variant: r.variant, test: r.test, note: r.note })),
  };
}

const startedAt = phases.vmStartedAt ?? null;
const vmSeconds = startedAt ? Math.round((Date.now() - startedAt) / 1000) : null;
const hourly = env.ANDROID_VM_HOURLY_USD ? Number(env.ANDROID_VM_HOURLY_USD) : null;
const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const file = {
  kind: "android-vm-run",
  version: 1,
  date: new Date().toISOString(),
  commit: git("rev-parse", "HEAD"),
  dirty: (git("status", "--porcelain") ?? "") !== "",
  vm: {
    machineType: env.ANDROID_VM_MACHINE ?? "n2-standard-4",
    zone: env.ANDROID_VM_ZONE ?? "us-east4-a",
    provisioning: "spot",
    maxRunDuration: env.ANDROID_VM_MAX_RUN ?? "3h",
    diskGb: Number(env.ANDROID_VM_DISK_GB ?? 30),
    image: env.ANDROID_VM_IMAGE || "ubuntu-2404-lts-amd64",
    fromReusableImage: Boolean(env.ANDROID_VM_IMAGE),
    ...(machine ?? {}),
  },
  phases: {
    createMs: phases.createMs ?? null,
    sshReadyMs: phases.sshReadyMs ?? null,
    setupMs: phases.setupMs ?? null,
    setup: setup ?? null,
    // First boot on a fresh disk: the cold boot that makes the clean snapshot.
    emulatorColdBootMs: firstBoot?.coldBootMs ?? replay?.summary.emulator?.coldBootMs ?? null,
    // This run's boot from the clean snapshot.
    emulatorSnapshotBootMs: replay?.summary.emulator?.bootMs ?? firstBoot?.snapshotBootMs ?? null,
    buildMs: run?.buildMs ?? null,
    commandMs: run?.commandMs ?? null,
    imageCreateMs: phases.imageCreateMs ?? null,
  },
  command,
  exit: Number(exit),
  // A spot VM can be taken back at any time; then nothing above is complete.
  preempted: phases.preempted === 1,
  replay: replayFacts,
  cost: {
    vmSeconds,
    hourlyUsd: hourly,
    usd:
      hourly !== null && vmSeconds !== null
        ? Number(((vmSeconds / 3600) * hourly).toFixed(4))
        : null,
  },
};
writeFileSync(join(out, "android-vm-run.json"), `${JSON.stringify(file, null, 2)}\n`);
