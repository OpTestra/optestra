import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { brand } from "@testament/brand";
import { type Config, hasErrors } from "@testament/config";
import { loadProject } from "@testament/config/node";
import { DEFAULT_EMAIL_DOMAIN, parseTest, type TestSpec } from "@testament/spec";
import { DEFAULT_TESTS, findTestFiles, loadTest, nodeFileReader } from "@testament/spec/node";
import { fileState } from "../header.js";
import { readCodegenRecording } from "../recording.js";
import { type GeneratedFile, generateSpec, recordingFileName } from "../spec.js";
import { generateSupportFiles, type SupportEnvironment } from "../support.js";

// Generating a project's specs: find the tests that have recordings, generate
// each spec plus the shared files, and write them next to the recordings
// without ever overwriting a hand-edited file (unless forced).

export interface GenerateProjectOptions {
  projectDir: string;
  /** Test files or folders (absolute, or relative to `cwd`); default: every test. */
  tests?: readonly string[] | undefined;
  /** Where relative `tests` are resolved from. Default: `projectDir`. */
  cwd?: string | undefined;
  /** Environment whose base URL, allowed domains and secret domains are baked in. */
  environment?: string | undefined;
  /** Process environment for config resolution. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Overwrite hand-edited files. */
  force?: boolean;
  /** Compare only, write nothing (CI). */
  check?: boolean;
  /**
   * Write somewhere else than `<tests dir>/<data dir>/` (export): `dir` is the
   * absolute folder, `label` how it is named in results and in the config's
   * comment. Upload paths stay relative to the folder's parent.
   */
  out?: { dir: string; label: string } | undefined;
}

export type FileStatus =
  /** Written for the first time. */
  | "created"
  /** Rewritten: the recording or test changed. */
  | "updated"
  /** Already up to date. */
  | "unchanged"
  /** `check` only: would be created or rewritten. */
  | "stale"
  /** Changed by hand since it was generated; left alone (or reported with `check`). */
  | "edited"
  /** Changed by hand, overwritten because of `force`. */
  | "overwritten";

export interface FileResult {
  /** Project-relative, `/`-separated. */
  path: string;
  status: FileStatus;
  /** The test it belongs to (specs only). */
  test?: string;
}

export interface GenerateProjectResult {
  /** `false` when the project couldn't be loaded; see `problems`. */
  ok: boolean;
  files: FileResult[];
  /** Tests without a usable recording. */
  skipped: Array<{ test: string; reason: string }>;
  problems: string[];
}

const posix = (path: string) => path.split(sep).join("/");

/** The environment the shared files are generated for, from the resolved project. */
export function supportEnvironment(
  config: Config,
  environment: { name: string; settings: Config["environments"][string] } | undefined,
  specDir: string,
): SupportEnvironment | string {
  const settings = environment?.settings;
  if (!settings?.baseUrl) {
    return `The environment${environment ? ` "${environment.name}"` : ""} has no baseUrl. Choose one with --env, or set baseUrl.`;
  }
  const secrets: Record<string, string[]> = {};
  for (const [name, declaration] of Object.entries(config.secrets)) {
    secrets[name] = [...(settings.secrets?.[name]?.domains ?? declaration.domains)];
  }
  return {
    name: environment?.name ?? null,
    baseUrl: settings.baseUrl,
    allowedDomains: [...settings.allowedDomains],
    vars: { ...settings.vars },
    secrets,
    emailDomain: DEFAULT_EMAIL_DOMAIN,
    timeoutSeconds: settings.run?.timeoutSeconds ?? config.run.timeoutSeconds,
    retries: settings.run?.retries ?? config.run.retries,
    specDir,
  };
}

function writeAtomic(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, file);
}

/** Decides what happens to one generated file and (unless checking) writes it. */
function place(
  file: string,
  generated: GeneratedFile,
  options: Pick<GenerateProjectOptions, "force" | "check">,
): FileStatus {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (existing === generated.content) return "unchanged";
  const state = existing === undefined ? undefined : fileState(existing);
  const edited = state === "edited" || state === "foreign";
  if (options.check) return edited ? "edited" : "stale";
  if (edited && !options.force) return "edited";
  writeAtomic(file, generated.content);
  if (existing === undefined) return "created";
  return edited ? "overwritten" : "updated";
}

