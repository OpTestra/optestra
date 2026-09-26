/** Node entry: finding and loading the tests of a project on disk. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Config } from "@testament/config";
import { type SpecDiagnostic, sortDiagnostics } from "../diagnostics.js";
import { type ExpandedTest, expandTest, type FileReader, normalizePath } from "../expand.js";
import type { GeneratorRegistry } from "../generators.js";
import { matchesAny } from "../glob.js";
import type { TestSpec } from "../model.js";
import { parseTest } from "../parse.js";
import type { TestsSettings } from "../section.js";
import "../section.js";
import "../lint/section.js";

export const DEFAULT_TESTS: TestsSettings = { dir: "tests", include: ["**/*.test.md"] };
const SKIP = new Set(["node_modules", "dist"]);

/** Reads project-relative paths under `projectDir`; refuses paths that leave it. */
export function nodeFileReader(projectDir: string): FileReader {
  const root = resolve(projectDir);
  return (path) => {
    const clean = normalizePath(path);
    if (clean === undefined || clean === "") return undefined;
    const full = resolve(root, clean);
    if (relative(root, full).startsWith("..")) return undefined;
    try {
      return readFileSync(full, "utf8");
    } catch {
      return undefined;
    }
  };
}

const toPosix = (path: string) => path.split(sep).join("/");

/** Project-relative paths of every test and flow file, sorted. */
export function findTestFiles(
  projectDir: string,
  settings: TestsSettings = DEFAULT_TESTS,
): string[] {
  const dir = normalizePath(settings.dir) ?? "tests";
  const base = join(resolve(projectDir), dir);
  const out: string[] = [];
  const walk = (folder: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        const rel = toPosix(relative(base, full));
        if (matchesAny(settings.include, rel)) out.push(dir === "" ? rel : `${dir}/${rel}`);
      }
    }
  };
  walk(base);
  return out.sort();
}

export interface LoadTestsOptions {
  /** Environment whose overrides and vars apply. */
  environment?: string | undefined;
  /** Run seed for generated values. Default `preview`. */
  seed?: string | undefined;
  generators?: GeneratorRegistry | undefined;
  emailDomain?: string | undefined;
}

export interface LoadedTest {
  id: string;
  path: string;
  spec: TestSpec;
  /** Parse problems plus, for tests, the problems found while expanding (flows, params, env). */
  diagnostics: SpecDiagnostic[];
  /** The runnable form. For flows: the flow run on its own. */
  expanded: ExpandedTest;
}

export interface LoadedTests {
  /** Project-relative tests folder. */
  dir: string;
  /** Runnable tests (`kind: test`), sorted by path. */
  tests: LoadedTest[];
  /** Flows (`kind: flow`): loadable, not runnable on their own in a suite. */
  flows: LoadedTest[];
  /** Project-level problems (e.g. no tests folder). */
  diagnostics: SpecDiagnostic[];
}

/**
 * Loads one file. `config` is the resolved project config, or undefined when
 * the project has no project file (then secrets are not checked).
 */
export async function loadTest(
  projectDir: string,
  path: string,
  config: Config | undefined,
  options: LoadTestsOptions = {},
): Promise<LoadedTest | undefined> {
  const readFile = nodeFileReader(projectDir);
  const text = await readFile(path);
  if (text === undefined) return undefined;
  const parsed = parseTest(text, path, { config, generators: options.generators });
  const vars = options.environment ? config?.environments[options.environment]?.vars : undefined;
  const expanded = await expandTest(parsed.spec, {
    readFile,
    seed: options.seed ?? "preview",
    environment: options.environment,
    vars,
    testsDir: config?.tests?.dir ?? DEFAULT_TESTS.dir,
    config,
    generators: options.generators,
    emailDomain: options.emailDomain,
  });
  const own =
    parsed.spec.frontmatter.kind === "flow"
      ? expanded.diagnostics.filter((d) => d.code !== "FLOW_PARAM_MISSING" || d.file !== path)
      : expanded.diagnostics;
  return {
    id: expanded.id,
    path,
    spec: parsed.spec,
    diagnostics: sortDiagnostics(dedupe([...parsed.diagnostics, ...own])),
    expanded,
  };
}

function dedupe(diagnostics: SpecDiagnostic[]): SpecDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const id = JSON.stringify([d.code, d.file, d.range, d.message]);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Loads every test and flow of a project. Never throws on user mistakes. */
export async function loadTests(
  projectDir: string,
  config: Config | undefined,
  options: LoadTestsOptions = {},
): Promise<LoadedTests> {
  const settings = config?.tests ?? DEFAULT_TESTS;
  const dir = normalizePath(settings.dir) ?? DEFAULT_TESTS.dir;
  const diagnostics: SpecDiagnostic[] = [];
  let exists = true;
  try {
    readdirSync(join(resolve(projectDir), dir));
  } catch {
    exists = false;
    diagnostics.push({
      code: "TESTS_DIR_MISSING",
      severity: "warning",
      message: `There is no ${dir}/ folder in ${resolve(projectDir)}, so there are no tests.`,
      fix: `Create ${dir}/ and add a .test.md file, or set tests.dir in the project settings.`,
      path: "tests.dir",
    });
  }
  const tests: LoadedTest[] = [];
  const flows: LoadedTest[] = [];
  if (exists) {
    for (const path of findTestFiles(projectDir, { ...settings, dir })) {
      const loaded = await loadTest(projectDir, path, config, options);
      if (!loaded) continue;
      (loaded.spec.frontmatter.kind === "flow" ? flows : tests).push(loaded);
    }
  }
  return { dir, tests, flows, diagnostics };
}
