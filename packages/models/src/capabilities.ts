import type { ModelRole, ProviderKind } from "./config.js";
import type { FetchLike } from "./transport.js";

// What a model can do, so a model that can't do a role's work is never picked
// silently: (1) what model evals proved, per role (a committed table), and
// (2) what the provider itself says about the model (tools, images), asked once
// per process from its public model metadata.

export interface RoleSupport {
  supported: boolean;
  /** Where the verdict comes from: the eval file and what it showed. */
  evidence: string;
}

/**
 * Model eval verdicts, by `<provider kind>:<model>`. A model marked unsupported
 * for a role is skipped for it (unless the pool entry sets allowUnsupported, as
 * model evals do). Models not listed have no verdict and are used as configured.
 */
export const MODEL_SUPPORT: Record<string, Partial<Record<ModelRole, RoleSupport>>> = {};

/** The eval verdict for a model in a role (the drafter shares the planner's), if any. */
export function supportFor(
  kind: ProviderKind,
  model: string,
  role: ModelRole,
): RoleSupport | undefined {
  const verdicts = MODEL_SUPPORT[`${kind}:${model}`];
  return verdicts?.[role] ?? (role === "drafter" ? verdicts?.planner : undefined);
}

export interface ModelCapabilities {
  /** Calls tools; undefined when the provider didn't say. */
  tools?: boolean;
  /** Reads images. */
  vision?: boolean;
  /** Reasons before it answers, out of the same output budget (Ollama "thinking", OpenRouter "reasoning"). */
  thinking?: boolean;
  /** Honours a JSON schema for structured output (OpenRouter's endpoint flag). */
  structuredOutput?: boolean;
  /** openrouter: false when the pinned upstream doesn't serve the model (calls would fail). */
  pinServed?: boolean;
}

const probed = new Map<string, Promise<ModelCapabilities>>();

/** Forgets every probe (tests). */
export function resetCapabilityProbes(): void {
  probed.clear();
}

/**
 * What the provider says the model can do. Only openrouter and ollama-cloud
 * publish it; both endpoints are public (no key is sent) and on the provider's
 * own host, through the provider's guarded transport. Never throws: anything unexpected means "unknown".
 */
export function probeCapabilities(
  kind: ProviderKind,
  baseUrl: string,
  model: string,
  request: FetchLike,
  pinned?: string,
): Promise<ModelCapabilities> {
  if (kind !== "openrouter" && kind !== "ollama-cloud") return Promise.resolve({});
  const key = `${kind}|${baseUrl}|${model}|${pinned ?? ""}`;
  let found = probed.get(key);
  if (!found) {
    found = (
      kind === "openrouter"
        ? openRouter(baseUrl, model, request, pinned)
        : ollama(baseUrl, model, request)
    ).catch(() => ({}));
    probed.set(key, found);
  }
  return found;
}

async function ollama(
  baseUrl: string,
  model: string,
  request: FetchLike,
): Promise<ModelCapabilities> {
  const origin = new URL(baseUrl).origin;
  const response = await request(`${origin}/api/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return {};
  const body = (await response.json()) as { capabilities?: unknown };
  if (!Array.isArray(body.capabilities)) return {};
  const caps = body.capabilities.filter((c): c is string => typeof c === "string");
  return {
    tools: caps.includes("tools"),
    vision: caps.includes("vision"),
    thinking: caps.includes("thinking"),
  };
}

interface Endpoint {
  tag?: string;
  supported_parameters?: string[];
}

async function openRouter(
  baseUrl: string,
  model: string,
  request: FetchLike,
  pinned: string | undefined,
): Promise<ModelCapabilities> {
  const base = baseUrl.replace(/\/+$/, "");
  const response = await request(`${base}/models/${model}/endpoints`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return {};
  const body = (await response.json()) as {
    data?: { architecture?: { input_modalities?: string[] }; endpoints?: Endpoint[] };
  };
  const data = body.data;
  if (!data) return {};
  const endpoints = data.endpoints ?? [];
  // The pinned upstream's own flags; unpinned, what any endpoint offers.
  const serving = pinned
    ? endpoints.filter((e) => (e.tag ?? "").split("/")[0] === pinned)
    : endpoints;
  const has = (param: string) =>
    serving.length === 0 ? undefined : serving.some((e) => e.supported_parameters?.includes(param));
  const modalities = data.architecture?.input_modalities;
  const out: ModelCapabilities = {};
  if (pinned) out.pinServed = serving.length > 0;
  const tools = has("tools");
  const structured = has("structured_outputs");
  const thinking = has("reasoning");
  if (tools !== undefined) out.tools = tools;
  if (thinking !== undefined) out.thinking = thinking;
  if (structured !== undefined) out.structuredOutput = structured;
  if (Array.isArray(modalities)) out.vision = modalities.includes("image");
  return out;
}
