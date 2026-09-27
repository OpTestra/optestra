import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_FILE, RUNS_DIR } from "@testament/contract";

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
