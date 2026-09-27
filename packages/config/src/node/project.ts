import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { brand } from "@testament/brand";
import { isScalar, Scalar, stringify } from "yaml";
import type { Diagnostic } from "../diagnostics.js";
import { isPlainObject } from "../paths.js";
import type { ConfigRegistry } from "../registry.js";
import { type ResolvedProject, resolveConfig } from "../resolve.js";
import type { ConfigPatch, RunOptions } from "../schema.js";
import { parseYaml } from "./yaml-file.js";

/** Path of the project file inside `dir`. */
export function projectFile(dir: string): string {
  return join(dir, brand.configFileName);
}

/** Finds the nearest folder at or above `fromDir` that contains the project file. */
export function findProject(fromDir: string): string | undefined {
  let dir = resolve(fromDir);
  for (;;) {
    if (existsSync(projectFile(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface LoadProjectOptions {
  /** Environment to resolve; otherwise env var, defaultEnvironment, or the only one. */
  environment?: string | undefined;
  /** Highest-precedence values from the caller (CLI flags, app). */
  runOptions?: RunOptions | undefined;
  /** Environment variables to read. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  registry?: ConfigRegistry | undefined;
}

export interface LoadedProject extends ResolvedProject {
  /** Absolute path of the project file (whether or not it exists). */
  file: string;
}

/** Reads, validates and resolves the project in `dir`. Never throws on user mistakes. */
export function loadProject(dir: string, options: LoadProjectOptions = {}): LoadedProject {
  const file = projectFile(resolve(dir));
  const common = {
    projectFile: file,
    environment: options.environment,
    runOptions: options.runOptions,
    env: options.env ?? process.env,
    registry: options.registry,
  };
  if (!existsSync(file)) {
    const missing: Diagnostic = {
      code: "PROJECT_NOT_FOUND",
      severity: "error",
      file,
      message: `No ${brand.configFileName} in ${resolve(dir)}.`,
      fix: `Create a project there (the app's "New project", or \`${brand.cliName} init\`), or run from inside a project folder.`,
    };
    return { file, ...resolveConfig({ ...common, diagnostics: [missing] }) };
  }
  const parsed = parseYaml(readFileSync(file, "utf8"), file);
  return {
    file,
    ...resolveConfig({
      ...common,
      project: parsed.value ?? null,
      lineOf: parsed.lineOf,
      diagnostics: parsed.diagnostics,
    }),
  };
}

interface PatchOp {
  path: string[];
  value: unknown;
}

function flattenPatch(patch: unknown, path: string[] = []): PatchOp[] {
  if (isPlainObject(patch) && Object.keys(patch).length > 0) {
    return Object.entries(patch).flatMap(([key, value]) =>
      value === undefined ? [] : flattenPatch(value, [...path, key]),
    );
  }
  return [{ path, value: patch }];
}

function renderScalar(value: string | number | boolean, type: Scalar["type"]): string {
  if (typeof value !== "string") return String(value);
  if (type === Scalar.QUOTE_DOUBLE) return JSON.stringify(value);
  if (type === Scalar.QUOTE_SINGLE) return `'${value.replace(/'/g, "''")}'`;
  const plain = stringify(value).replace(/\n$/, "");
  return plain.includes("\n") || /[,[\]{}]/.test(plain) ? JSON.stringify(value) : plain;
}

/**
 * Applies `patch` to YAML text. Changing an existing plain value splices only
 * that value's characters, so the rest of the file stays byte-identical.
 * Adding or removing keys, or replacing lists, goes through the YAML document
 * model, which keeps comments and key order but may normalise spacing.
 */
export function applyPatch(text: string, patch: ConfigPatch): string {
  const { doc } = parseYaml(text, "patch");
  const ops = flattenPatch(patch);
  const splices: { start: number; end: number; text: string }[] = [];
  let structural = false;
  for (const op of ops) {
    const node = doc.getIn(op.path, true);
    const value = op.value;
    const scalarValue =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    if (
      scalarValue &&
      isScalar(node) &&
      node.range &&
      (node.type === Scalar.PLAIN ||
        node.type === Scalar.QUOTE_DOUBLE ||
        node.type === Scalar.QUOTE_SINGLE)
    ) {
      splices.push({
        start: node.range[0],
        end: node.range[1],
        text: renderScalar(value, node.type),
      });
    } else {
      structural = true;
    }
  }
  if (!structural) {
    return splices
      .sort((a, b) => b.start - a.start)
      .reduce(
        (out, splice) => out.slice(0, splice.start) + splice.text + out.slice(splice.end),
        text,
      );
  }
  for (const op of ops) {
    if (op.value === null) doc.deleteIn(op.path);
    else doc.setIn(op.path, op.value);
  }
  return String(doc);
}

export interface SaveResult {
  /** False when the change was refused; the file is untouched. */
  ok: boolean;
  file: string;
  /** On refusal: the new errors the change would introduce. Otherwise: all diagnostics after saving. */
  diagnostics: Diagnostic[];
}

const errorKey = (d: Diagnostic) => `${d.code}|${d.path ?? ""}`;

function validateText(text: string, file: string, registry?: ConfigRegistry) {
  const parsed = parseYaml(text, file);
  const options = {
    project: parsed.value ?? null,
    projectFile: file,
    lineOf: parsed.lineOf,
    diagnostics: parsed.diagnostics,
    env: {},
  };
  return resolveConfig({ ...options, registry }).diagnostics;
}

/**
 * Applies a change to the project file, keeping comments and order. The change
 * is validated first and refused if it introduces errors; the write is atomic.
 */
export function saveProject(
  dir: string,
  patch: ConfigPatch,
  options: { registry?: ConfigRegistry } = {},
): SaveResult {
  const file = projectFile(resolve(dir));
  if (!existsSync(file)) {
    return {
      ok: false,
      file,
      diagnostics: [
        {
          code: "PROJECT_NOT_FOUND",
          severity: "error",
          file,
          message: `No ${brand.configFileName} in ${resolve(dir)}.`,
          fix: "Create the project before saving settings.",
        },
      ],
    };
  }
  const before = readFileSync(file, "utf8");
  const after = applyPatch(before, patch);
  const existing = new Set(
    validateText(before, file, options.registry)
      .filter((d) => d.severity === "error")
      .map(errorKey),
  );
  const diagnostics = validateText(after, file, options.registry);
  const introduced = diagnostics.filter(
    (d) => d.severity === "error" && !existing.has(errorKey(d)),
  );
  if (introduced.length > 0) return { ok: false, file, diagnostics: introduced };
  if (after !== before) writeAtomic(file, after);
  return { ok: true, file, diagnostics };
}

function writeAtomic(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, content);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export interface CreateProjectOptions {
  name: string;
  target: "web" | "android";
  /** Web: base URL of the first environment ("local"). Default http://localhost:3000. */
  baseUrl?: string;
  /** Android: APK path or upload reference of the first environment. */
  app?: string;
  /** Project-relative tests folder. Default `tests`. */
  testsDir?: string;
  /** Names of secrets or keys to list (without values) in `.env.example`. */
  envNames?: string[];
}

export interface CreateProjectResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

const yamlScalar = (value: string) => stringify(value).replace(/\n$/, "");

function configTemplate(options: CreateProjectOptions): string {
  const location =
    options.target === "web"
      ? `    baseUrl: ${yamlScalar(options.baseUrl ?? "http://localhost:3000")}\n` +
        "    # Sites tests may visit. Defaults to the host of baseUrl.\n" +
        "    # allowedDomains: [localhost]\n"
      : options.app
        ? `    app: ${yamlScalar(options.app)}\n`
        : "    # Path to your APK, or an upload reference.\n    # app: path/to/app.apk\n";
  return `# yaml-language-server: $schema=https://${brand.domain}/schema/config.v1.json
# ${brand.productName} project settings. Secret VALUES never go in this file:
# put them in .env or .env.<environment> (see .env.example).
version: 1

project:
  name: ${yamlScalar(options.name)}
  # web or android
  target: ${options.target}

${
  options.testsDir && options.testsDir !== "tests"
    ? `# Where the .test.md files are.\ntests:\n  dir: ${yamlScalar(options.testsDir)}\n\n`
    : ""
}# Environment used when none is chosen.
defaultEnvironment: local

environments:
  local:
${location}    # true blocks destructive actions (delete, pay, send, invite, cancel).
    production: false

# Secrets tests may use, and the only domains each may be typed into.
# Example:
#   TEST_PASSWORD:
#     domains: [localhost]
#     description: Password of the test user
secrets: {}

run:
  # Extra attempts after a failure.
  retries: 1
  # strict: never heal | review: propose fixes for approval | auto: apply and flag
  healPolicy: review
`;
}

const envExample = (names: readonly string[] = []) =>
  `# Secret values. Copy to .env (all environments) or .env.<environment>
# (e.g. .env.staging) and fill in. Never commit the copies.
${names.length ? names.map((name) => `${name}=`).join("\n") : "# TEST_PASSWORD="}
`;

/**
 * Creates a new project in `dir`: a commented project file, `.env.example`, and
 * `.gitignore` entries for `.env*` and the local data folder. The data folder
 * next to the tests (recordings and generated specs) stays committed, except its
 * authoring reports. Never overwrites an existing file; missing `.gitignore`
 * lines are appended, so running it again changes nothing.
 */
export function createProject(dir: string, options: CreateProjectOptions): CreateProjectResult {
  const root = resolve(dir);
  const result: CreateProjectResult = { created: [], updated: [], skipped: [] };
  const writeNew = (name: string, content: string) => {
    const path = join(root, name);
    if (existsSync(path)) result.skipped.push(name);
    else {
      writeFileSync(path, content, { flag: "wx" });
      result.created.push(name);
    }
  };
  writeNew(brand.configFileName, configTemplate(options));
  writeNew(".env.example", envExample(options.envNames));

  const testsData = `/${(options.testsDir ?? "tests").replace(/^\/+|\/+$/g, "")}/${brand.dataDirName}/`;
  const entries = [
    ".env",
    ".env.*",
    "!.env.example",
    `${brand.dataDirName}/`,
    `!${testsData}`,
    `${testsData}authoring/`,
  ];
  const gitignore = join(root, ".gitignore");
  if (!existsSync(gitignore)) {
    writeNew(
      ".gitignore",
      `# ${brand.productName}: local secrets and data\n${entries.join("\n")}\n`,
    );
  } else {
    const current = readFileSync(gitignore, "utf8");
    const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const missing = entries.filter((entry) => !present.has(entry));
    if (missing.length === 0) result.skipped.push(".gitignore");
    else {
      const separator = current === "" || current.endsWith("\n") ? "" : "\n";
      writeFileSync(
        gitignore,
        `${current}${separator}\n# ${brand.productName}: local secrets and data\n${missing.join("\n")}\n`,
      );
      result.updated.push(".gitignore");
    }
  }
  return result;
}
