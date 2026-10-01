import type { ModelCall } from "@optestra/contract";
import type { ModelCallRecord } from "./types.js";

/**
 * The results-contract form of a call record. The contract owns this shape;
 * producers write run folders and events with it. The richer `ModelCallRecord`
 * (per-attempt detail, tags) stays available for debugging.
 */
export function toModelCall(record: ModelCallRecord): ModelCall {
  return {
    id: record.id,
    role: record.role,
    provider: record.provider,
    model: record.model,
    startedAt: record.startedAt,
    tokens: {
      input: record.usage.inputTokens,
      output: record.usage.outputTokens,
      cached: record.usage.cachedInputTokens,
      cacheWrite: record.usage.cacheWriteTokens,
    },
    costUsd: record.costUsd,
    latencyMs: record.latencyMs,
    attempts: record.attempts.filter((attempt) => attempt.attempt > 0).length,
    outcome: record.outcome,
    billing: record.billing,
  };
}
