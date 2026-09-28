// bench:replay:android (MOB-1): `run` on every Android fixture variant with the
// committed recordings, scored against the gold manifest (verdict + cause).
//
//   node packages/core/bench/replay-android.ts [--variant correct …] [--json out.json]
//
// Same rules as the shop's bench:replay: every variant runs --replay-only (no AI
// at all), except `cosmetic`, which runs in normal mode without an AI model:
// heals without AI are expected there (`healed` or `passed` both count), and a
// miss only an AI heal could fix is counted as "needs AI", not as a wrong answer.
//
// Needs the APKs (pnpm --filter @testament/fixture-android build:apks) and an
// Android SDK. One emulator serves every variant; the shop's server (the app's
// backend) runs `correct` on port 4180, as the APKs are built for.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { launchEmulator } from "@testament/android";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import { parseYaml } from "@testament/config/node";
import type { TestResult } from "@testament/contract";
import { runTests } from "@testament/core/node";
import {
  apkPath,
  apksBuilt,
  FIXTURE_DIR,
  SHOP_PORT,
  VARIANTS,
  type Variant,
} from "@testament/fixture-android";
import { startShop } from "@testament/fixture-shop";
import { loadTest } from "@testament/spec/node";

const PASSWORD = "shop-demo-pass";

interface Expectation {
  verdict: string;
  step?: number;
  cause?: string;
  reason?: string;
}
interface Manifest {
  variants: Record<string, { also_accept?: { passed?: string[] } }>;
  tests: Record<string, Record<string, string | Expectation>>;
  harness: { retries: number };
}

const { values } = parseArgs({
  options: {
    variant: { type: "string", multiple: true },
    json: { type: "string" },
  },
});

if (!apksBuilt())
  throw new Error(
    "The fixture APKs are not built: pnpm --filter @testament/fixture-android build:apks",
  );

const manifest = parseYaml(
  readFileSync(join(FIXTURE_DIR, "manifest.yaml"), "utf8"),
  "manifest.yaml",
).value as Manifest;

/** A private copy of the project (config, tests, committed recordings): runs never touch the fixture. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "bench-replay-android-"));
  cpSync(join(FIXTURE_DIR, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(FIXTURE_DIR, "tests"), join(dir, "tests"), {
    recursive: true,
    filter: (source) => !source.includes(`${brand.dataDirName}/authoring`),
  });
  return dir;
}

const expectation = (test: string, variant: string): Expectation => {
  const entry = manifest.tests[test]?.[variant];
  if (entry === undefined) throw new Error(`manifest has no answer for ${test} × ${variant}`);
  return typeof entry === "string" ? { verdict: entry } : entry;
};

/** The .test.md step number where the final (or first failing) attempt stopped. */
async function failingStep(dir: string, result: TestResult): Promise<number | null> {
  const attempt =
    result.attempts.find((a) => a.status !== "passed") ?? result.attempts.at(-1) ?? null;
  const step = attempt?.steps.find((s) => s.status === "failed" || s.status === "blocked");
  if (!step) return null;
  const loaded = await loadTest(dir, result.file, undefined, { seed: "bench" });
  return loaded?.expanded.steps[step.index]?.origin[0]?.number ?? null;
}

type Score = "match" | "healed" | "needs_ai" | "mismatch";

interface Row {
  variant: Variant;
  test: string;
  expected: Expectation;
  verdict: string;
  cause: string | null;
  step: number | null;
  score: Score;
  note: string;
  aiCalls: number;
  heals: { withoutAi: number; needsAi: number };
  durationMs: number;
}

function score(
  variant: Variant,
  expected: Expectation,
  result: TestResult,
  heals: { withoutAi: number; needsAi: number },
): { score: Score; note: string } {
  const blockedBy = result.decidedBy.find((d) => d.kind === "blocked");
  const accepted = [
    expected.verdict,
    ...(manifest.variants[variant]?.also_accept?.[expected.verdict as "passed"] ?? []),
  ];
  if (accepted.includes(result.verdict)) {
    if (expected.cause && result.failureCause !== expected.cause)
      return {
        score: "mismatch",
        note: `cause ${result.failureCause}, expected ${expected.cause}`,
      };
    return result.verdict === "healed"
      ? { score: "healed", note: `${heals.withoutAi} heal(s) without AI` }
      : { score: "match", note: "" };
  }
  if (variant === "cosmetic" && expected.verdict === "passed") {
    const aiOnly =
      heals.needsAi > 0 ||
      (result.verdict === "blocked" &&
        blockedBy?.kind === "blocked" &&
        blockedBy.reason === "ai_unavailable");
    if (aiOnly) return { score: "needs_ai", note: result.headline ?? "needs an AI heal" };
  }
  return {
    score: "mismatch",
    note: `got ${result.verdict}${result.failureCause ? ` (${result.failureCause})` : ""}: ${result.headline ?? ""}`,
  };
}