function selected(
  projectDir: string,
  all: string[],
  wanted: readonly string[] | undefined,
  cwd: string,
) {
  if (!wanted || wanted.length === 0) return all;
  const picks = wanted.map((entry) => {
    const absolute = isAbsolute(entry) ? entry : resolve(cwd, entry);
    const rel = posix(relative(projectDir, absolute));
    const isDir = existsSync(absolute) && statSync(absolute).isDirectory();
    return { rel, isDir };
  });
  return all.filter((path) =>
    picks.some(({ rel, isDir }) =>
      isDir ? rel === "" || path.startsWith(`${rel}/`) : path === rel,
    ),
  );
}

/**
 * Generates the specs of a project's recorded tests, plus the shared fixtures
 * and config, into `<tests dir>/<data dir>/`. Hand-edited files are never
 * overwritten unless `force` is set; `check` only reports.
 */
export async function generateProject(
  options: GenerateProjectOptions,
): Promise<GenerateProjectResult> {
  const projectDir = resolve(options.projectDir);
  const cwd = options.cwd ?? projectDir;
  const loaded = loadProject(projectDir, {
    environment: options.environment,
    env: options.env ?? process.env,
  });
  const result: GenerateProjectResult = { ok: true, files: [], skipped: [], problems: [] };
  if (hasErrors(loaded.diagnostics)) {
    result.ok = false;
    result.problems.push(
      ...loaded.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `${d.code}: ${d.message} Fix: ${d.fix}`),
    );
    return result;
  }
  const config = loaded.config;
  const testsSettings = config.tests ?? DEFAULT_TESTS;
  const testsDir = testsSettings.dir;
  const specDir = options.out?.label ?? posix(join(testsDir, brand.dataDirName));
  const environment = supportEnvironment(config, loaded.environment, specDir);
  if (typeof environment === "string") {
    result.ok = false;
    result.problems.push(environment);
    return result;
  }
  const recordingsDir = join(projectDir, testsDir, brand.dataDirName);
  const outDir = options.out?.dir ?? join(projectDir, specDir);
  const readFile = nodeFileReader(projectDir);
  const files = selected(projectDir, findTestFiles(projectDir, testsSettings), options.tests, cwd);
  const generated: Array<{ file: GeneratedFile; test?: string }> = [];
  for (const path of files) {
    const test = await loadTest(projectDir, path, config, {
      environment: loaded.environment?.name,
      seed: "codegen",
    });
    if (test?.expanded.kind !== "test") continue;
    const recordingFile = join(recordingsDir, recordingFileName(test.id));
    if (!existsSync(recordingFile)) {
      result.skipped.push({ test: path, reason: "not recorded yet" });
      continue;
    }
    const recording = readCodegenRecording(readFileSync(recordingFile, "utf8"));
    if (!recording.ok) {
      result.skipped.push({ test: path, reason: `recording can't be read: ${recording.error}` });
      continue;
    }
    const specs: Record<string, TestSpec> = { [path]: test.spec };
    for (const file of test.expanded.files) {
      if (specs[file]) continue;
      const text = await readFile(file);
      if (text !== undefined) specs[file] = parseTest(text, file, { config }).spec;
    }
    generated.push({
      file: generateSpec(recording.recording, { expanded: test.expanded, specs }),
      test: path,
    });
  }
  if (generated.length > 0) {
    for (const file of generateSupportFiles(environment)) generated.push({ file });
  }
  if (!options.check && generated.length > 0) mkdirSync(outDir, { recursive: true });
  for (const { file, test } of generated) {
    const status = place(join(outDir, file.name), file, options);
    result.files.push({ path: `${specDir}/${file.name}`, status, ...(test ? { test } : {}) });
  }
  return result;
}

/**
 * What the author and the replayer call after a test was recorded: regenerates
 * that test's spec (and the shared files) unless they were edited by hand.
 */
export function generateAfterRecording(
  projectDir: string,
  testPath: string,
  options: Pick<GenerateProjectOptions, "environment" | "env" | "force"> = {},
): Promise<GenerateProjectResult> {
  return generateProject({ ...options, projectDir, tests: [testPath], cwd: projectDir });
}
