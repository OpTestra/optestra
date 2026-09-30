import type { BenchRow } from "./score.js";

// The BEN-2 numbers, from scored rows. The definitions are pinned in
// metrics.test.ts; change them only with a note in bench/README.md.
//
// - pass-like: `passed` or `healed` (a heal is a pass that changed how, not what).
// - false pass: the manifest says the test must NOT pass (failed, flaky or
//   blocked) and it passed or healed. The headline number (BEN-2, section 10).
// - false fail: the manifest says it passes, and it ended failed or blocked,
//   except a cosmetic miss only an AI heal could fix in a run with no model
//   ("needs AI": reported on its own, never hidden in either rate).
// - flake: over the reruns of `correct`, a test is flaky when any rerun's
//   verdict is `flaky` or its verdicts differ between reruns.
// - replay hit rate: action steps done exactly as recorded (no heal, no AI) /
//   action steps that ran, on `correct` (unchanged app) and on `cosmetic`,
//   where steps re-found without AI count separately.
// The false pass/fail rates use each variant's first run only; reruns of
// `correct` feed the flake rate and the replay timing.

export const PASS_LIKE: ReadonlySet<string> = new Set(["passed", "healed"]);

export interface Rate {
  count: number;
  of: number;
  /** count / of, 0 when `of` is 0. Never rounded here: formatting rounds. */
  rate: number;
}

const rate = (count: number, of: number): Rate => ({ count, of, rate: of === 0 ? 0 : count / of });

export interface FixtureMetrics {
  /** Rows scored (first run of each variant). */
  scored: number;
  falsePass: Rate & { cases: string[] };
  falseFail: Rate & { cases: string[] };
  /** Wrong in another way (wrong cause, blocked instead of failed…). */
  otherMismatches: string[];
  needsAi: number;
  flake: Rate & { reruns: number; flakyRuns: number; cases: string[] };
  replay: {
    /** On `correct`: steps replayed as recorded / steps that ran. */
    hitRate: Rate;
    /** AI calls on `correct` over every rerun (REP-3: must be 0). */
    aiCallsOnCorrect: number;
    /** Median over reruns of the summed test durations on `correct`. */
    medianMs: number;
  };
  cosmetic: {
    /** Steps replayed as recorded / steps that ran. */
    hitRate: Rate;
    /** Steps done without AI (as recorded or re-found) / steps that ran. */
    noAiRate: Rate;
    /** Tests that passed or healed with no AI and no re-recording / cosmetic tests. */
    passedWithoutRerecording: Rate;
    healsWithoutAi: number;
  } | null;
  /** Every scored run (all variants, first runs): AI calls and cost. */
  ai: { calls: number; costUsd: number };
  equivalence: { compared: number; disagree: number; cases: string[] } | null;
}

const label = (r: BenchRow) => `${r.variant}/${r.test}`;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/** A false pass: must not pass, passed (or healed). */
export function isFalsePass(row: Pick<BenchRow, "expected" | "verdict">): boolean {
  return !PASS_LIKE.has(row.expected.verdict) && PASS_LIKE.has(row.verdict);
}

/** A false fail: must pass, ended failed or blocked (a no-model "needs AI" miss excepted). */
export function isFalseFail(row: Pick<BenchRow, "expected" | "verdict" | "score">): boolean {
  return (
    PASS_LIKE.has(row.expected.verdict) &&
    (row.verdict === "failed" || row.verdict === "blocked") &&
    row.score !== "needs_ai"
  );
}

