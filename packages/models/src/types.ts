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

export type { WaitInfo, WaitReason } from "./limits.js";

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
  /** The provider's prepaid credit or the key's spend limit is used up (HTTP 402). */
  | "out_of_credit"
  | "bad_request"
  | "invalid_output"
  | "aborted"
  | "skipped_no_key"
  | "skipped_unusable"
  | "skipped_disabled"
  | "skipped_near_cap"
  /** Delegated CLI: the vendor says the subscription's usage limit is reached. */
  | "plan_limit"
  /** Delegated CLI: not installed, too old, or couldn't start. */
  | "cli_unavailable"
  /** Delegated CLI: this run used its allowance of calls (models.delegatedCallsPerRun). */
  | "skipped_call_cap";

/** How a call is paid for: an API key, or the user's own subscription through its CLI (MOD-6). */
export type Billing = "api" | "subscription";

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
  /** What the call cost: the provider's reported cost when it gives one, else the list price. */
  costUsd?: number | null;
  /** At list price (prices.yaml); null when the price is unknown. */
  listCostUsd?: number | null;
  billing?: Billing;
  /**
   * The provider's own figure: OpenRouter's `usage.cost` (what it charged), or a
   * delegated CLI's estimate (information only, never charged).
   */
  reportedCostUsd?: number;
  /** Time spent waiting before this try: a free slot, or a rate limit's Retry-After. */
  waitMs?: number;
}

export type FailureReason =
  | "no_provider"
  | "budget_exceeded"
  | "all_providers_failed"
  | "auth_failed"
  | "invalid_output"
  | "aborted";

/** Plain, serialisable record of one `complete` call. Convert with `toModelCall` for the results contract. */
export interface ModelCallRecord {
  id: string;
  role: ModelRole;
  startedAt: string;
  /** Time spent talking to providers; waits are not included (see waitMs). */
  latencyMs: number;
  /** Time spent waiting for a provider slot or a rate limit, summed over attempts. */
  waitMs: number;
  outcome: "ok" | FailureReason;
  /** The entry that answered (success only). */
  provider: string | null;
  model: string | null;
  /** Summed over all attempts. */
  usage: TokenUsage;
  /** Summed over all attempts; null when any attempt's cost is unknown. */
  costUsd: number | null;
  /** At list price, summed; null when any price is unknown. */
  listCostUsd: number | null;
  /** The provider's reported cost, summed, when every priced attempt had one. */
  reportedCostUsd?: number;
  attempts: Attempt[];
  tags: Record<string, string>;
  /** "subscription" when the answer came through a delegated CLI (cost 0 to budgets). */
  billing: Billing;
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
