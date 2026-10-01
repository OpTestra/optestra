// plan.sh's arithmetic (COST-0): every resource the cost run would create, and
// the expected $ of tomorrow's run, from plan.json, prices.yaml and the AI
// numbers of the newest model comparison. Reads files only; creates nothing.
//
//   node bench/cloud/plan.ts [--json]
//   env: COST_RUN, REGION, AI_MODE (api|local), CORPUS_STYLES (comma list, default all),
//        CORPUS_TESTS (comma list), ANDROID_VM_HOURS (default 2), IMAGE_GIB (default 2.2),
//        BUILD_MINUTES (default 12), PROJECT_ID (only printed)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const bench = await import(join(repo, "packages", "core", "dist", "bench", "index.js"));
const brand = JSON.parse(readFileSync(join(repo, "packages", "brand", "brand.json"), "utf8"));
const slug = String(brand.productName).toLowerCase();

interface Execution {
  name: string;
  why: string;
  slices: unknown[];
  tasks: number;
  parallel: number;
  cpu: number;
  memoryGiB: number;
  expectedMinutes: number;
  ai?: boolean;
}

const env = process.env;
const json = process.argv.includes("--json");
const costRun = env.COST_RUN ?? "<COST_RUN>";
const region = env.REGION ?? "us-east4";
const aiMode = env.AI_MODE ?? "local";
const project = env.PROJECT_ID ?? "<PROJECT_ID>";
const prices = bench.loadCloudPrices(join(here, "prices.yaml"));
const plan = JSON.parse(readFileSync(join(here, "plan.json"), "utf8")) as {
  executions: Execution[];
};
const jobs = prices.cloudRun.jobs;
const labels = `app=${slug},lane=${env.LANE ?? "engine-core"},cost-run=${costRun}`;
const money = (n: number, d = 4) => `$${n.toFixed(d)}`;

// ── Cloud Run executions ─────────────────────────────────────────────────────────
const runnable = plan.executions.filter(
  (e) => !(e.ai && e.name.startsWith("author") && aiMode !== "api"),
);
const executions = runnable.map((e) => {
  const seconds = bench.billableSeconds(e.expectedMinutes * 60_000, jobs);
  const rate = bench.shapeRate({ vcpu: e.cpu, memoryGiB: e.memoryGiB, parallel: e.parallel }, jobs);
  return { ...e, billableSeconds: seconds, usd: e.tasks * seconds * rate };
});
const cloudRun = executions.reduce((n, e) => n + e.usd, 0);

// ── one-offs and storage for the day ───────────────────────────────────────────────
const buildMinutes = Number(env.BUILD_MINUTES ?? 12);
const imageGiB = Number(env.IMAGE_GIB ?? 2.2);
const build = buildMinutes * prices.cloudBuild.e2Standard2Minute;
const registryDay =
  (Math.max(0, imageGiB - prices.artifactRegistry.freeGibMonth) *
    prices.artifactRegistry.gibMonth) /
  30;
// Evidence: about 250 web test runs at up to 1 MiB, kept until down.sh (a day at most).
const evidenceGiB = (250 * 1) / 1024;
const storageDay =
  (evidenceGiB * prices.storage.standardGibMonth) / 30 +
  ((250 * 13) / 1000) * prices.storage.classAPer1000;
const secretDay = 0;

// ── Android on MOB-3's spot VM ─────────────────────────────────────────────────────
const vmHours = Number(env.ANDROID_VM_HOURS ?? 2);
const vm = prices.compute.spot["n2-standard-4"] as { hour: number };
const android =
  vmHours * (vm.hour + (30 * prices.compute.pdBalancedGibMonth) / prices.hoursPerMonth);

// ── AI ───────────────────────────────────────────────────────────────────────────────
const styles = env.CORPUS_STYLES ? env.CORPUS_STYLES.split(",") : undefined;
const tests = env.CORPUS_TESTS ? env.CORPUS_TESTS.split(",") : undefined;
const corpus = await bench.estimateCorpus(join(repo, "bench"), {
  fixtures: ["shop", "android"],
  ...(styles ? { styles } : {}),
  ...(tests ? { tests } : {}),
  model: "claude-sonnet-5-5",
});
const basis = corpus.basis.fixture.shop;
const cloudAi = runnable
  .filter((e) => e.ai)
  .map((e) => {
    if (aiMode !== "api") return { name: e.name, calls: 0, usd: 0 };
    if (e.name.startsWith("author"))
      return {
        name: e.name,
        calls: Math.round(11 * basis.callsPerTest),
        usd: 11 * basis.usdPerTest,
      };
    return { name: e.name, calls: basis.healCalls, usd: basis.healUsd };
  });
const ai = {
  corpus: corpus.total,
  cloud: cloudAi,
  calls: corpus.total.calls + cloudAi.reduce((n, x) => n + x.calls, 0),
  usd: corpus.total.usd + cloudAi.reduce((n, x) => n + x.usd, 0),
};