const variants = (values.variant as Variant[] | undefined) ?? [...VARIANTS];
for (const v of variants) if (!VARIANTS.includes(v)) throw new Error(`unknown variant ${v}`);

const shop = await startShop({ variant: "correct", port: SHOP_PORT });
const booted = Date.now();
const emulator = await launchEmulator({
  onProgress: (message) => process.stdout.write(`${message}\n`),
});
process.stdout.write(`Emulator ready in ${((Date.now() - booted) / 1000).toFixed(1)}s.\n`);
const all: Row[] = [];
const times: Record<string, number> = {};
try {
  for (const variant of variants) {
    const dir = project();
    const started = Date.now();
    try {
      const run = await runTests({
        projectDir: dir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...(process.env.ANDROID_HOME ? { ANDROID_HOME: process.env.ANDROID_HOME } : {}),
          [`${ENV_PREFIX}APP`]: apkPath(variant),
          SHOP_PASSWORD: PASSWORD,
        },
        emulator,
        mode: variant === "cosmetic" ? "normal" : "replay-only",
        retries: manifest.harness.retries,
        models: null,
        video: false,
        inbox: null,
        // The manifest's harness: a fresh environment before the first attempt, a reset before a retry.
        beforeAttempt: async ({ attempt, session }) => {
          await session.hookRequest({
            method: "POST",
            target: attempt === 1 ? "/__test/reset?environment=1" : "/__test/reset",
          });
        },
      });
      times[variant] = Date.now() - started;
      if (run.run.blocked)
        throw new Error(`${variant}: the run was blocked: ${run.run.blocked.message}`);
      const rows: Row[] = [];
      for (const result of run.tests) {
        const test = result.file.replace(/^tests\//, "").replace(/\.test\.md$/, "");
        const expected = expectation(test, variant);
        const heals = run.heals[result.testId] ?? { withoutAi: 0, needsAi: 0 };
        const s = score(variant, expected, result, heals);
        const step = await failingStep(dir, result);
        rows.push({
          variant,
          test,
          expected,
          verdict: result.verdict,
          cause: result.failureCause,
          step,
          ...s,
          note:
            s.score === "match" && expected.step && step !== expected.step
              ? `failure seen at step ${step} (manifest: ${expected.step})`
              : s.note,
          aiCalls: result.ai.calls,
          heals,
          durationMs: result.durationMs,
        });
      }
      all.push(...rows);
      const bad = rows.filter((r) => r.score === "mismatch").length;
      process.stdout.write(
        `\n${variant} (${(times[variant] / 1000).toFixed(1)}s)${bad ? `: ${bad} WRONG` : ""}\n`,
      );
      for (const row of rows) {
        const expected = `${row.expected.verdict}${row.expected.cause ? `/${row.expected.cause}` : ""}`;
        const got = `${row.verdict}${row.cause && row.verdict !== "passed" ? `/${row.cause}` : ""}`;
        process.stdout.write(
          `  ${row.score.padEnd(8)} ${row.test.padEnd(16)} expected ${expected.padEnd(20)} got ${got.padEnd(20)} ${row.aiCalls} AI${row.step !== null ? `  step ${row.step}` : ""}${row.note ? `  ${row.note}` : ""}\n`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
} finally {
  await emulator.close();
  await shop.stop();
}

const counts = (s: Score) => all.filter((r) => r.score === s).length;
const cosmetic = all.filter((r) => r.variant === "cosmetic");
const summary = {
  tests: all.length,
  match: counts("match"),
  healed: counts("healed"),
  needsAi: counts("needs_ai"),
  mismatch: counts("mismatch"),
  aiCalls: all.reduce((sum, r) => sum + r.aiCalls, 0),
  cosmetic: {
    healsWithoutAi: cosmetic.reduce((sum, r) => sum + r.heals.withoutAi, 0),
    missesNeedingAi: cosmetic.reduce((sum, r) => sum + r.heals.needsAi, 0),
    testsHealed: cosmetic.filter((r) => r.score === "healed").length,
    testsNeedingAi: cosmetic.filter((r) => r.score === "needs_ai").length,
  },
  times,
};
process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
if (values.json) writeFileSync(values.json, `${JSON.stringify({ summary, rows: all }, null, 2)}\n`);
// Correct must use no AI at all (REP-3).
const aiOnCorrect = all.filter((r) => r.variant === "correct" && r.aiCalls > 0);
if (aiOnCorrect.length)
  process.stdout.write(`AI was used on correct: ${aiOnCorrect.map((r) => r.test).join(", ")}\n`);
process.exitCode = summary.mismatch > 0 || aiOnCorrect.length > 0 ? 1 : 0;