export function fixtureMetrics(
  rows: readonly BenchRow[],
  equivalence?: readonly { variant: string; test: string; agree: boolean }[],
): FixtureMetrics {
  const scored = rows.filter((r) => r.rerun === 1);
  const mustFail = scored.filter((r) => !PASS_LIKE.has(r.expected.verdict));
  const mustPass = scored.filter((r) => PASS_LIKE.has(r.expected.verdict));
  const falsePasses = scored.filter(isFalsePass);
  const falseFails = scored.filter(isFalseFail);
  const other = scored.filter((r) => r.score === "mismatch" && !isFalsePass(r) && !isFalseFail(r));

  const correct = rows.filter((r) => r.variant === "correct");
  const reruns = Math.max(0, ...correct.map((r) => r.rerun));
  const byTest = new Map<string, BenchRow[]>();
  for (const row of correct) byTest.set(row.test, [...(byTest.get(row.test) ?? []), row]);
  const flaky = [...byTest.entries()].filter(
    ([, runs]) =>
      runs.some((r) => r.verdict === "flaky") || new Set(runs.map((r) => r.verdict)).size > 1,
  );
  const perRerun = new Map<number, number>();
  for (const row of correct)
    perRerun.set(row.rerun, (perRerun.get(row.rerun) ?? 0) + row.durationMs);

  const firstCorrect = correct.filter((r) => r.rerun === 1);
  const sum = (list: readonly BenchRow[], pick: (s: BenchRow["steps"]) => number) =>
    list.reduce((n, r) => n + pick(r.steps), 0);
  const cosmeticRows = scored.filter((r) => r.variant === "cosmetic");
  const cosmeticRan = sum(cosmeticRows, (s) => s.ran);

  return {
    scored: scored.length,
    falsePass: { ...rate(falsePasses.length, mustFail.length), cases: falsePasses.map(label) },
    falseFail: { ...rate(falseFails.length, mustPass.length), cases: falseFails.map(label) },
    otherMismatches: other.map((r) => `${label(r)}: ${r.note}`),
    needsAi: scored.filter((r) => r.score === "needs_ai").length,
    flake: {
      ...rate(flaky.length, byTest.size),
      reruns,
      flakyRuns: correct.filter((r) => r.verdict === "flaky").length,
      cases: flaky.map(([test]) => test),
    },
    replay: {
      hitRate: rate(
        sum(firstCorrect, (s) => s.replayed),
        sum(firstCorrect, (s) => s.ran),
      ),
      aiCallsOnCorrect: correct.reduce((n, r) => n + r.aiCalls, 0),
      medianMs: median([...perRerun.values()]),
    },
    cosmetic:
      cosmeticRows.length === 0
        ? null
        : {
            hitRate: rate(
              sum(cosmeticRows, (s) => s.replayed),
              cosmeticRan,
            ),
            noAiRate: rate(
              sum(cosmeticRows, (s) => s.replayed + s.refound),
              cosmeticRan,
            ),
            passedWithoutRerecording: rate(
              cosmeticRows.filter((r) => PASS_LIKE.has(r.verdict) && r.aiCalls === 0).length,
              cosmeticRows.length,
            ),
            healsWithoutAi: cosmeticRows.reduce((n, r) => n + r.heals.withoutAi, 0),
          },
    ai: {
      calls: scored.reduce((n, r) => n + r.aiCalls, 0),
      costUsd: scored.reduce((n, r) => n + r.costUsd, 0),
    },
    equivalence: equivalence
      ? {
          compared: equivalence.length,
          disagree: equivalence.filter((e) => !e.agree).length,
          cases: equivalence.filter((e) => !e.agree).map((e) => `${e.variant}/${e.test}`),
        }
      : null,
  };
}

/** Several fixtures as one: counts add up, rates are recomputed from them. */
export function totalMetrics(all: readonly FixtureMetrics[]): {
  falsePass: Rate;
  falseFail: Rate;
  flake: Rate;
  replayHitRate: Rate;
  cosmeticNoAiRate: Rate | null;
  needsAi: number;
  otherMismatches: number;
  aiCalls: number;
  costUsd: number;
} {
  const add = (pick: (m: FixtureMetrics) => Rate | null | undefined) => {
    let count = 0;
    let of = 0;
    for (const m of all) {
      const r = pick(m);
      if (!r) continue;
      count += r.count;
      of += r.of;
    }
    return rate(count, of);
  };
  const cosmetic = all.some((m) => m.cosmetic) ? add((m) => m.cosmetic?.noAiRate) : null;
  return {
    falsePass: add((m) => m.falsePass),
    falseFail: add((m) => m.falseFail),
    flake: add((m) => m.flake),
    replayHitRate: add((m) => m.replay.hitRate),
    cosmeticNoAiRate: cosmetic,
    needsAi: all.reduce((n, m) => n + m.needsAi, 0),
    otherMismatches: all.reduce((n, m) => n + m.otherMismatches.length, 0),
    aiCalls: all.reduce((n, m) => n + m.ai.calls, 0),
    costUsd: all.reduce((n, m) => n + m.ai.costUsd, 0),
  };
}
