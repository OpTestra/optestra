// bench:replay (LOOP-4): `run` on every shop variant with the committed
// recordings, scored against the gold manifest (verdict + cause).
//
//   node packages/core/bench/replay.ts [--variant correct …] [--equivalence] [--json out.json]
//
// Every variant runs --replay-only (no AI at all), except `cosmetic`, which runs
// in normal mode without an AI model: heals without AI are expected there
// (`healed` or `passed` both count), and a miss only an AI heal could fix is
// counted as "needs AI", not as a wrong answer.
//
// --equivalence (the LOOP-3 promise): for correct, broken-total and
// broken-silent-click, the replay verdict and the generated spec's
// plain-Playwright verdict must agree per test.
//
// Email tests read their code from a test inbox (AUTH-1): a real Mailpit when one
// answers at MAILPIT_URL (default http://127.0.0.1:8025; the shop then sends over
// MAILPIT_SMTP, default 127.0.0.1:1025), else the shop's own outbox read in
// process. REQUIRE_MAILPIT=1 (CI) makes a missing Mailpit an error. The generated
// specs can only read Mailpit, so without it their email tests aren't compared.
//
// The scoring is Bench's (`@testament/core/bench`, the same as the CLI's `bench`);
// this script keeps CI's per-row output and its gates.

import { rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { TestResult } from "@testament/contract";
import {
  type BenchRow,
  EQUIVALENCE_VARIANTS,
  emailTests,
  MAILPIT_URL,
  mailpitRunning,
  rowsOf,
  runShopVariant,
  shopFixture,
  specShop,
} from "@testament/core/bench";

/** The perf smoke (PERF-0): replay of the correct shop may take at most this many times the specs. */
const MAX_REPLAY_RATIO = 2;

const { values } = parseArgs({
  options: {
    variant: { type: "string", multiple: true },
    equivalence: { type: "boolean" },
    json: { type: "string" },
  },
});

const shop = await shopFixture();
const useMailpit = await mailpitRunning();
if (!useMailpit && process.env.REQUIRE_MAILPIT)
  throw new Error(`Mailpit is not running at ${MAILPIT_URL} (REQUIRE_MAILPIT is set).`);
process.stdout.write(
  useMailpit
    ? `Email tests read Mailpit at ${MAILPIT_URL}.\n`
    : `Mailpit isn't running at ${MAILPIT_URL}: email tests read the shop's outbox in process, and their generated specs aren't compared.\n`,
);

async function replayVariant(variant: string) {
  const { run, ms, dir } = await runShopVariant(shop, variant, { useMailpit, keep: true });
  try {
    return {
      rows: await rowsOf("shop", shop.manifest, variant, 1, run, dir),
      ms,
      results: run.tests,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const variants = values.variant ?? [...shop.variants];
for (const v of variants) if (!shop.variants.includes(v)) throw new Error(`unknown variant ${v}`);
const all: BenchRow[] = [];
const times: Record<string, number> = {};
const replayed = new Map<string, TestResult[]>();
for (const variant of variants) {
  const { rows, ms, results } = await replayVariant(variant);
  times[variant] = ms;
  replayed.set(variant, results);
  all.push(...rows);
  const bad = rows.filter((r) => r.score === "mismatch").length;
  process.stdout.write(`\n${variant} (${(ms / 1000).toFixed(1)}s)${bad ? `: ${bad} WRONG` : ""}\n`);
  for (const row of rows) {
    const expected = `${row.expected.verdict}${row.expected.cause ? `/${row.expected.cause}` : ""}`;
    const got = `${row.verdict}${row.cause && row.verdict !== "passed" ? `/${row.cause}` : ""}`;
    process.stdout.write(
      `  ${row.score.padEnd(8)} ${row.test.padEnd(22)} expected ${expected.padEnd(22)} got ${got.padEnd(22)} ${row.aiCalls} AI${row.note ? `  ${row.note}` : ""}\n`,
    );
  }
}

const equivalence: {
  variant: string;
  test: string;
  replay: string;
  spec: string;
  agree: boolean;
}[] = [];
let perf: { tests: number; replayMs: number; specMs: number; ratio: number } | undefined;
if (values.equivalence) {
  process.stdout.write("\nEquivalence (replay vs the generated plain-Playwright spec)\n");
  const email = await emailTests(shop);
  for (const variant of EQUIVALENCE_VARIANTS) {
    let results = replayed.get(variant);
    if (!results) {
      const replay = await replayVariant(variant);
      results = replay.results;
      times[variant] = replay.ms;
    }
    const started = Date.now();
    const specRun = await specShop(shop, variant, useMailpit);
    const spec = specRun.verdicts;
    times[`${variant} (spec)`] = Date.now() - started;
    if (variant === "correct") {
      // The perf smoke: the same tests, replay vs plain Playwright (each test's own time).
      const same = results.filter((r) => spec[r.name] !== undefined && spec[r.name] !== "blocked");
      const replayMs = same.reduce((sum, r) => sum + r.durationMs, 0);
      const specMs = same.reduce((sum, r) => sum + (specRun.durations[r.name] ?? 0), 0);
      perf = { tests: same.length, replayMs, specMs, ratio: specMs > 0 ? replayMs / specMs : 0 };
    }
    for (const result of results) {
      // Retries aside: the first attempt is what a single plain run compares with.
      const first = result.attempts[0]?.status ?? "blocked";
      const replay =
        result.verdict === "blocked" ? "blocked" : first === "passed" ? "passed" : "failed";
      const plain = spec[result.name] ?? "missing";
      // Without Mailpit a generated spec can't read the email (it skips): nothing to compare.
      if (!useMailpit && plain === "blocked" && email.has(result.file)) {
        process.stdout.write(
          `  skipped  ${variant.padEnd(20)} ${result.name.padEnd(62)} (its spec needs Mailpit)\n`,
        );
        continue;
      }
      const agree = replay === plain;
      equivalence.push({ variant, test: result.name, replay, spec: plain, agree });
      process.stdout.write(
        `  ${agree ? "agree   " : "DISAGREE"} ${variant.padEnd(20)} ${result.name.padEnd(62)} replay ${replay.padEnd(8)} spec ${plain}\n`,
      );
    }
  }
}

const counts = (score: BenchRow["score"]) => all.filter((r) => r.score === score).length;
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
  equivalence: {
    compared: equivalence.length,
    disagree: equivalence.filter((e) => !e.agree).length,
  },
  times,
  ...(perf ? { perf } : {}),
};
process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
if (values.json)
  writeFileSync(values.json, `${JSON.stringify({ summary, rows: all, equivalence }, null, 2)}\n`);
// Correct must use no AI at all (REP-3).
const aiOnCorrect = all.filter((r) => r.variant === "correct" && r.aiCalls > 0);
if (aiOnCorrect.length)
  process.stdout.write(`AI was used on correct: ${aiOnCorrect.map((r) => r.test).join(", ")}\n`);
// PERF-0: a replay much slower than plain Playwright is a regression.
const tooSlow = perf !== undefined && perf.ratio > MAX_REPLAY_RATIO;
if (perf)
  process.stdout.write(
    `Replay of correct: ${(perf.replayMs / 1000).toFixed(2)}s vs ${(perf.specMs / 1000).toFixed(2)}s as plain Playwright (${perf.ratio.toFixed(2)}×, at most ${MAX_REPLAY_RATIO}×)${tooSlow ? ": TOO SLOW" : ""}\n`,
  );
process.exitCode =
  summary.mismatch > 0 || summary.equivalence.disagree > 0 || aiOnCorrect.length > 0 || tooSlow
    ? 1
    : 0;
