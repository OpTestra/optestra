import { brand } from "@testament/brand";
import type { Config } from "@testament/config";
import { processEnvSource, type SecretSource, type SecretValue } from "@testament/config/node";
import { createDecisions, type Decisions, type OnDecision } from "../../decide.js";
import type { BackendId, DecisionsSettings, ModelBackendId } from "../../section.js";
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

/** Which backend one phase uses. */
export interface PhaseRoute {
  /** What `decisions.<phase>` says. */
  configured: BackendId;
  /** What will answer: a model backend, or none (rules only). */
  selected: ModelBackendId | "none";
  /** One line for listings, e.g. "auto → jev (JEV_API_KEY set)". */
  summary: string;
  backend: SystemOneBackend | null;
}

export interface BackendSelection {
  /** What `decisions.backend` (the shorthand for both phases) says. */
  configured: BackendId;
  during: PhaseRoute;
  after: PhaseRoute;
  /** Key status per model backend. */
  keys: Record<ModelBackendId, KeyResolution>;
  /** A selected backend can't be used; that phase falls back to rules. */
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
 * Picks each phase's decision backend from config (DEC-2):
 * - `decisions.during` / `decisions.after` name a backend, or `auto`;
 * - `auto` means whatever `decisions.backend` names; when that is `auto` too,
 *   during → rules only, after → Jev when its key resolves, else rules only.
 * Kev and Laya are only used when named. Never makes a network call.
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
  const jevKey = settings.jev.keySecret ?? "a Jev key";
  if (keys.jev.status === "not_allowed" && keys.jev.problem)
    warnings.push({
      message: keys.jev.problem,
      fix: "Add the Jev API host to the secret's domains.",
    });

  // One backend instance per model, shared by both phases (one usage total).
  const instances = new Map<ModelBackendId, SystemOneBackend>();
  const instance = (id: ModelBackendId): SystemOneBackend => {
    const existing = instances.get(id);
    if (existing) return existing;
    const s = settings[id];
    const created = createSystemOneBackend({
      id,
      baseUrl: s.baseUrl,
      model: s.model,
      apiKey: keys[id].key,
      flavor: id === "laya" ? "ollaya" : "systemone",
      ...(id === "laya" ? { keepAlive: settings.laya.keepAlive } : {}),
      priceUsdPerMillionInputTokens: s.priceUsdPerMillionInputTokens,
      expectedLatencyMs: s.expectedLatencyMs,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.scrub ? { scrub: options.scrub } : {}),
    });
    instances.set(id, created);
    return created;
  };
  const reported = new Set<string>();

  function route(phase: "during" | "after"): PhaseRoute {
    const configured = settings[phase];
    let wanted: BackendId = configured;
    let why: string;
    if (configured === "auto" && settings.backend !== "auto") {
      wanted = settings.backend;
      why = `auto → ${wanted}${wanted === "none" ? " (rules only)" : ""} (from backend)`;
    } else if (configured === "auto") {
      if (phase === "during") {
        return { configured, selected: "none", summary: "auto → none (rules only)", backend: null };
      }
      const jev = keys.jev.status === "set";
      wanted = jev ? "jev" : "none";
      why = jev
        ? `auto → jev (${settings.jev.keySecret} set)`
        : `auto → none (rules only; set ${jevKey} to use Jev)`;
    } else {
      why = configured === "none" ? "none (rules only)" : configured;
    }
    if (wanted === "none" || wanted === "auto")
      return { configured, selected: "none", summary: why, backend: null };

    const id: ModelBackendId = wanted;
    const key = keys[id];
    if (key.status === "missing" || key.status === "not_allowed") {
      if (!reported.has(`key:${id}`)) {
        reported.add(`key:${id}`);
        problems.push({
          message:
            key.problem ??
            `${id} is selected but ${settings[id].keySecret} is not set; using rules only.`,
          fix: `Set ${settings[id].keySecret} (environment variable or .env), or choose auto or none.`,
        });
      }
      return {
        configured,
        selected: "none",
        summary: `${why} → none (key missing)`,
        backend: null,
      };
    }
    if (id === "laya" && !options.layaTrained && !reported.has("laya-untrained")) {
      reported.add("laya-untrained");
      warnings.push({
        message: "Laya is untrained on this project: expect more escalations.",
        fix: "Laya is recommended after training on your own runs (coming later); Jev works well untrained.",
      });
    }
    const backend = instance(id);
    if (phase === "during" && settings[id].expectedLatencyMs > 100 && !reported.has(`slow:${id}`)) {
      reported.add(`slow:${id}`);
      warnings.push({
        message: `${id} (about ${settings[id].expectedLatencyMs} ms) is slower than the 100 ms during-run limit, so during-run tasks won't call it.`,
        fix: "Use laya for during-run decisions, or leave decisions.during on auto (rules only).",
      });
    }
    return { configured, selected: id, summary: why, backend };
  }

  return {
    configured: settings.backend,
    during: route("during"),
    after: route("after"),
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
    backends: { during: selection.during.backend, after: selection.after.backend },
    cache: fileCache(options.projectDir),
    ...(options.onDecision ? { onDecision: options.onDecision } : {}),
    ...(options.bypassCache ? { bypassCache: true } : {}),
  });
  return {
    decisions,
    selection,
    async warmUp(signal) {
      // Only a backend that needs loading (Laya) is warmed, once even if both phases use it.
      const backend = [selection.during.backend, selection.after.backend].find((b) => b?.warmUp);
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
