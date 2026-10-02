import type { Config } from "@optestra/config";
import { processEnvSource, type SecretSource, type SecretValue } from "@optestra/config/node";
import { supportFor } from "./capabilities.js";
import {
  isDelegatedKind,
  MODEL_ROLES,
  type ModelRole,
  OPTIONAL_ROLES,
  type PoolEntrySettings,
  type ProviderSettings,
} from "./config.js";
import { findBinary, type ResolvedBinary } from "./delegated/process.js";
import { DEFAULT_KEY_SECRETS, keyOptional, providerBaseUrl } from "./providers.js";

export type KeyStatus = "set" | "missing" | "not_needed" | "not_allowed";

export interface ResolvedProvider {
  id: string;
  settings: ProviderSettings;
  baseUrl: string | undefined;
  /** host[:port] the key may be sent to. */
  host: string | undefined;
  key: SecretValue | undefined;
  keyStatus: KeyStatus;
  /** Why the provider can't be used, if it can't. */
  problem: string | undefined;
  /** Delegated CLI providers: the binary found (not yet run). */
  binary?: ResolvedBinary;
}

export interface PoolEntry {
  role: ModelRole;
  index: number;
  provider: string;
  model: string;
  /** The entry as configured (routing, vision, allowUnsupported). */
  settings?: PoolEntrySettings;
  usable: boolean;
  keyStatus: KeyStatus | "unknown_provider";
  problem: string | undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function domainMatches(host: string, domain: string): boolean {
  const name = host.replace(/:\d+$/, "");
  return domain.startsWith("*.") ? name.endsWith(domain.slice(1)) : name === domain;
}

/**
 * Loads each provider's key from the secret sources. A `keySecret` not declared
 * under `secrets:` is implicitly allowed only on the provider's API host; a
 * declared one must list that host in its domains.
 */
export function resolveProviders(
  config: Config,
  sources: readonly SecretSource[] = [processEnvSource()],
  environment?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  /** The Node for JS subscription CLIs (default: detected). */
  node?: string,
): Map<string, ResolvedProvider> {
  const out = new Map<string, ResolvedProvider>();
  for (const [id, configured] of Object.entries(config.models?.providers ?? {})) {
    // Named providers (openrouter, ollama-cloud) know their own key's name.
    const defaultKey = DEFAULT_KEY_SECRETS[configured.kind];
    const settings: ProviderSettings =
      configured.keySecret || !defaultKey ? configured : { ...configured, keySecret: defaultKey };
    if (isDelegatedKind(settings.kind)) {
      // No key and no host: the user's own signed-in CLI, found on PATH (MOD-6).
      const allowed = config.models?.allowDelegated !== false;
      const found = allowed ? findBinary(settings.kind, settings.binary, env, node) : undefined;
      out.set(id, {
        id,
        settings,
        baseUrl: undefined,
        host: undefined,
        key: undefined,
        keyStatus: "not_needed",
        problem: !allowed
          ? "subscription CLIs are turned off here (models.allowDelegated: false)"
          : found && !found.ok
            ? found.problem
            : undefined,
        ...(found?.ok ? { binary: found.binary } : {}),
      });
      continue;
    }
    const base = providerBaseUrl(settings);
    const baseUrl = "url" in base ? base.url : undefined;
    const host = baseUrl ? hostOf(baseUrl) : undefined;
    const resolved: ResolvedProvider = {
      id,
      settings,
      baseUrl,
      host,
      key: undefined,
      keyStatus: settings.keySecret ? "missing" : keyOptional(settings) ? "not_needed" : "missing",
      problem: "problem" in base ? base.problem : host ? undefined : `invalid baseUrl ${baseUrl}`,
    };
    const name = settings.keySecret;
    if (name) {
      let found: SecretValue | undefined;
      for (const source of sources) {
        found = source.get(name, environment);
        if (found) break;
      }
      const declared = config.secrets?.[name];
      if (found && host) {
        const allowed = declared ? declared.domains.some((d) => domainMatches(host, d)) : true;
        resolved.key = allowed ? found : undefined;
        resolved.keyStatus = allowed ? "set" : "not_allowed";
        if (!allowed) {
          resolved.problem = `secret ${name} may not be sent to ${host} (its domains: ${declared?.domains.join(", ")})`;
        }
      } else if (found) {
        resolved.keyStatus = "set";
        resolved.key = found;
      }
    } else if (!keyOptional(settings)) {
      resolved.problem = resolved.problem ?? `${settings.kind} needs keySecret`;
    }
    out.set(id, resolved);
  }
  return out;
}

/** Each role's ordered pool, with whether each entry can be used right now. */
export function resolvePools(
  config: Config,
  providers: Map<string, ResolvedProvider>,
): Record<ModelRole, PoolEntry[]> {
  const roles = config.models?.roles;
  const pools = {} as Record<ModelRole, PoolEntry[]>;
  const roleNames = [...MODEL_ROLES, ...(Object.keys(OPTIONAL_ROLES) as ModelRole[])];
  for (const role of roleNames) {
    const own = (roles as Partial<Record<ModelRole, PoolEntrySettings[]>> | undefined)?.[role];
    const fallback = (OPTIONAL_ROLES as Partial<Record<ModelRole, ModelRole>>)[role];
    const configured = own?.length || !fallback ? (own ?? []) : (roles?.[fallback] ?? []);
    pools[role] = configured.map((entry, index) => {
      const provider = providers.get(entry.provider);
      if (!provider) {
        return {
          role,
          index,
          provider: entry.provider,
          model: entry.model,
          usable: false,
          keyStatus: "unknown_provider",
          problem: `provider "${entry.provider}" is not defined in models.providers`,
          settings: entry,
        };
      }
      // A model a model eval found unfit for this role can't be picked silently.
      const support = supportFor(provider.settings.kind, entry.model, role);
      const unsupported =
        support && !support.supported && !entry.allowUnsupported
          ? `${entry.model} is marked unsupported as ${role}: ${support.evidence}`
          : undefined;
      const keyProblem =
        provider.keyStatus === "missing"
          ? `key ${provider.settings.keySecret ?? ""} is not set`.trim()
          : undefined;
      const problem = provider.problem ?? keyProblem ?? unsupported;
      return {
        role,
        index,
        provider: entry.provider,
        model: entry.model,
        settings: entry,
        usable: problem === undefined,
        keyStatus: provider.keyStatus,
        problem,
      };
    });
  }
  return pools;
}
