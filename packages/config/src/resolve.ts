import { brand } from "@testament/brand";
import type { z } from "zod";
import type { Diagnostic, DiagnosticCode, Severity } from "./diagnostics.js";
import { ENVIRONMENT_VAR, envVarLayer } from "./env-vars.js";
import {
  type Layer,
  mergeLayers,
  type Provenance,
  type ProvenanceMap,
  provenanceOf,
  withoutUndefined,
} from "./merge.js";
import {
  clone,
  deepMerge,
  deleteAt,
  formatPath,
  getAt,
  isPlainObject,
  type Path,
  setAt,
} from "./paths.js";
import { type ConfigRegistry, defaultRegistry } from "./registry.js";
import {
  CONFIG_VERSION,
  type Config,
  type EnvironmentSettings,
  protectionSecretNames,
  SECRET_NAME,
} from "./schema.js";

export interface ResolveOptions {
  /** Parsed project file content; undefined when there is no project file. */
  project?: unknown;
  /** Path of the project file, for provenance and diagnostics. */
  projectFile?: string | undefined;
  /** Line of a path in the project file, when known. */
  lineOf?: ((path: Path) => number | undefined) | undefined;
  /** Environment chosen by the caller (CLI `--env`, app dropdown). */
  environment?: string | undefined;
  /** Highest-precedence values from the caller (CLI flags, app). */
  runOptions?: unknown;
  /** Environment variables to read (`PREFIX_*`). Nothing is read from the process unless passed. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  registry?: ConfigRegistry | undefined;
  /** Diagnostics from earlier steps (file discovery, YAML parsing). */
  diagnostics?: readonly Diagnostic[] | undefined;
}

export interface SelectedEnvironment {
  name: string;
  settings: EnvironmentSettings;
  /** How it was chosen: run option, env var, defaultEnvironment, or the only one defined. */
  selectedBy: Provenance;
}

export interface ResolvedProject {
  /** The resolved config. When diagnostics contain errors it is a best-effort fallback. */
  config: Config;
  environment: SelectedEnvironment | undefined;
  /** Formatted config path (e.g. `run.retries`) → where its value came from. */
  provenance: Record<string, Provenance>;
  diagnostics: Diagnostic[];
}

/** Migrations from version N to N+1, applied in order. Empty while only v1 exists. */
const MIGRATIONS: Record<number, (config: Record<string, unknown>) => Record<string, unknown>> = {};

function migrate(config: Record<string, unknown>, from: number): Record<string, unknown> {
  let current = config;
  for (let version = from; version < CONFIG_VERSION; version++) {
    const step = MIGRATIONS[version];
    if (step) current = step(current);
  }
  return current;
}