const resources = [
  {
    what: "APIs enabled",
    name: "run, cloudbuild, artifactregistry, secretmanager, storage, iam",
    cost: "$0",
    teardown: "left enabled (free)",
  },
  {
    what: "Artifact Registry repo (docker)",
    name: `${region}/${slug}-cost`,
    cost: `${money(prices.artifactRegistry.gibMonth, 2)}/GiB-month over ${prices.artifactRegistry.freeGibMonth} GiB; image ≈ ${imageGiB} GiB`,
    teardown: "down.sh deletes the repo",
  },
  {
    what: "Cloud Build run",
    name: "bench/cloud/cloudbuild.yaml (hadolint, docker build, push)",
    cost: `${money(prices.cloudBuild.e2Standard2Minute, 3)}/min e2-standard-2, ≈ ${buildMinutes} min; ${prices.cloudBuild.freeMinutesPerMonth} free min/month`,
    teardown: "nothing left running",
  },
  {
    what: "Cloud Storage bucket",
    name: `gs://${project}-${slug}-cost-runs (${region}, no soft delete, objects deleted after ${env.RETENTION_DAYS ?? 7} days)`,
    cost: `${money(prices.storage.standardGibMonth, 3)}/GiB-month, ${money(prices.storage.classAPer1000, 3)}/1,000 writes`,
    teardown: "down.sh empties and deletes it",
  },
  {
    what: "Service account (no keys)",
    name: `cost-runner@${project}.iam.gserviceaccount.com: objectUser on the bucket, logWriter${aiMode === "api" ? ", secretAccessor on the key" : ""}`,
    cost: "$0",
    teardown: "down.sh deletes it",
  },
  ...(aiMode === "api"
    ? [
        {
          what: "Secret Manager secret (option a)",
          name: `${slug}-anthropic-api-key (${region}); you add the key's value yourself`,
          cost: `first ${prices.secretManager.freeVersions} versions free`,
          teardown: "down.sh deletes it",
        },
      ]
    : []),
  {
    what: "Cloud Run Job",
    name: `cost-${costRun} (${region}, max retries 0, task timeout 45m, bucket mounted at /mnt/evidence)`,
    cost: `${money(jobs.vcpuSecond, 6)}/vCPU-s + ${money(jobs.gibSecond, 6)}/GiB-s, ≥ 1 min per task; $0 idle`,
    teardown: "down.sh deletes it",
  },
  {
    what: "Spot VM (MOB-3, Android)",
    name: `n2-standard-4, nested virtualization, 30 GiB pd-balanced, --max-run-duration 3h (Google deletes it)`,
    cost: `${money(vm.hour)}/h spot + disk`,
    teardown: "MOB-3's delete script; Google deletes it at the time limit anyway",
  },
];

const totals = {
  cloudRun,
  build,
  registryDay,
  storageDay,
  secretDay,
  android,
  cloud: cloudRun + build + registryDay + storageDay + secretDay + android,
  aiCalls: ai.calls,
  aiUsd: ai.usd,
};

if (json) {
  process.stdout.write(
    `${JSON.stringify({ costRun, region, aiMode, labels, resources, executions, ai, totals, prices: { checked: prices.checked } }, null, 2)}\n`,
  );
} else {
  const out: string[] = [];
  out.push(
    `Cost run ${costRun} in ${region} (prices checked ${prices.checked}); every resource labelled ${labels}.`,
    "",
  );
  out.push("Resources up.sh creates:");
  for (const r of resources)
    out.push(`  - ${r.what}: ${r.name}\n      cost: ${r.cost}\n      teardown: ${r.teardown}`);
  out.push("", "Executions run.sh starts (each one Cloud Run Job execution):");
  for (const e of executions)
    out.push(
      `  - ${e.name}: ${e.tasks} task(s) × ${e.cpu} vCPU / ${e.memoryGiB} GiB, ${e.parallel} at a time, ~${e.expectedMinutes} min (${e.billableSeconds} s billed): ${money(e.usd)}\n      ${e.why}`,
    );
  const skipped = plan.executions.filter((e) => !runnable.includes(e));
  for (const e of skipped)
    out.push(`  - ${e.name}: skipped with AI_MODE=${aiMode} (runs on this Mac instead)`);
  out.push(
    "",
    "Expected cloud $ (list, before free tiers):",
    `  Cloud Run ${money(cloudRun)} · build ${money(build)} · registry for a day ${money(registryDay)} · storage for a day ${money(storageDay, 5)} · Android VM ${vmHours} h ${money(android)}`,
    `  total ≈ ${money(totals.cloud, 2)}`,
    "",
    `Expected AI (Sonnet 5.5, list): corpus ${corpus.total.calls} calls ≈ ${money(corpus.total.usd, 2)} (${styles ? styles.join(", ") : "all styles"}${tests ? `; tests ${tests.join(", ")}` : ""})${cloudAi.length ? `; in the cloud ${cloudAi.map((x) => `${x.name} ${x.calls} calls ${money(x.usd, 2)}`).join(", ")}` : ""}`,
    `  total ≈ ${ai.calls} calls, ${money(ai.usd, 2)}`,
    "",
    "Nothing was created: plan.sh only reads files.",
  );
  process.stdout.write(`${out.join("\n")}\n`);
}
