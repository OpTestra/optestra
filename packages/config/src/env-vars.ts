import { brand } from "@optestra/brand";
import type { z } from "zod";
import type { Diagnostic } from "./diagnostics.js";
import { formatPath, type Path, setAt } from "./paths.js";
import type { ConfigRegistry } from "./registry.js";

/** Prefix of every config environment variable, from the brand (e.g. `PREFIX_` = upper-cased cliName + "_"). */
export const ENV_PREFIX = `${brand.cliName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_`;

/** Selects the environment, e.g. `PREFIX_ENVIRONMENT=staging`. */
export const ENVIRONMENT_VAR = `${ENV_PREFIX}ENVIRONMENT`;

type LeafKind = "string" | "number" | "boolean" | "stringArray";

export interface EnvVarBinding {
  name: string;
  /** Path in the config; for `environment` bindings, relative to the selected environment. */
  path: string[];
  kind: LeafKind;
  target: "section" | "environment";
}

const upperSnake = (segment: string) =>
  segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();

type Def = {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
};
const defOf = (schema: z.ZodType) => schema.def as unknown as Def;

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let def = defOf(current); def.innerType; def = defOf(current)) current = def.innerType;
  return current;
}

function leafKind(schema: z.ZodType): LeafKind | "object" | undefined {
  const def = defOf(unwrap(schema));
  if (def.type === "string" || def.type === "enum") return "string";
  if (def.type === "number") return "number";
  if (def.type === "boolean") return "boolean";
  if (def.type === "object") return "object";
  if (def.type === "array" && def.element && leafKind(def.element) === "string")
    return "stringArray";
  return undefined;
}

function walk(
  schema: z.ZodType,
  path: string[],
  out: EnvVarBinding[],
  target: EnvVarBinding["target"],
) {
  const kind = leafKind(schema);
  if (kind === "object") {
    const shape = defOf(unwrap(schema)).shape ?? {};
    for (const [key, child] of Object.entries(shape)) walk(child, [...path, key], out, target);
  } else if (kind) {
    out.push({ name: ENV_PREFIX + path.map(upperSnake).join("_"), path, kind, target });
  }
}

const ENVIRONMENT_FIELDS = ["baseUrl", "app", "allowedDomains"];

/**
 * Every supported config environment variable. Plain values of each section map
 * to `PREFIX_SECTION_FIELD` (e.g. `PREFIX_RUN_RETRIES`); maps such as
 * environments and secrets are not settable this way, except the selected
 * environment's `baseUrl`, `app` and `allowedDomains` (`PREFIX_BASE_URL`, ...).
 */
export function envVarBindings(registry: ConfigRegistry): EnvVarBinding[] {
  const bindings: EnvVarBinding[] = [];
  const { config, environment } = registry.schemas();
  for (const section of registry.sections) {
    if (section.key === "environments") continue;
    const schema = config.shape[section.key];
    if (schema) walk(schema, [section.key], bindings, "section");
  }
  for (const field of ENVIRONMENT_FIELDS) {
    const schema = environment.shape[field];
    const kind = schema && leafKind(schema);
    if (kind && kind !== "object") {
      bindings.push({
        name: ENV_PREFIX + upperSnake(field),
        path: [field],
        kind,
        target: "environment",
      });
    }
  }
  return bindings;
}

function parseValue(
  raw: string,
  kind: LeafKind,
): { ok: true; value: unknown } | { ok: false; expected: string } {
  const text = raw.trim();
  switch (kind) {
    case "number": {
      const value = Number(text);
      return text !== "" && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, expected: "a number" };
    }
    case "boolean":
      if (/^(true|1|yes|on)$/i.test(text)) return { ok: true, value: true };
      if (/^(false|0|no|off)$/i.test(text)) return { ok: true, value: false };
      return { ok: false, expected: "true or false" };
    case "stringArray":
      return {
        ok: true,
        value: text
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      };
    default:
      return { ok: true, value: raw };
  }
}

export interface EnvVarLayer {
  value: Record<string, unknown>;
  /** Config path (formatted) → variable name that set it. */
  names: Map<string, string>;
  diagnostics: Diagnostic[];
}

/** Builds the environment-variable layer from `env`. */
export function envVarLayer(
  env: Readonly<Record<string, string | undefined>>,
  registry: ConfigRegistry,
  environment: string | undefined,
  ignore: ReadonlySet<string>,
): EnvVarLayer {
  const layer: EnvVarLayer = { value: {}, names: new Map(), diagnostics: [] };
  const bindings = new Map(envVarBindings(registry).map((binding) => [binding.name, binding]));
  for (const [name, raw] of Object.entries(env)) {
    if (
      !name.startsWith(ENV_PREFIX) ||
      raw === undefined ||
      name === ENVIRONMENT_VAR ||
      ignore.has(name)
    ) {
      continue;
    }
    const binding = bindings.get(name);
    if (!binding) {
      layer.diagnostics.push({
        code: "ENV_VAR_UNKNOWN",
        severity: "warning",
        message: `Environment variable ${name} is not a known setting and is ignored.`,
        fix: `Remove ${name} or rename it to a supported variable (for example ${ENV_PREFIX}RUN_RETRIES).`,
      });
      continue;
    }
    let path: Path = binding.path;
    if (binding.target === "environment") {
      if (!environment) {
        layer.diagnostics.push({
          code: "ENV_VAR_INVALID",
          severity: "warning",
          message: `${name} is set but no environment is selected, so it is ignored.`,
          fix: `Choose an environment (for example ${ENVIRONMENT_VAR}=staging) or unset ${name}.`,
        });
        continue;
      }
      path = ["environments", environment, ...binding.path];
    }
    const parsed = parseValue(raw, binding.kind);
    if (!parsed.ok) {
      layer.diagnostics.push({
        code: "ENV_VAR_INVALID",
        severity: "error",
        path: formatPath(path),
        message: `${name} must be ${parsed.expected}; it is ignored.`,
        fix: `Set ${name} to ${parsed.expected}, or unset it.`,
      });
      continue;
    }
    setAt(layer.value, path, parsed.value);
    layer.names.set(formatPath(path), name);
  }
  return layer;
}
