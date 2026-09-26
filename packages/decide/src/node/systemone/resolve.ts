import { brand } from "@testament/brand";
import type { Config } from "@testament/config";
import { processEnvSource, type SecretSource, type SecretValue } from "@testament/config/node";
import { createDecisions, type Decisions, type OnDecision } from "../../decide.js";
import type { DecisionsSettings, ModelBackendId } from "../../section.js";
import { fileCache } from "../file-cache.js";
import { ollayaNotRunningFix } from "./admin.js";
import { createSystemOneBackend, type SystemOneBackend } from "./client.js";
import type { FetchLike } from "./transport.js";

export type KeyStatus = "set" | "missing" | "not_needed" | "not_allowed";

export interface KeyResolution {
  status: KeyStatus;
  key: SecretValue | undefined;
  problem?: string;
}

export interface Notice {
  message: string;
  fix: string;
}

export interface BackendSelection {
  /** What `decisions.backend` says. */
  configured: DecisionsSettings["backend"];
  /** What will answer: a model backend, or none (rules only). */
  selected: ModelBackendId | "none";
  /** One line for listings, e.g. "auto → jev (JEV_API_KEY set)". */
  summary: string;
  backend: SystemOneBackend | null;
  /** Key status per model backend. */
  keys: Record<ModelBackendId, KeyResolution>;
  /** The selected backend can't be used; decisions fall back to rules. */
  problems: Notice[];
  warnings: Notice[];
}

function domainMatches(host: string, domain: string): boolean {
  const name = host.replace(/:\d+$/, "");
  return domain.startsWith("*.") ? name.endsWith(domain.slice(1)) : name === domain;
}

/**
 * A backend's key from the secret sources. A `keySecret` not declared under
 * `secrets:` is implicitly allowed only on the backend's own host; a declared one
 * must list that host in its domains (as for the models package).
 */
export function resolveBackendKey(
  config: Pick<Config, "secrets">,
  settings: { baseUrl: string; keySecret?: string | undefined },
  sources: readonly SecretSource[],
  environment?: string,
): KeyResolution {
  const name = settings.keySecret;
  if (!name) return { status: "not_needed", key: undefined };
  let found: SecretValue | undefined;
  for (const source of sources) {
    found = source.get(name, environment);
    if (found) break;
  }
  if (!found) return { status: "missing", key: undefined };
  const host = new URL(settings.baseUrl).host;
  const declared = config.secrets?.[name];
  if (declared && !declared.domains.some((d) => domainMatches(host, d))) {
    return {
      status: "not_allowed",
      key: undefined,
      problem: `secret ${name} may not be sent to ${host} (its domains: ${declared.domains.join(", ")})`,
    };
  }
  return { status: "set", key: found };
}

export interface ResolveBackendOptions {
  sources?: readonly SecretSource[];
  environment?: string;
  fetch?: FetchLike;
  scrub?: (text: string) => string;
  /** Whether Laya has been fine-tuned on this project (LRN-9 lands later; false today). */
  layaTrained?: boolean;
}

/**
 * Picks the decision backend from config. `auto` = Jev when its key resolves,
 * otherwise none. Kev and Laya only when chosen. Never makes a network call.
 */
