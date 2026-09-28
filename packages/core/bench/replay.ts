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

import { rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { TestResult } from "@testament/contract";
import { VARIANTS, type Variant } from "@testament/fixture-shop";
import { loadTest } from "@testament/spec/node";
import {
  type Expectation,
  MAILPIT_URL,
  mailpitRunning,
  manifest,
  replayShop,
  SHOP,
  specShop,
} from "./shop.ts";

const EQUIVALENCE_VARIANTS: Variant[] = ["correct", "broken-total", "broken-silent-click"];
/** The perf smoke (PERF-0): replay of the correct shop may take at most this many times the specs. */
const MAX_REPLAY_RATIO = 2;

const { values } = parseArgs({
  options: {
    variant: { type: "string", multiple: true },
    equivalence: { type: "boolean" },
    json: { type: "string" },
  },
});

const useMailpit = await mailpitRunning();
if (!useMailpit && process.env.REQUIRE_MAILPIT)
  throw new Error(`Mailpit is not running at ${MAILPIT_URL} (REQUIRE_MAILPIT is set).`);
process.stdout.write(
  useMailpit
    ? `Email tests read Mailpit at ${MAILPIT_URL}.\n`
    : `Mailpit isn't running at ${MAILPIT_URL}: email tests read the shop's outbox in process, and their generated specs aren't compared.\n`,
);

const expectation = (test: string, variant: string): Expectation => {
  const entry = manifest.tests[test]?.[variant];
  if (entry === undefined) throw new Error(`manifest has no answer for ${test} × ${variant}`);
  return typeof entry === "string" ? { verdict: entry } : entry;
};

/** The .test.md step number where the final (or first failing) attempt stopped. */
async function failingStep(dir: string, result: TestResult): Promise<number | null> {
  const attempt =
    result.attempts.find((a) => a.status !== "passed") ?? result.attempts.at(-1) ?? null;
  if (!attempt) return null;
  const step = attempt.steps.find((s) => s.status === "failed" || s.status === "blocked");
  if (!step) return null;
  // The test's auth: profile login is step 0 in the manifest (it runs before step 1).
  if (step.kind === "flow" && step.text.startsWith("auth: ")) return 0;
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

async function replayVariant(
  variant: Variant,
): Promise<{ rows: Row[]; ms: number; results: TestResult[] }> {
  const { run, ms, dir } = await replayShop(variant, { useMailpit, keep: true });
  try {
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
    return { rows, ms, results: run.tests };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

/** Tests that read an email (their recordings type {{inbox.…}}). */
const readsEmail = new Set(
  (
    await Promise.all(
      Object.keys(manifest.tests).map(async (name) => {
        const loaded = await loadTest(SHOP, `tests/${name}.test.md`, undefined, { seed: "bench" });
        return loaded &&
          /\binbox\b|verification email/i.test(loaded.expanded.steps.map((s) => s.text).join("\n"))
          ? `tests/${name}.test.md`
          : null;
      }),
    )
  ).filter((f): f is string => f !== null),
);

const variants = (values.variant as Variant[] | undefined) ?? [...VARIANTS];
for (const v of variants) if (!VARIANTS.includes(v)) throw new Error(`unknown variant ${v}`);
const all: Row[] = [];
const times: Record<string, number> = {};
const equivalence: {
  variant: string;
  test: string;
  replay: string;
  spec: string;
  agree: boolean;
}[] = [];
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

let perf: { tests: number; replayMs: number; specMs: number; ratio: number } | undefined;
if (values.equivalence) {
  process.stdout.write("\nEquivalence (replay vs the generated plain-Playwright spec)\n");
  for (const variant of EQUIVALENCE_VARIANTS) {
    let results = replayed.get(variant);
    if (!results) {
      const replay = await replayVariant(variant);
      results = replay.results;
      times[variant] = replay.ms;
    }
    const started = Date.now();
    const specRun = await specShop(variant, useMailpit);
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
      if (!useMailpit && plain === "blocked" && readsEmail.has(result.file)) {
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

const counts = (score: Score) => all.filter((r) => r.score === score).length;
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
