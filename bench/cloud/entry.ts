// The cost-run task (COST-0): what one Cloud Run Job task runs, and what run.sh
// runs directly on this machine as the local stand-in. It reads its slice from
// the environment, runs it, and writes one cost measurement plus the evidence
// under $OUT/cost-runs/<id>/ (in the cloud, the GCS bucket mounted at $OUT).
//
//   COST_RUN       the cost run's id (required): labels, folder names
//   SLICES         a JSON array of slices; task N runs SLICES[N % length]
//                  e.g. [{"fixture":"shop","phase":"replay","variants":["correct"],"reruns":10}]
//   PARALLEL       tests in parallel inside the task (default 1)
//   SHAPE_VCPU, SHAPE_MEMORY_GIB   what the task was given (default: read from the cgroup, else 2 / 4)
//   MODEL          provider:model for author and heal, e.g. anthropic:claude-sonnet-5-5
//   SCRIPTED=1     a scripted stand-in instead of a real model (rehearsal)
//   RECORDINGS     a folder of *.steps.json authored elsewhere (option b)
//   OUT            default /mnt/evidence in a Cloud Run task, else bench/cloud/out
//
// Cloud Run sets CLOUD_RUN_JOB, CLOUD_RUN_EXECUTION, CLOUD_RUN_TASK_INDEX and
// CLOUD_RUN_TASK_COUNT (the local stand-in sets EXECUTION, TASK_INDEX and TASK_COUNT).
// Nothing here names a project, an account or a key.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// performance.timeOrigin is the process start: this is Node's own start-up.
const processStartMs = performance.now();
const startedAt = new Date().toISOString();

const here = dirname(fileURLToPath(import.meta.url));
const bench = await import(join(here, "..", "..", "packages", "core", "dist", "bench", "index.js"));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function cgroupShape(): { vcpu: number | null; memoryGiB: number | null } {
  const read = (file: string) => {
    try {
      return readFileSync(`/sys/fs/cgroup/${file}`, "utf8").trim();
    } catch {
      return null;
    }
  };
  const cpu = read("cpu.max")?.split(" ");
  const mem = read("memory.max");
  const vcpu = cpu && cpu[0] !== "max" ? Number(cpu[0]) / Number(cpu[1]) : null;
  const memoryGiB = mem && mem !== "max" ? Number(mem) / 1024 ** 3 : null;
  return { vcpu, memoryGiB };
}

const env = process.env;
const costRun = env.COST_RUN ?? fail("COST_RUN is required (the cost run's id).");
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(costRun))
  fail("COST_RUN must be lowercase letters, digits and dashes (it is a label value).");
let slices: unknown;
try {
  slices = JSON.parse(env.SLICES ?? "");
} catch {
  fail('SLICES must be a JSON array, e.g. [{"fixture":"shop","phase":"replay"}].');
}
if (!Array.isArray(slices) || slices.length === 0) fail("SLICES must be a non-empty JSON array.");
const index = Number(env.CLOUD_RUN_TASK_INDEX ?? env.TASK_INDEX ?? 0);
const count = Number(env.CLOUD_RUN_TASK_COUNT ?? env.TASK_COUNT ?? 1);
const slice = slices[index % slices.length];
const cloud = env.CLOUD_RUN_JOB !== undefined;
const fromCgroup = cgroupShape();
const model = env.MODEL ? bench.parseModelEntry(env.MODEL) : null;
if (env.MODEL && !model) fail(`MODEL must be provider:model, not "${env.MODEL}".`);

const measurement = await bench.runSlice({
  slice,
  costRun,
  out: env.OUT ?? (cloud ? "/mnt/evidence" : join(here, "out")),
  parallel: Math.max(1, Number(env.PARALLEL ?? 1)),
  shape: {
    vcpu: Number(env.SHAPE_VCPU ?? fromCgroup.vcpu ?? 2),
    memoryGiB: Number(env.SHAPE_MEMORY_GIB ?? fromCgroup.memoryGiB ?? 4),
  },
  task: {
    index,
    count,
    execution: env.CLOUD_RUN_EXECUTION ?? env.EXECUTION ?? null,
    region: env.REGION ?? null,
  },
  where: cloud ? "cloud-run" : env.ANDROID_VM === "1" ? "android-vm" : "local",
  model,
  scripted: env.SCRIPTED === "1",
  recordings: env.RECORDINGS ?? null,
  processStartMs,
  startedAt,
  env,
  onProgress: (line: string) => process.stdout.write(`${line}\n`),
});

// One line for Cloud Logging and for run.sh.
process.stdout.write(
  `${JSON.stringify({
    costRun,
    task: index,
    phase: measurement.slice.phase,
    tests: measurement.tests.length,
    wallMs: measurement.timing.taskWallMs,
    cpuSeconds: measurement.resources.cpuSeconds,
    peakMiB: Math.round(measurement.resources.peakMemoryBytes / 1024 ** 2),
    aiCalls: measurement.tests.reduce((n: number, t: { aiCalls: number }) => n + t.aiCalls, 0),
  })}\n`,
);
