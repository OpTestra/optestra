/**
 * The one adapter between the engine and AI models. Importing this package
 * registers the `models` config section.
 */
export { BudgetMeter } from "./budget.js";
export {
  type CheckOptions,
  checkProviders,
  type ProviderCheck,
  type ProviderCheckStatus,
} from "./check.js";
export { createModels, type Models, type ModelsOptions } from "./client.js";
export {
  MODEL_ROLES,
  type ModelRole,
  type ModelsSettings,
  modelsSchema,
  type PoolEntrySettings,
  PROVIDER_KINDS,
  type PriceSettings,
  type ProviderKind,
  type ProviderSettings,
} from "./config.js";
export { basePrices, computeCost, priceFor } from "./cost.js";
export {
  type KeyStatus,
  type PoolEntry,
  type ResolvedProvider,
  resolvePools,
  resolveProviders,
} from "./keys.js";
export type {
  Attempt,
  AttemptOutcome,
  CompletionFailure,
  CompletionRequest,
  CompletionResult,
  CompletionSuccess,
  FailureReason,
  ImagePart,
  ModelCallRecord,
  ModelMessage,
  TextPart,
  TokenUsage,
  ToolCall,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart,
} from "./types.js";
export {
  CAP_WINDOWS,
  type CapUsage,
  type CapWindow,
  capUsage,
  FileUsageStore,
  MemoryUsageStore,
  NEAR_CAP_RATIO,
  projectUsageStore,
  type UsageEntry,
  type UsageStore,
} from "./usage.js";
