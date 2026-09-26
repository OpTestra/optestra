import type { Diagnostic } from "../diagnostics.js";
import type { Config } from "../schema.js";
import { readDotenvFile } from "./dotenv.js";
import type { Redactor } from "./redactor.js";
import { secretType } from "./secret-types.js";
import {
  asDynamicSecret,
  createSecretValue,
  readSecretValue,
  registerSensitive,
  type SecretValue,
  withDomains,
} from "./secret-value.js";

/**
 * Where secret values come from. The desktop keychain and the cloud vault will
 * be further implementations of this interface.
 */
export interface SecretSource {
  /** Human name, e.g. "process environment". */
  readonly name: string;
  /** The value of `name` for `environment`, or undefined when this source doesn't have it. */
  get(name: string, environment: string | undefined): SecretValue | undefined;
  /** How a user would add `name` to this source, e.g. "add TEST_PASSWORD=<value> to .env.staging". */
  fixHint?(name: string, environment: string | undefined): string;
  /** Problems found while reading the source (e.g. bad `.env` lines). */
  diagnostics?(): Diagnostic[];
}

interface SourceOptions {
  redactor?: Redactor;
}

/** Reads secrets from process environment variables of the same name. */
export function processEnvSource(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: SourceOptions = {},
): SecretSource {
  return {
    name: "process environment",
    get(name) {
      const value = env[name];
      return value
        ? createSecretValue(name, value, { origin: "environment variable", ...options })
        : undefined;
    },
    fixHint: (name) => `set the ${name} environment variable`,
  };
}

/** Reads `.env`, then `.env.<environment>` (which wins), from `dir`. */
export function dotenvSource(dir: string, options: SourceOptions = {}): SecretSource {
  const cache = new Map<string, ReturnType<typeof readDotenvFile>>();
  const read = (file: string) => {
    let result = cache.get(file);
    if (!result) {
      result = readDotenvFile(dir, file);
      cache.set(file, result);
    }
    return result;
  };
  return {
    name: ".env files",
    get(name, environment) {
      const files = environment ? [`.env.${environment}`, ".env"] : [".env"];
      for (const file of files) {
        const value = read(file).values[name];
        if (value) return createSecretValue(name, value, { origin: file, ...options });
      }
      return undefined;
    },
    fixHint: (name, environment) =>
      `add ${name}=<value> to ${environment ? `.env.${environment}` : ".env"}`,
    diagnostics: () => [...cache.values()].flatMap((result) => result.diagnostics),
  };
}

/** Fixed values, for tests and for the apps to plug in their own stores. */
export function memorySource(
  values: Readonly<Record<string, string>>,
  perEnvironment: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
  options: SourceOptions = {},
): SecretSource {
  return {
    name: "memory",
    get(name, environment) {
      const value = (environment && perEnvironment[environment]?.[name]) || values[name];
      return value ? createSecretValue(name, value, { origin: "memory", ...options }) : undefined;
    },
  };
}

export interface ResolvedSecrets {
  /** Loaded secrets by name, with the domains from the resolved config. */
  secrets: Record<string, SecretValue>;
  /** Declared secrets that no source provides. */
  missing: string[];
  /** Declared secrets whose value doesn't fit their type (e.g. a bad TOTP seed). */
  invalid: string[];
  diagnostics: Diagnostic[];
}

export interface ResolveSecretsOptions {
  /** Selected environment name (for `.env.<environment>` and fix hints). */
  environment?: string | undefined;
  /** Project file, attached to SECRET_MISSING diagnostics. */
  file?: string | undefined;
}

/**
 * Loads every declared secret from the first source that has it. A declared but
 * missing secret is a SECRET_MISSING error with the exact fix.
 */
export function resolveSecrets(
  config: Config,
  sources: readonly SecretSource[],
  options: ResolveSecretsOptions = {},
): ResolvedSecrets {
  const result: ResolvedSecrets = { secrets: {}, missing: [], invalid: [], diagnostics: [] };
  const { environment } = options;
  for (const [name, declaration] of Object.entries(config.secrets ?? {})) {
    let found: SecretValue | undefined;
    for (const source of sources) {
      found = source.get(name, environment);
      if (found) break;
    }
    if (found) {
      const secret = withDomains(found, declaration.domains);
      const type = declaration.type ?? "text";
      if (type === "text") {
        result.secrets[name] = secret;
        continue;
      }
      const definition = secretType(type);
      const check = definition
        ? definition.check(readSecretValue(secret))
        : {
            ok: false as const,
            problem: `nothing that can type ${type} secrets is loaded`,
            fix: `This is an engine bug: the package that registers the "${type}" secret type was not imported.`,
          };
      if (!definition || !check.ok) {
        result.invalid.push(name);
        result.diagnostics.push({
          code: "SECRET_INVALID",
          severity: "error",
          path: `secrets.${name}`,
          ...(options.file && { file: options.file }),
          message: `Secret ${name} (type ${type}, from ${found.origin}) can't be used: ${check.ok ? "" : check.problem}.`,
          fix: check.ok ? "" : check.fix,
        });
        continue;
      }
      if (check.sensitive) registerSensitive(secret, check.sensitive);
      result.secrets[name] = asDynamicSecret(secret, type, definition.producer({ name, config }));
      continue;
    }
    result.missing.push(name);
    // Sources are in precedence order; suggest the lowest (usually a file the user edits) first.
    const hints = sources
      .flatMap((source) => (source.fixHint ? [source.fixHint(name, environment)] : []))
      .reverse();
    const fix = hints.length ? hints.join(", or ") : `provide a value for ${name}`;
    result.diagnostics.push({
      code: "SECRET_MISSING",
      severity: "error",
      path: `secrets.${name}`,
      ...(options.file && { file: options.file }),
      message: `Secret ${name} is declared but has no value${environment ? ` for environment "${environment}"` : ""}.`,
      fix: fix.charAt(0).toUpperCase() + fix.slice(1),
    });
  }
  for (const source of sources) result.diagnostics.push(...(source.diagnostics?.() ?? []));
  return result;
}