/** Expands `"*"` entries in defaults into one entry per key present in the other layers. */
function expandTemplates(node: unknown, path: Path, sources: readonly unknown[]): unknown {
  if (!isPlainObject(node)) return clone(node);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key !== "*") out[key] = expandTemplates(value, [...path, key], sources);
  }
  if ("*" in node) {
    const keys = new Set(
      sources.flatMap((source) => {
        const at = getAt(source, path);
        return isPlainObject(at) ? Object.keys(at) : [];
      }),
    );
    for (const key of keys) {
      out[key] = deepMerge(expandTemplates(node["*"], [...path, key], sources), out[key]);
    }
  }
  return out;
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.hostname
      : undefined;
  } catch {
    return undefined;
  }
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `${/^[aeiou]/.test(issue.expected) ? "an" : "a"} ${issue.expected}`;
    case "invalid_value":
      return `one of ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "too_small":
      return issue.origin === "array" || issue.origin === "string"
        ? `at least ${issue.minimum} ${issue.origin === "array" ? "item(s)" : "character(s)"}`
        : `${issue.inclusive ? "at least" : "more than"} ${issue.minimum}`;
    case "too_big":
      return `${issue.inclusive ? "at most" : "less than"} ${issue.maximum}`;
    default:
      return issue.message.replace(/^Invalid input: /, "");
  }
}

/**
 * Resolves a project config. Pure: no file or environment access beyond what is
 * passed in, and it never throws on user mistakes. Resolution order (lowest to
 * highest): built-in defaults, project file, selected environment's overrides,
 * environment variables, run options.
 */
export function resolveConfig(options: ResolveOptions = {}): ResolvedProject {
  const registry = options.registry ?? defaultRegistry;
  const env = options.env ?? {};
  const file = options.projectFile;
  const fileName = file?.split(/[\\/]/).pop() ?? brand.configFileName;
  const diagnostics: Diagnostic[] = [];
  let provenance: ProvenanceMap = new Map();

  const locate = (path: Path): { file?: string; line?: number; label: string } => {
    const found = provenanceOf(provenance, path);
    switch (found?.source) {
      case "project":
      case "environment": {
        const where = found.line ? `${fileName} line ${found.line}` : fileName;
        return { ...(file && { file }), ...(found.line && { line: found.line }), label: where };
      }
      case "envVar":
        return { label: `environment variable ${found.envVar}` };
      case "runOption":
        return { label: "the run options" };
      default:
        return { label: file ? fileName : "the built-in defaults" };
    }
  };

  const report = (
    code: DiagnosticCode,
    severity: Severity,
    message: string,
    fix: string,
    path?: Path,
  ) => {
    const at = path ? locate(path) : { ...(file && { file }) };
    const diagnostic: Diagnostic = {
      code,
      severity,
      message,
      fix,
      ...("file" in at && at.file ? { file: at.file } : {}),
      ...("line" in at && at.line ? { line: at.line } : {}),
      ...(path ? { path: formatPath(path) } : {}),
    };
    const key = `${code}|${diagnostic.path}|${message}`;
    if (!diagnostics.some((d) => `${d.code}|${d.path}|${d.message}` === key))
      diagnostics.push(diagnostic);
  };
  for (const earlier of options.diagnostics ?? []) diagnostics.push(earlier);

  // Project file content.
  let project: Record<string, unknown> = {};
  const hasProject = options.project !== undefined;
  if (hasProject && options.project !== null) {
    if (isPlainObject(options.project)) project = clone(options.project);
    else {
      report(
        "CONFIG_NOT_OBJECT",
        "error",
        `${fileName} must contain settings as "key: value" lines.`,
        `Replace the content of ${fileName} with a mapping that starts with "version: 1".`,
      );
    }
  }
  const lineOf = (path: Path) => options.lineOf?.(path);
  if (hasProject) {
    const version = project.version;
    if (version === undefined || version === null) {
      report(
        "VERSION_MISSING",
        "error",
        `${fileName} has no "version".`,
        `Add "version: ${CONFIG_VERSION}" as the first line of ${fileName}.`,
      );
    } else if (
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 1 ||
      version > CONFIG_VERSION
    ) {
      report(
        "VERSION_UNSUPPORTED",
        "error",
        `${fileName} has version ${JSON.stringify(version)}, but this engine reads version ${CONFIG_VERSION}.`,
        `Set "version: ${CONFIG_VERSION}" or upgrade the engine.`,
      );
    } else {
      project = migrate(project, version);
    }
  }
  delete project.version;
  for (const key of Object.keys(project)) {
    if (!registry.has(key)) {
      const line = lineOf([key]);
      diagnostics.push({
        code: "UNKNOWN_KEY",
        severity: "warning",
        message: `Unknown setting "${key}" is ignored.`,
        fix: `Remove "${key}" from ${fileName} or check its spelling.`,
        ...(file && { file }),
        ...(line && { line }),
        path: key,
      });
      delete project[key];
    }
  }

  // Environment selection.
  const projectEnvironments = isPlainObject(project.environments) ? project.environments : {};
  const names = Object.keys(projectEnvironments);
  let selected: { name: string; selectedBy: Provenance } | undefined;
  const envChoice = env[ENVIRONMENT_VAR];
  const runDefault = isPlainObject(options.runOptions)
    ? options.runOptions.defaultEnvironment
    : undefined;
  const candidates: [unknown, Provenance][] = [
    [options.environment, { source: "runOption" }],
    [envChoice, { source: "envVar", envVar: ENVIRONMENT_VAR }],
    [runDefault, { source: "runOption", note: "defaultEnvironment" }],
    [
      project.defaultEnvironment,
      {
        source: "project",
        note: "defaultEnvironment",
        ...withoutUndefined({ file, line: lineOf(["defaultEnvironment"]) }),
      },
    ],
  ];
  const choice = candidates.find(([name]) => typeof name === "string" && name !== "");
  if (choice) {
    const name = choice[0] as string;
    if (names.includes(name)) selected = { name, selectedBy: choice[1] };
    else if (choice[1].note !== "defaultEnvironment") {
      report(
        "ENV_NOT_FOUND",
        "error",
        `Environment "${name}" is not defined${names.length ? ` (defined: ${names.join(", ")})` : ""}.`,
        names.length
          ? `Choose one of ${names.join(", ")}, or add "${name}" under "environments" in ${fileName}.`
          : `Add "${name}" under "environments" in ${fileName}.`,
      );
    }
  } else if (names.length === 1 && names[0]) {
    selected = {
      name: names[0],
      selectedBy: { source: "default", note: "only environment defined" },
    };
  }
  if (names.length === 0 && hasProject) {
    report(
      "ENV_NONE_DEFINED",
      "warning",
      "No environments are defined, so there is nothing to test against yet.",
      `Add an environment to ${fileName}, e.g. "environments:" then "  local:" then "    baseUrl: http://localhost:3000".`,
    );
  } else if (!selected && !choice && names.length > 1) {
    report(
      "ENV_NOT_SELECTED",
      "warning",
      `Several environments are defined (${names.join(", ")}) and none is chosen.`,
      `Set "defaultEnvironment" in ${fileName}, or pass an environment (e.g. --env ${names[0]}).`,
    );
  }

  // Layers.
  const overrides: Record<string, unknown> = {};
  const selectedEntry = selected ? projectEnvironments[selected.name] : undefined;
  if (selected && isPlainObject(selectedEntry)) {
    for (const key of registry.overridableKeys) {
      if (selectedEntry[key] !== undefined) overrides[key] = clone(selectedEntry[key]);
    }
  }
  const declaredSecrets = new Set(
    isPlainObject(project.secrets) ? Object.keys(project.secrets) : [],
  );
  const envVars = envVarLayer(env, registry, selected?.name, declaredSecrets);
  diagnostics.push(...envVars.diagnostics);

  let runOptions: Record<string, unknown> = {};
  if (options.runOptions !== undefined) {
    if (isPlainObject(options.runOptions)) {
      runOptions = clone(options.runOptions);
      for (const key of Object.keys(runOptions)) {
        if (!registry.has(key)) {
          report(
            "RUN_OPTION_INVALID",
            "warning",
            `Unknown run option "${key}" is ignored.`,
            `Remove "${key}" from the run options.`,
          );
          delete runOptions[key];
        }
      }
    } else {
      report(
        "RUN_OPTION_INVALID",
        "error",
        "Run options must be an object; they are ignored.",
        "Pass run options as an object, e.g. { run: { retries: 0 } }.",
      );
    }
  }

  const sources = [project, overrides, envVars.value, runOptions];
  const layers: Layer[] = [
    { source: "default", value: expandTemplates(registry.defaults(), [], sources) },
    {
      source: "project",
      value: project,
      describe: (path) => ({ file, line: lineOf(path) }),
    },
    {
      source: "environment",
      value: overrides,
      describe: (path) => ({
        file,
        environment: selected?.name,
        line: selected ? lineOf(["environments", selected.name, ...path]) : undefined,
      }),
    },
    {
      source: "envVar",
      value: envVars.value,
      describe: (path) => ({ envVar: envVars.names.get(formatPath(path)) }),
    },
    { source: "runOption", value: runOptions },
  ];
  const merged = mergeLayers(layers);
  const candidate = merged.value;
  provenance = merged.provenance;

  // Derived values: allowedDomains defaults to the host of baseUrl.
  const environments = isPlainObject(candidate.environments) ? candidate.environments : {};
  for (const [name, entry] of Object.entries(environments)) {
    if (!isPlainObject(entry) || entry.allowedDomains !== undefined) continue;
    const host = hostOf(entry.baseUrl);
    entry.allowedDomains = host ? [host] : [];
    provenance.set(formatPath(["environments", name, "allowedDomains"]), {
      source: "default",
      note: host ? "host of baseUrl" : "no baseUrl",
    });
  }

  // Secrets: names, domains, per-environment overrides.
  const secrets = isPlainObject(candidate.secrets) ? candidate.secrets : {};
  for (const [name, declaration] of Object.entries(secrets)) {
    const path = ["secrets", name];
    if (!SECRET_NAME.test(name)) {
      const suggestion = name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toUpperCase();
      report(
        "SECRET_NAME_INVALID",
        "error",
        `Secret name "${name}" must be UPPER_SNAKE_CASE; the secret is ignored.`,
        `Rename "${name}" to "${suggestion || "MY_SECRET"}" in ${fileName} and in your .env files.`,
        path,
      );
      delete secrets[name];
      continue;
    }
    if (
      isPlainObject(declaration) &&
      (!Array.isArray(declaration.domains) || declaration.domains.length === 0)
    ) {
      report(
        "SECRET_NO_DOMAINS",
        "error",
        `Secret ${name} has no domains, so it can never be typed anywhere.`,
        `Add "domains: [your-site.com]" under secrets.${name} in ${fileName}.`,
        path,
      );
      if (declaration.domains === undefined) declaration.domains = [];
    }
  }
  for (const [envName, entry] of Object.entries(projectEnvironments)) {
    if (!isPlainObject(entry) || !isPlainObject(entry.secrets)) continue;
    for (const name of Object.keys(entry.secrets)) {
      if (declaredSecrets.has(name)) continue;
      report(
        "SECRET_UNDECLARED",
        "error",
        `Environment "${envName}" overrides secret ${name}, which is not declared under "secrets".`,
        `Declare ${name} under "secrets" in ${fileName}, or remove it from environments.${envName}.secrets.`,
        ["environments", envName, "secrets", name],
      );
      if (envName === selected?.name) delete secrets[name];
    }
  }

  // Protected-preview headers (SEC-8) name declared secrets.
  for (const [envName, entry] of Object.entries(environments)) {
    if (!isPlainObject(entry) || !isPlainObject(entry.protection)) continue;
    for (const name of protectionSecretNames(entry.protection)) {
      if (declaredSecrets.has(name)) continue;
      report(
        "SECRET_UNDECLARED",
        "error",
        `Environment "${envName}" sends secret ${name} as a protected-preview header, but ${name} is not declared under "secrets".`,
        `Declare ${name} under "secrets" in ${fileName} with the preview's domains, e.g. "domains: [*.vercel.app]".`,
        ["environments", envName, "protection"],
      );
    }
  }

  // Environments must match the project target.
  const target = getAt(candidate, ["project", "target"]);
  for (const [name, entry] of Object.entries(environments)) {
    if (!isPlainObject(entry)) continue;
    if (target === "web" && entry.baseUrl === undefined) {
      report(
        "ENV_BASE_URL_MISSING",
        "error",
        `Environment "${name}" has no baseUrl, so web tests don't know where to start.`,
        `Add "baseUrl: https://..." under environments.${name} in ${fileName}.`,
        ["environments", name],
      );
    }
    if (target === "android" && entry.app === undefined) {
      report(
        "ENV_APP_MISSING",
        "error",
        `Environment "${name}" has no app, so Android tests have nothing to install.`,
        `Add "app: path/to/app.apk" under environments.${name} in ${fileName}.`,
        ["environments", name],
      );
    }
  }
  const defaultEnvironment = candidate.defaultEnvironment;
  if (typeof defaultEnvironment === "string" && !(defaultEnvironment in environments)) {
    report(
      "ENV_DEFAULT_UNKNOWN",
      "error",
      `defaultEnvironment is "${defaultEnvironment}", which is not defined.`,
      names.length
        ? `Set defaultEnvironment to one of ${names.join(", ")} in ${fileName}.`
        : `Add "${defaultEnvironment}" under "environments" in ${fileName}.`,
      ["defaultEnvironment"],
    );
  }

  // Schema validation. Invalid values fall back to the default (or are dropped).
  candidate.version = CONFIG_VERSION;
  const schema = registry.schemas().config;
  const defaults = expandTemplates(registry.defaults(), [], sources);
  let config: Config | undefined;
  const handled = new Set<string>();
  for (let pass = 0; pass < 10 && !config; pass++) {
    const result = schema.safeParse(candidate);
    if (result.success) {
      config = result.data as unknown as Config;
      break;
    }
    let progressed = false;
    for (const issue of result.error.issues) {
      const issuePath = issue.path.map(String);
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          const path = [...issuePath, key];
          report(
            "UNKNOWN_KEY",
            "warning",
            `Unknown setting "${formatPath(path)}" is ignored.`,
            `Remove "${key}" from ${locate(path).label} or check its spelling.`,
            path,
          );
          deleteAt(candidate, path);
          progressed = true;
        }
        continue;
      }
      // Arrays are single values: an invalid item invalidates the whole array.
      const firstIndex = issue.path.findIndex((segment) => typeof segment === "number");
      const path = firstIndex === -1 ? issuePath : issuePath.slice(0, firstIndex);
      const key = formatPath(path);
      if (handled.has(key)) continue;
      handled.add(key);
      progressed = true;
      const value = getAt(candidate, path);
      if (value === undefined) {
        report(
          "REQUIRED_MISSING",
          "error",
          `Required setting "${key}" is missing.`,
          `Add "${key}" (${describeIssue(issue)}) to ${fileName}.`,
          path,
        );
        continue;
      }
      const where = locate(path).label;
      const fallback = getAt(defaults, path);
      const found = provenanceOf(provenance, path);
      const fromDefault = found?.source === "default";
      report(
        "INVALID_VALUE",
        "error",
        `"${key}" is ${JSON.stringify(value)} but must be ${describeIssue(issue)}. ${
          fallback !== undefined && !fromDefault
            ? `Using the default (${JSON.stringify(fallback)}) instead.`
            : "It is ignored."
        }`,
        `Change "${key}" in ${where} to ${describeIssue(issue)}.`,
        path,
      );
      if (fallback !== undefined && !fromDefault) {
        setAt(candidate, path, clone(fallback));
        provenance.set(key, { source: "default", note: "fallback for an invalid value" });
      } else {
        deleteAt(candidate, path);
      }
    }
    if (!progressed) break;
  }

  const final = config ?? (candidate as unknown as Config);
  const settings = selected ? final.environments?.[selected.name] : undefined;
  return {
    config: final,
    environment:
      selected && settings
        ? { name: selected.name, settings, selectedBy: selected.selectedBy }
        : undefined,
    provenance: Object.fromEntries(provenance),
    diagnostics,
  };
}
