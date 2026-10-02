import { defaultRegistry, httpUrlSchema, SECRET_NAME } from "@optestra/config";
import { z } from "zod";

export const PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "google",
  "openai-compatible",
  "azure",
  "bedrock",
  "openrouter",
  "ollama-cloud",
  "claude-code",
  "codex",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * MOD-6: the user's own AI subscription, through the vendor's official CLI that
 * the user installed and signed in to. No key, no network from us: we run the
 * binary, locked down, as a model.
 */
export const DELEGATED_KINDS = ["claude-code", "codex"] as const;
export type DelegatedKind = (typeof DELEGATED_KINDS)[number];
export const isDelegatedKind = (kind: string): kind is DelegatedKind =>
  (DELEGATED_KINDS as readonly string[]).includes(kind);

/** Roles in FND-2. The decider (DEC phase) has its own protocol and is added there. */
export const MODEL_ROLES = ["planner", "fixer"] as const;

/**
 * Roles with their own optional pool. An empty or absent pool uses the role it
 * falls back to (the drafter writes new tests from a sentence: the planner's work).
 */
export const OPTIONAL_ROLES = { drafter: "planner" } as const;

export type ModelRole = (typeof MODEL_ROLES)[number] | keyof typeof OPTIONAL_ROLES;

/** OpenRouter provider routing (openrouter.ai/docs/features/provider-routing). */
export const routingSchema = z.strictObject({
  order: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Upstream providers to use, in order (e.g. [anthropic]). Default: the model author's own endpoint when known.",
    ),
  allowFallbacks: z
    .boolean()
    .optional()
    .describe("Let OpenRouter use another upstream provider when these fail. Default false."),
  dataCollection: z
    .enum(["allow", "deny"])
    .optional()
    .describe("deny (default): only upstream providers that don't store or train on prompts."),
  zdr: z.boolean().optional().describe("Only zero-data-retention endpoints. Default false."),
});

const capSchema = z.strictObject({ usd: z.number().positive().describe("Spend cap in USD.") });

export const providerSchema = z.strictObject({
  kind: z.enum(PROVIDER_KINDS).describe("Provider type."),
  baseUrl: httpUrlSchema
    .optional()
    .describe("API base URL. Required for openai-compatible; optional for others."),
  keySecret: z
    .string()
    .regex(SECRET_NAME, "expected an UPPER_SNAKE_CASE secret name")
    .optional()
    .describe("Name of the secret holding the API key. Local servers may have none."),
  caps: z
    .strictObject({
      per5h: capSchema.optional(),
      perWeek: capSchema.optional(),
      perMonth: capSchema.optional(),
    })
    .optional()
    .describe("Usage caps. At 90% of any cap, calls move to the next provider."),
  options: z
    .record(z.string(), z.string())
    .optional()
    .describe("Provider-specific settings: azure resourceName/apiVersion, bedrock region."),
  binary: z
    .string()
    .min(1)
    .optional()
    .describe("claude-code / codex: path to the CLI. Default: found on PATH (claude, codex)."),
  concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Most requests in flight to this provider at once; more wait their turn. Default: openrouter 8, ollama-cloud 3 (Pro plan), others unlimited.",
    ),
  concurrencyPerModel: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Most requests in flight per model at this provider. Default unlimited."),
  routing: routingSchema
    .optional()
    .describe("openrouter: which upstream providers may serve the calls (per entry too)."),
});

export const poolEntrySchema = z.strictObject({
  provider: z.string().min(1).describe("Provider id from models.providers."),
  model: z.string().min(1).describe("Model id at that provider."),
  routing: routingSchema.optional().describe("openrouter: overrides the provider's routing."),
  vision: z
    .boolean()
    .optional()
    .describe(
      "Whether the model reads images (screenshots). Default: what the provider says about the model.",
    ),
  allowUnsupported: z
    .boolean()
    .optional()
    .describe("Use the model even for a role it is marked unsupported for (model evals only)."),
});

export const priceSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cachedInput: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
});

export const modelsSchema = z
  .strictObject({
    providers: z.record(z.string().min(1), providerSchema).describe("AI providers, by id."),
    roles: z
      .strictObject({
        planner: z.array(poolEntrySchema).describe("Writes and re-records tests."),
        fixer: z.array(poolEntrySchema).describe("Cheap, fast single-step heals."),
        drafter: z
          .array(poolEntrySchema)
          .optional()
          .describe("Drafts new tests from a sentence. Default: the planner's pool."),
      })
      .describe("Ordered pool per role: the first healthy entry answers."),
    prices: z
      .record(z.string(), priceSchema)
      .describe("Price overrides by model id, USD per million tokens."),
    timeoutSeconds: z.number().positive().describe("Maximum time for one model request."),
    maxWaitMinutes: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        "Longest one call waits for a rate-limited provider (429, Retry-After) before trying the next one. Default 30. Waits never count against a test's time limit.",
      ),
    allowDelegated: z
      .boolean()
      .describe(
        "Allow claude-code / codex (your own AI subscription through its CLI). The cloud sets false.",
      ),
    delegatedCallsPerRun: z
      .number()
      .int()
      .positive()
      .describe(
        "Most calls one run may make through each subscription CLI (plans assume ordinary individual use).",
      ),
  })
  .describe("AI models.");

export type ProviderSettings = z.infer<typeof providerSchema>;
export type RoutingSettings = z.infer<typeof routingSchema>;
export type PoolEntrySettings = z.infer<typeof poolEntrySchema>;
export type PriceSettings = z.infer<typeof priceSchema>;
export type ModelsSettings = z.infer<typeof modelsSchema>;

declare module "@optestra/config" {
  interface ConfigSections {
    models: ModelsSettings;
  }
}

// Registered when this package loads; defaults live in packages/config/defaults.yaml.
if (!defaultRegistry.has("models")) {
  defaultRegistry.register({ key: "models", schema: modelsSchema, environmentOverride: true });
}