export function resolveDecisionBackend(
  config: Pick<Config, "secrets"> & { decisions: DecisionsSettings },
  options: ResolveBackendOptions = {},
): BackendSelection {
  const settings = config.decisions;
  const sources = options.sources ?? [processEnvSource()];
  const keys = {
    jev: resolveBackendKey(config, settings.jev, sources, options.environment),
    kev: resolveBackendKey(config, settings.kev, sources, options.environment),
    laya: resolveBackendKey(config, settings.laya, sources, options.environment),
  };
  const problems: Notice[] = [];
  const warnings: Notice[] = [];
  let selected: ModelBackendId | "none";
  let why: string;
  if (settings.backend === "auto") {
    selected = keys.jev.status === "set" ? "jev" : "none";
    why =
      selected === "jev"
        ? `auto → jev (${settings.jev.keySecret} set)`
        : `auto → none (rules only; set ${settings.jev.keySecret ?? "a Jev key"} to use Jev)`;
    if (keys.jev.status === "not_allowed" && keys.jev.problem)
      warnings.push({
        message: keys.jev.problem,
        fix: "Add the Jev API host to the secret's domains.",
      });
  } else {
    selected = settings.backend;
    why = selected === "none" ? "none (rules only)" : selected;
  }

  let backend: SystemOneBackend | null = null;
  if (selected !== "none") {
    const s = settings[selected];
    const key = keys[selected];
    if (key.status === "missing" || key.status === "not_allowed") {
      problems.push({
        message:
          key.problem ??
          `decisions.backend is ${selected} but ${s.keySecret} is not set; using rules only.`,
        fix: `Set ${s.keySecret} (environment variable or .env), or set decisions.backend to auto or none.`,
      });
      why = `${why} → none (key missing)`;
      selected = "none";
    } else {
      backend = createSystemOneBackend({
        id: selected,
        baseUrl: s.baseUrl,
        model: s.model,
        apiKey: key.key,
        flavor: selected === "laya" ? "ollaya" : "systemone",
        ...(selected === "laya" ? { keepAlive: settings.laya.keepAlive } : {}),
        priceUsdPerMillionInputTokens: s.priceUsdPerMillionInputTokens,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.scrub ? { scrub: options.scrub } : {}),
      });
      if (selected === "laya" && !options.layaTrained) {
        warnings.push({
          message: "Laya is untrained on this project: expect more escalations.",
          fix: "Laya is recommended after training on your own runs (coming later); Jev works well untrained.",
        });
      }
    }
  }
  return {
    configured: settings.backend,
    selected,
    summary: why,
    backend,
    keys,
    problems,
    warnings,
  };
}

export interface ProjectDecisionsOptions extends ResolveBackendOptions {
  config: Pick<Config, "secrets"> & { decisions: DecisionsSettings };
  projectDir: string;
  onDecision?: OnDecision;
  bypassCache?: boolean;
}

export interface WarmUpResult {
  /** False only when a warm-up was needed and failed; decisions still run (rules fallback). */
  ok: boolean;
  /** Milliseconds it took; 0 when the backend needs none. */
  ms: number;
  skipped: boolean;
  failure?: string;
  /** The exact fix, when the failure has a known one (Ollaya not running, model not pulled). */
  fix?: string;
}

/** The fix for a Laya failure reason, when there is a clear one. */
export function layaFix(reason: string, model: string): string | undefined {
  if (reason === "unavailable") return ollayaNotRunningFix();
  if (reason === "model_not_found")
    return `Run: ${brand.cliName} decider setup laya --model ${model}`;
  if (reason === "timeout")
    return "The model took too long to load; raise decisions.laya.warmUpTimeoutMs or check Ollaya.";
  return undefined;
}

export interface ProjectDecisions {
  decisions: Decisions;
  selection: BackendSelection;
  /**
   * Call once at run start. Laya: one small decision with a long timeout so the
   * model is loaded before the first 100 ms decision. Not recorded as a decision.
   */
  warmUp(signal?: AbortSignal): Promise<WarmUpResult>;
}

/** The decision layer for a project run: backend from config, disk cache, warm-up. */
export function createProjectDecisions(options: ProjectDecisionsOptions): ProjectDecisions {
  const selection = resolveDecisionBackend(options.config, options);
  const decisions = createDecisions({
    config: options.config,
    backend: selection.backend,
    cache: fileCache(options.projectDir),
    ...(options.onDecision ? { onDecision: options.onDecision } : {}),
    ...(options.bypassCache ? { bypassCache: true } : {}),
  });
  return {
    decisions,
    selection,
    async warmUp(signal) {
      const backend = selection.backend;
      if (!backend?.warmUp) return { ok: true, ms: 0, skipped: true };
      const start = performance.now();
      const response = await backend.warmUp({
        timeoutMs: options.config.decisions.laya.warmUpTimeoutMs,
        ...(signal ? { signal } : {}),
      });
      const ms = Math.round(performance.now() - start);
      if (response.ok) return { ok: true, ms, skipped: false };
      const fix = layaFix(response.failure.reason, backend.model);
      return {
        ok: false,
        ms,
        skipped: false,
        failure: response.failure.message ?? response.failure.reason,
        ...(fix ? { fix } : {}),
      };
    },
  };
}
