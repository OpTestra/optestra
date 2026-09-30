import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { brand } from "@testament/brand";
import type { TestResult } from "@testament/contract";
import { version } from "../index.js";
import {
  androidFixture,
  emailTests,
  mailpitRunning,
  rowsOf,
  runAndroidVariants,
  runShopVariant,
  shopFixture,
  specShop,
} from "./fixtures.js";
import { fixtureMetrics } from "./metrics.js";
import {
  type BenchReport,
  buildReport,
  type FirstRun,
  type FixtureReport,
  type MeasuredWith,
} from "./report.js";
import type { BenchRow, FixtureId } from "./score.js";

// `testament bench` (BEN-2): every variant of the chosen fixtures, N reruns of
// `correct` for the flake rate, replay vs spec equivalence on the shop, and the
// numbers with how they were measured. Replay only, no AI: first-run (authoring)
// cost comes from the latest committed model eval (bench/results).

export type FixtureChoice = "shop" | "android" | "all";

export interface BenchOptions {
  fixture?: FixtureChoice;
  /** Runs of `correct` (the first counts; default 10, BEN-2). */
  reruns?: number;
  /** Only these variants (default: all of each fixture's). */
  variants?: readonly string[];
  /** Compare the shop's replay with its generated specs (default true). */
  equivalence?: boolean;
  /** Progress lines. */
  onProgress?: (line: string) => void;
  /** The command line that reproduces the run (for the report). */
  command?: string;
  now?: () => Date;
}

export const EQUIVALENCE_VARIANTS = ["correct", "broken-total", "broken-silent-click"];

/** The engine's git commit (short), read from .git without running git; null outside a checkout. */
export function engineCommit(start: string): string | null {
  try {
    let dir = resolve(start);
    while (!existsSync(join(dir, ".git"))) {
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
    let git = join(dir, ".git");
    if (statSync(git).isFile()) {
      // A worktree: ".git" names the real folder.
      const pointer = readFileSync(git, "utf8")
        .match(/^gitdir:\s*(.+)$/m)?.[1]
        ?.trim();
      if (!pointer) return null;
      git = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
    }
    const head = readFileSync(join(git, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*(.+)$/)?.[1];
    if (!ref) return head.slice(0, 7);
    // Refs live in the common dir for worktrees.
    const common = existsSync(join(git, "commondir"))
      ? resolve(git, readFileSync(join(git, "commondir"), "utf8").trim())
      : git;
    for (const base of [git, common]) {
      const file = join(base, ref);
      if (existsSync(file)) return readFileSync(file, "utf8").trim().slice(0, 7);
    }
    const packed = join(common, "packed-refs");
    if (existsSync(packed)) {
      const line = readFileSync(packed, "utf8")
        .split("\n")
        .find((l) => l.endsWith(` ${ref}`));
      if (line) return line.slice(0, 7);
    }
    return null;
  } catch {
    return null;
  }
}

/** The newest model eval result for a fixture (bench/results), as first-run numbers. */
export function latestFirstRun(benchDir: string, fixture: FixtureId): FirstRun | null {
  const dir = join(benchDir, "results");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        date?: string;
        fixture?: string;
        scripted?: boolean;
        models?: {
          model: string;
          authoring: {
            tests: number;
            durationMs: number;
            aiCalls: number;
            costUsd: number;
            subscriptionCalls: number;
          };
        }[];
      };
      if (data.fixture !== fixture || data.scripted || !data.models?.length) continue;
      const first = data.models[0];
      if (!first) continue;
      return {
        source: `bench/results/${file}`,
        model: first.model,
        date: data.date ?? "",
        ...first.authoring,
      };
    } catch {
      // An unreadable results file is skipped, never guessed at.
    }
  }
  return null;
}

