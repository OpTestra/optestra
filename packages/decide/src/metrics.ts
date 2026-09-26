import type { DecisionRecord } from "@testament/contract";

/** Per-task counters, for the report and for judging whether a backend or task earns its keep. */
export interface TaskMetrics {
  total: number;
  /** Decided by the rules. */
  rules: number;
  /** Decided by a decision model (including cache hits). */
  model: number;
  escalated: number;
  /** Model answers served from the cache. Null when unknown (read back from a run folder). */
  cacheHits: number | null;
  /** Shares of `total`, 0–100, one decimal. */
  rulesPct: number;
  modelPct: number;
  escalatedPct: number;
  p50Ms: number;
  p95Ms: number;
}

export type DecisionMetrics = Record<string, TaskMetrics>;

/** Nearest-rank percentile of sorted values; 0 for none. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

const pct = (part: number, total: number) =>
  total === 0 ? 0 : Math.round((part / total) * 1000) / 10;

function finish(
  total: number,
  rules: number,
  model: number,
  escalated: number,
  cacheHits: number | null,
  latencies: number[],
): TaskMetrics {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    total,
    rules,
    model,
    escalated,
    cacheHits,
    rulesPct: pct(rules, total),
    modelPct: pct(model, total),
    escalatedPct: pct(escalated, total),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
  };
}

/** Metrics from contract records (e.g. read back from a run folder). Cache hits aren't recorded there. */
export function metricsFromRecords(records: readonly DecisionRecord[]): DecisionMetrics {
  const byTask = new Map<string, DecisionRecord[]>();
  for (const record of records)
    byTask.set(record.task, [...(byTask.get(record.task) ?? []), record]);
  const out: DecisionMetrics = {};
  for (const [task, list] of [...byTask].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const escalated = list.filter((r) => r.escalated).length;
    const rules = list.filter((r) => !r.escalated && r.source === "rules").length;
    out[task] = finish(
      list.length,
      rules,
      list.length - escalated - rules,
      escalated,
      null,
      list.map((r) => r.latencyMs),
    );
  }
  return out;
}

/** Live counters kept by a `Decisions` instance. */
export class MetricsCollector {
  readonly #tasks = new Map<
    string,
    { rules: number; model: number; escalated: number; cacheHits: number; latencies: number[] }
  >();

  add(
    task: string,
    outcome: "rules" | "model" | "escalated",
    latencyMs: number,
    cacheHit: boolean,
  ) {
    let entry = this.#tasks.get(task);
    if (!entry) {
      entry = { rules: 0, model: 0, escalated: 0, cacheHits: 0, latencies: [] };
      this.#tasks.set(task, entry);
    }
    entry[outcome]++;
    if (cacheHit) entry.cacheHits++;
    // Bounded: percentiles over the most recent 10k decisions per task.
    if (entry.latencies.length >= 10_000) entry.latencies.shift();
    entry.latencies.push(latencyMs);
  }

  snapshot(): DecisionMetrics {
    const out: DecisionMetrics = {};
    for (const [task, e] of [...this.#tasks].sort(([a], [b]) => (a < b ? -1 : 1))) {
      out[task] = finish(
        e.rules + e.model + e.escalated,
        e.rules,
        e.model,
        e.escalated,
        e.cacheHits,
        e.latencies,
      );
    }
    return out;
  }
}
