import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_FILE, RUNS_DIR } from "@optestra/contract";

// LRN-5: AI use per test over its last runs ("used AI 0 times in its last 20
// runs"), from the project's previous run folders. Only run.json is read.

export const RECENT_RUNS = 20;

export interface RecentAi {
  runs: number;
  calls: number;
}

interface RunRow {
  testId: string;
  aiCalls: number;
}

/** AI calls per test in the project's last `limit` finished runs (not counting `exclude`). */
export function recentAiUsage(
  dataDir: string,
  options: { exclude?: string; limit?: number } = {},
): Map<string, RecentAi> {
  const dir = join(dataDir, RUNS_DIR);
  const usage = new Map<string, RecentAi>();
  if (!existsSync(dir)) return usage;
  const runIds = readdirSync(dir)
    .filter((name) => name !== options.exclude && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name))
    .sort()
    .reverse();
  let read = 0;
  for (const runId of runIds) {
    if (read >= (options.limit ?? RECENT_RUNS)) break;
    let tests: RunRow[];
    try {
      const run = JSON.parse(readFileSync(join(dir, runId, RUN_FILE), "utf8")) as {
        tests?: RunRow[];
      };
      tests = Array.isArray(run.tests) ? run.tests : [];
    } catch {
      continue; // unfinished or unreadable run
    }
    read++;
    for (const row of tests) {
      if (typeof row.testId !== "string" || typeof row.aiCalls !== "number") continue;
      const entry = usage.get(row.testId) ?? { runs: 0, calls: 0 };
      entry.runs++;
      entry.calls += row.aiCalls;
      usage.set(row.testId, entry);
    }
  }
  return usage;
}

interface HealRow {
  testId: string;
  verdict: string;
}

/**
 * HEAL-7: how many of each test's last `limit` finished runs (not counting
 * `exclude`) ended healed. The runner adds the current run on top.
 */
export function recentHeals(
  dataDir: string,
  options: { exclude?: string; limit?: number } = {},
): Map<string, { runs: number; healed: number }> {
  const dir = join(dataDir, RUNS_DIR);
  const heals = new Map<string, { runs: number; healed: number }>();
  if (!existsSync(dir)) return heals;
  const runIds = readdirSync(dir)
    .filter((name) => name !== options.exclude && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name))
    .sort()
    .reverse();
  const limit = options.limit ?? 10;
  for (const runId of runIds) {
    let tests: HealRow[];
    try {
      const run = JSON.parse(readFileSync(join(dir, runId, RUN_FILE), "utf8")) as {
        tests?: HealRow[];
      };
      tests = Array.isArray(run.tests) ? run.tests : [];
    } catch {
      continue; // unfinished or unreadable run
    }
    for (const row of tests) {
      if (typeof row.testId !== "string") continue;
      const entry = heals.get(row.testId) ?? { runs: 0, healed: 0 };
      if (entry.runs >= limit) continue;
      entry.runs++;
      if (row.verdict === "healed") entry.healed++;
      heals.set(row.testId, entry);
    }
  }
  return heals;
}

/**
 * Each test's verdicts in its last `limit` finished runs, most recent first
 * (not counting `exclude`), with the headline as its failure signature: the
 * history flaky_or_real reads (DIA-5).
 */
export function recentVerdicts(
  dataDir: string,
  options: { exclude?: string; limit?: number } = {},
): Map<string, { verdict: string; signature: string | null }[]> {
  const dir = join(dataDir, RUNS_DIR);
  const out = new Map<string, { verdict: string; signature: string | null }[]>();
  if (!existsSync(dir)) return out;
  const runIds = readdirSync(dir)
    .filter((name) => name !== options.exclude && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name))
    .sort()
    .reverse();
  const limit = options.limit ?? 20;
  for (const runId of runIds) {
    let tests: { testId?: unknown; verdict?: unknown; headline?: unknown }[];
    try {
      const run = JSON.parse(readFileSync(join(dir, runId, RUN_FILE), "utf8")) as {
        tests?: typeof tests;
      };
      tests = Array.isArray(run.tests) ? run.tests : [];
    } catch {
      continue;
    }
    for (const row of tests) {
      if (typeof row.testId !== "string" || typeof row.verdict !== "string") continue;
      const list = out.get(row.testId) ?? [];
      if (list.length >= limit) continue;
      list.push({
        verdict: row.verdict,
        signature: typeof row.headline === "string" ? row.headline : null,
      });
      out.set(row.testId, list);
    }
  }
  return out;
}