export async function runBench(options: BenchOptions = {}): Promise<BenchReport> {
  const say = options.onProgress ?? (() => {});
  const choice = options.fixture ?? "shop";
  const reruns = Math.max(1, Math.floor(options.reruns ?? 10));
  const shop = await shopFixture();
  const useMailpit = await mailpitRunning();
  const fixtures: Partial<Record<FixtureId, FixtureReport>> = {};
  const pick = (all: readonly string[]) =>
    options.variants?.length ? all.filter((v) => options.variants?.includes(v)) : [...all];

  if (choice === "shop" || choice === "all") {
    const variants = pick(shop.variants);
    say(
      useMailpit
        ? "shop: email tests read Mailpit."
        : "shop: Mailpit isn't running: email tests read the shop's outbox, and their specs aren't compared.",
    );
    const rows: BenchRow[] = [];
    const times: Record<string, number> = {};
    const firstResults = new Map<string, TestResult[]>();
    for (const variant of variants) {
      const runs = variant === "correct" ? reruns : 1;
      for (let rerun = 1; rerun <= runs; rerun++) {
        const { run, ms, dir } = await runShopVariant(shop, variant, { useMailpit, keep: true });
        try {
          if (rerun === 1) {
            times[variant] = ms;
            firstResults.set(variant, run.tests);
          }
          const scored = await rowsOf("shop", shop.manifest, variant, rerun, run, dir);
          rows.push(...scored);
          const wrong = scored.filter((r) => r.score === "mismatch").length;
          say(
            `shop ${variant}${runs > 1 ? ` (run ${rerun}/${runs})` : ""}: ${(ms / 1000).toFixed(1)}s${wrong ? `, ${wrong} WRONG` : ""}`,
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
    let equivalence: { variant: string; test: string; agree: boolean }[] | undefined;
    if (options.equivalence ?? true) {
      equivalence = [];
      const email = await emailTests(shop);
      for (const variant of EQUIVALENCE_VARIANTS.filter((v) => variants.includes(v))) {
        const spec = await specShop(shop, variant, useMailpit);
        for (const result of firstResults.get(variant) ?? []) {
          const first = result.attempts[0]?.status ?? "blocked";
          const replay =
            result.verdict === "blocked" ? "blocked" : first === "passed" ? "passed" : "failed";
          const plain = spec.verdicts[result.name] ?? "missing";
          // Without Mailpit a generated spec can't read the email (it skips): nothing to compare.
          if (!useMailpit && plain === "blocked" && email.has(result.file)) continue;
          equivalence.push({ variant, test: result.name, agree: replay === plain });
        }
        say(`shop ${variant}: generated specs compared (${(spec.ms / 1000).toFixed(1)}s)`);
      }
    }
    fixtures.shop = {
      status: "ran",
      variants,
      tests: Object.keys(shop.manifest.tests).length,
      times,
      metrics: fixtureMetrics(rows, equivalence),
      rows,
      firstRun: latestFirstRun(shop.benchDir, "shop"),
    };
  }

  if (choice === "android" || choice === "all") {
    const available = await androidFixture();
    if (!available.ok) {
      say(`android: skipped: ${available.reason}`);
      fixtures.android = {
        status: "skipped",
        reason: available.reason,
        variants: [],
        tests: 0,
        times: {},
      };
    } else {
      const android = available.fixture;
      const variants = pick(android.variants);
      const order = variants.flatMap((v) => (v === "correct" ? Array(reruns).fill(v) : [v]));
      const rows: BenchRow[] = [];
      const times: Record<string, number> = {};
      const seen = new Map<string, number>();
      await runAndroidVariants(
        android,
        shop.module,
        order,
        async (variant, run, ms, dir) => {
          const rerun = (seen.get(variant) ?? 0) + 1;
          seen.set(variant, rerun);
          if (rerun === 1) times[variant] = ms;
          rows.push(...(await rowsOf("android", android.manifest, variant, rerun, run, dir)));
          say(
            `android ${variant}${variant === "correct" ? ` (run ${rerun}/${reruns})` : ""}: ${(ms / 1000).toFixed(1)}s`,
          );
        },
        say,
      );
      fixtures.android = {
        status: "ran",
        variants,
        tests: Object.keys(android.manifest.tests).length,
        times,
        metrics: fixtureMetrics(rows),
        rows,
        firstRun: latestFirstRun(shop.benchDir, "android"),
      };
    }
  }

  const measured: MeasuredWith = {
    date: (options.now?.() ?? new Date()).toISOString(),
    engineVersion: version(),
    commit: engineCommit(shop.benchDir),
    os: `${process.platform} ${process.arch}`,
    node: process.version,
    reruns,
    models: "none (replay only, no AI)",
    command: options.command ?? `${brand.cliName} bench --fixture ${choice} --reruns ${reruns}`,
  };
  return buildReport(measured, fixtures);
}
