import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { type Config, hasErrors } from "@optestra/config";
import { loadProject, parseYaml } from "@optestra/config/node";
import { DEFAULT_EMAIL_DOMAIN, parseTest, type TestSpec } from "@optestra/spec";
import { DEFAULT_TESTS, findTestFiles, loadTest, nodeFileReader } from "@optestra/spec/node";
import { fileState } from "../header.js";
import { generateMaestroFlow } from "../maestro.js";
import { recordingBranch, recordingFiles } from "@optestra/recording/node";
import { PageObjects } from "../page-objects.js";
import { readCodegenRecording } from "../recording.js";
import { type GeneratedFile, generateSpec } from "../spec.js";
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
  /**
   * EXP-4: page objects. Locators go to a class per page (`pages/`), flows and
   * auth logins to shared helpers (`flows/`). Off by default.
   */
  pageObjects?: boolean | undefined;
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
  /** Android (Maestro flows): what only the product checks, one line each. */
  gaps?: string[];
  /** Android: env vars the flow needs at run time (secrets). */
  secrets?: string[];
  /** Android: the app's package. */
  appId?: string;
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
  mkdirSync(dirname(file), { recursive: true });
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
  // Android projects (MOB-6): a Maestro flow per test, no Playwright files.
  const android = config.project?.target === "android";
  const environment = android ? undefined : supportEnvironment(config, loaded.environment, specDir);
  if (typeof environment === "string") {
    result.ok = false;
    result.problems.push(environment);
    return result;
  }
  const extras = new Map<string, Pick<FileResult, "gaps" | "secrets" | "appId">>();
  // REP-8: on a feature branch, its own recordings come first.
  const branch = recordingBranch(
    config.recordings ?? { branches: "auto" },
    options.env ?? process.env,
    projectDir,
  );
  const recordingOf = (id: string) => recordingFiles(join(projectDir, testsDir), id, branch).read;
  const outDir = options.out?.dir ?? join(projectDir, specDir);
  const readFile = nodeFileReader(projectDir);
  const files = selected(projectDir, findTestFiles(projectDir, testsSettings), options.tests, cwd);
  const generated: Array<{ file: GeneratedFile; test?: string }> = [];
  const pageObjects = options.pageObjects && !android ? new PageObjects() : undefined;
  for (const path of files) {
    const test = await loadTest(projectDir, path, config, {
      environment: loaded.environment?.name,
      seed: "codegen",
    });
    if (test?.expanded.kind !== "test") continue;
    const recordingFile = recordingOf(test.id);
    if (!existsSync(recordingFile)) {
      result.skipped.push({ test: path, reason: "not recorded yet" });
      continue;
    }
    const recording = readCodegenRecording(readFileSync(recordingFile, "utf8"));
    if (!recording.ok) {
      result.skipped.push({ test: path, reason: `recording can't be read: ${recording.error}` });
      continue;
    }
    if (android) {
      const flow = generateMaestroFlow(recording.recording, {
        expanded: test.expanded,
        ...(loaded.environment?.settings.baseUrl
          ? { baseUrl: loaded.environment.settings.baseUrl }
          : {}),
      });
      if ("error" in flow) {
        result.skipped.push({ test: path, reason: flow.error });
        continue;
      }
      extras.set(flow.name, { gaps: flow.gaps, secrets: flow.secrets, appId: flow.appId });
      generated.push({ file: { name: flow.name, content: flow.content }, test: path });
      continue;
    }
    const specs: Record<string, TestSpec> = { [path]: test.spec };
    for (const file of test.expanded.files) {
      if (specs[file]) continue;
      const text = await readFile(file);
      if (text !== undefined) specs[file] = parseTest(text, file, { config }).spec;
    }
    // auth: <profile> (SEC-3): the spec logs in with the profile's flow, from its own recording.
    let profile: Parameters<typeof generateSpec>[1]["profile"];
    const auth = test.expanded.auth;
    const profiles = authProfiles(config, loaded.file);
    const settings = auth && auth !== "none" ? profiles?.[auth] : undefined;
    if (auth && settings) {
      const flowPath = posix(join(testsDir, settings.flow));
      const flow = await loadTest(projectDir, flowPath, config, {
        environment: loaded.environment?.name,
        seed: "codegen",
        params: settings.params,
      });
      const flowFile = flow ? recordingOf(flow.id) : undefined;
      const flowRecording =
        flowFile && existsSync(flowFile)
          ? readCodegenRecording(readFileSync(flowFile, "utf8"))
          : undefined;
      if (flow && flowRecording?.ok) {
        for (const file of [flowPath, ...flow.expanded.files]) {
          if (specs[file]) continue;
          const text = await readFile(file);
          if (text !== undefined) specs[file] = parseTest(text, file, { config }).spec;
        }
        profile = {
          name: auth,
          path: flowPath,
          expanded: flow.expanded,
          recording: flowRecording.recording,
          params: settings.params ?? {},
        };
      }
    }
    generated.push({
      file: generateSpec(recording.recording, {
        expanded: test.expanded,
        specs,
        ...(profile ? { profile } : {}),
        ...(pageObjects ? { pageObjects } : {}),
      }),
      test: path,
    });
  }
  if (pageObjects) for (const file of pageObjects.files()) generated.push({ file });
  if (generated.length > 0 && environment) {
    for (const file of generateSupportFiles(environment)) generated.push({ file });
  }
  if (!options.check && generated.length > 0) mkdirSync(outDir, { recursive: true });
  for (const { file, test } of generated) {
    const status = place(join(outDir, file.name), file, options);
    result.files.push({
      path: `${specDir}/${file.name}`,
      status,
      ...(test ? { test } : {}),
      ...extras.get(file.name),
    });
  }
  return result;
}

interface ProfileSettings {
  flow: string;
  params?: Record<string, string>;
}

/**
 * The project's auth profiles (flow and params only). The `auth` section belongs
 * to @optestra/auth, which codegen doesn't import: when it isn't registered the
 * section is read from the project file itself.
 */
function authProfiles(config: object, file: string): Record<string, ProfileSettings> {
  const registered = (config as { auth?: { profiles?: Record<string, ProfileSettings> } }).auth;
  if (registered) return registered.profiles ?? {};
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"), file).value;
  } catch {
    return {};
  }
  const profiles = (raw as { auth?: { profiles?: unknown } } | undefined)?.auth?.profiles;
  if (!profiles || typeof profiles !== "object") return {};
  const out: Record<string, ProfileSettings> = {};
  for (const [name, value] of Object.entries(profiles as Record<string, unknown>)) {
    const entry = value as { flow?: unknown; params?: unknown };
    if (typeof entry?.flow !== "string") continue;
    const params =
      entry.params && typeof entry.params === "object"
        ? Object.fromEntries(
            Object.entries(entry.params as Record<string, unknown>).filter(
              (p): p is [string, string] => typeof p[1] === "string",
            ),
          )
        : undefined;
    out[name] = { flow: entry.flow, ...(params ? { params } : {}) };
  }
  return out;
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
