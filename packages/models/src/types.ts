import type { z } from "zod";
import type { BudgetMeter } from "./budget.js";
import type { ModelRole } from "./config.js";

export type TextPart = { type: "text"; text: string };
/** An image, e.g. a screenshot. `data` is raw bytes or base64. */
export type ImagePart = { type: "image"; data: Uint8Array | string; mediaType: string };
export type ToolCallPart = { type: "tool-call"; id: string; name: string; input: unknown };
export type ToolResultPart = { type: "tool-result"; id: string; name: string; output: unknown };

export type ModelMessage =
  | { role: "user"; content: string | (TextPart | ImagePart)[] }
  | { role: "assistant"; content: string | (TextPart | ToolCallPart)[] }
  | { role: "tool"; content: ToolResultPart[] };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  parameters: Record<string, unknown>;
}

export interface CompletionRequest<T = unknown> {
  system?: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  /** Structured output: the reply must validate against this schema. */
  output?: z.ZodType<T>;
  maxOutputTokens?: number;
  /** Default 0. */
  temperature?: number;
  /** Per request attempt. Default `models.timeoutSeconds`. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Ask providers that support it to cache the system prompt. */
  cache?: boolean;
  /** Budgets for this call, in addition to the client's. */
  budgets?: BudgetMeter[];
  /** Copied into the call record, e.g. { test: "checkout", step: "3" }. */
  tags?: Record<string, string>;
}

export interface TokenUsage {
  /** All input tokens, including cached ones. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type AttemptOutcome =
  | "ok"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "timeout"
  | "not_found"
  | "blocked_host"
  | "auth_failed"
  | "bad_request"
  | "invalid_output"
  | "aborted"
  | "skipped_no_key"
  | "skipped_unusable"
  | "skipped_disabled"
  | "skipped_near_cap";

export interface Attempt {
  provider: string;
  model: string;
  /** 1-based try number on this entry; 0 for skipped entries. */
  attempt: number;
  outcome: AttemptOutcome;
  status?: number;
  /** Redacted detail. */
  message?: string;
  latencyMs: number;
  usage?: TokenUsage;
  costUsd?: number | null;
}

export type FailureReason =
  | "no_provider"
  | "budget_exceeded"
  | "all_providers_failed"
  | "auth_failed"
  | "invalid_output"
  | "aborted";

/** Plain, serialisable record of one `complete` call. FND-3 adds it to the results contract. */
export interface ModelCallRecord {
  id: string;
  role: ModelRole;
  startedAt: string;
  latencyMs: number;
  outcome: "ok" | FailureReason;
  /** The entry that answered (success only). */
  provider: string | null;
  model: string | null;
  /** Summed over all attempts. */
  usage: TokenUsage;
  /** Summed over all attempts; null when any attempt's cost is unknown. */
  costUsd: number | null;
  attempts: Attempt[];
  tags: Record<string, string>;
}

export interface CompletionSuccess<T> {
  ok: true;
  text: string;
  toolCalls: ToolCall[];
  /** The validated object when `output` was given. */
  object: T | undefined;
  usage: TokenUsage;
  costUsd: number | null;
  provider: string;
  model: string;
  latencyMs: number;
  attempts: Attempt[];
  record: ModelCallRecord;
}

export interface CompletionFailure {
  ok: false;
  reason: FailureReason;
  /** Plain-English explanation. */
  message: string;
  /** What to do about it. */
  fix: string;
  attempts: Attempt[];
  record: ModelCallRecord;
}

export type CompletionResult<T> = CompletionSuccess<T> | CompletionFailure;
