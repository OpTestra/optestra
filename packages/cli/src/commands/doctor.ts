import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInbox } from "@testament/auth";
import { brand } from "@testament/brand";
import type { Config, Diagnostic } from "@testament/config";
import {
  defaultRedactor,
  dotenvSource,
  findProject,
  type LoadedProject,
  loadProject,
  processEnvSource,
  projectFile,
  resolveSecrets,
  type SecretSource,
} from "@testament/config/node";
import type { DecisionsSettings, ModelBackendId } from "@testament/decide";
import {
  type BackendCheck,
  checkLaya,
  checkSystemOne,
  resolveDecisionBackend,
} from "@testament/decide/node";
import {
  checkProviders,
  isDelegatedKind,
  MODEL_ROLES,
  resolvePools,
  resolveProviders,
  VENDOR_LABEL,
} from "@testament/models";
import { recordingPath } from "@testament/recording/node";
import { DEFAULT_TESTS, loadTests } from "@testament/spec/node";
import type { Command } from "commander";
import type { CommandIo } from "./config.js";
import { runLintCommand } from "./lint.js";
import { playwrightOverlap } from "./playwright-setup.js";

// `doctor` (ONB-4): every way a project can be broken, one line each, with the
// exact command or edit that fixes it. Read-only: it writes nothing. The network
// is only used through the packages that already own it: the browser harness
// (base URLs, allowlisted), the models package (key checks), the decision
// backends' checks and the inbox check.

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  /** Stable id, e.g. `node`, `secrets`, `base-url:local`. */
  id: string;
  title: string;
  status: DoctorStatus;
  message: string;
  /** The exact command or edit that fixes it. Present on every warn and fail. */
  fix?: string;
  /** Extra lines (one per problem), each already carrying its own fix when it has one. */
  details?: string[];
}

export interface DoctorReport {
  /** Version of this JSON shape. */
  schema: 1;
  /** The project folder, or null when none was found. */
  project: string | null;
  /** Environments checked. */
  environments: string[];
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number; skip: number };
  /** 0 all ok, 1 warnings with `strict`, 2 any failure. */
  exitCode: 0 | 1 | 2;
}

/** A browser the checks can send requests through. */
export interface DoctorBrowser {
  /** GET `baseUrl` through the harness's request path (allowlisted, no redirects followed). */
  request(
    baseUrl: string,
    allowedDomains: readonly string[],
  ): Promise<{
    status: "ok" | "failed" | "refused" | "error";
    httpStatus?: number;
    message?: string;
  }>;
  close(): Promise<void>;
}

export interface DoctorProbes {
  /** Starts Chromium, or says why it can't. */
  openBrowser(): Promise<DoctorBrowser | { error: string; fix: string }>;
}

export interface DoctorOptions {
  /** Project folder, or any folder inside it. */
  dir: string;
  /** Check only this environment (default: every environment). */
  environment?: string | undefined;
  /** Environment variables (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Warnings make the exit code 1. */
  strict?: boolean;
  /** Test hook: replaces the real browser. */
  probes?: DoctorProbes;
}

const MIN_NODE = 24;

function nodeCheck(): DoctorCheck {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  return major >= MIN_NODE
    ? { id: "node", title: "Node.js", status: "ok", message: `v${version}` }
    : {
        id: "node",
        title: "Node.js",
        status: "fail",
        message: `v${version} is too old; ${brand.productName} needs Node ${MIN_NODE} or newer.`,
        fix: `Install Node ${MIN_NODE} (https://nodejs.org, or \`nvm install ${MIN_NODE}\`).`,
      };
}

/** Ends a fix with a full stop when it has none. */
const sentence = (text: string) => (/[.!?)`]$/.test(text) ? text : `${text}.`);

const diagnosticLine = (d: Pick<Diagnostic, "code" | "message" | "fix" | "line">) =>
  `${d.code}${d.line ? ` (line ${d.line})` : ""}: ${d.message} Fix: ${d.fix}`;

function projectCheck(loaded: LoadedProject, dir: string): DoctorCheck {
  const file = relative(dir, loaded.file) || loaded.file;
  const errors = loaded.diagnostics.filter((d) => d.severity === "error");
  const warnings = loaded.diagnostics.filter((d) => d.severity !== "error");
  if (errors.length > 0) {
    const first = errors[0] as Diagnostic;
    return {
      id: "project",
      title: "Project file",
      status: "fail",
      message: `${file} has ${errors.length} error${errors.length === 1 ? "" : "s"}${warnings.length ? ` and ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}.`,
      fix: errors.length === 1 ? first.fix : `${first.fix} (then the other lines below)`,
      details: [...errors, ...warnings].map(diagnosticLine),
    };
  }
  if (warnings.length > 0) {
    return {
      id: "project",
      title: "Project file",
      status: "warn",
      message: `${file} is valid, with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`,
      fix: (warnings[0] as Diagnostic).fix,
      details: warnings.map(diagnosticLine),
    };
  }
  return { id: "project", title: "Project file", status: "ok", message: `${file} is valid.` };
}

async function testsCheck(
  dir: string,
  environment: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<DoctorCheck> {
  let json = "";
  await runLintCommand(
    [],
    { json: true, dir, ...(environment ? { env: environment } : {}) },
    { cwd: dir, env, stdout: (text) => (json += text) },
  );
  const report = JSON.parse(json) as {
    summary: { files: number; errors: number; warnings: number; info: number };
    files: Array<{
      path: string;
      findings: Array<{ severity: string; rule?: string; code: string; message: string }>;
    }>;
  };
  const { files, errors, warnings } = report.summary;
  const counts = `${files} file${files === 1 ? "" : "s"}: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
  const problems = report.files.flatMap((file) =>
    file.findings
      .filter((f) => f.severity === "error" || f.severity === "warning")
      .map((f) => `${file.path}: ${f.severity} ${f.rule ?? f.code}: ${f.message.split("\n")[0]}`),
  );
  const details =
    problems.length > 10
      ? [...problems.slice(0, 10), `… and ${problems.length - 10} more`]
      : problems;
  if (files === 0) {
    return {
      id: "tests",
      title: "Tests",
      status: "warn",
      message: "No test files found.",
      fix: `Add a .test.md file to the tests folder (\`${brand.cliName} init\` writes an example).`,
    };
  }
  if (errors > 0) {
    return {
      id: "tests",
      title: "Tests",
      status: "fail",
      message: `${counts}.`,
      fix: `Run \`${brand.cliName} lint\` for each problem and its fix (\`${brand.cliName} lint --fix\` applies the safe ones).`,
      ...(details.length ? { details } : {}),
    };
  }
  if (warnings > 0) {
    return {
      id: "tests",
      title: "Tests",
      status: "warn",
      message: `${counts}.`,
      fix: `Run \`${brand.cliName} lint\` for each warning and its fix.`,
      details,
    };
  }
  return { id: "tests", title: "Tests", status: "ok", message: `${counts}.` };
}

function secretsCheck(
  dir: string,
  environments: string[],
  env: Readonly<Record<string, string | undefined>>,
  sources: readonly SecretSource[],
): DoctorCheck {
  const details: string[] = [];
  const fixes: string[] = [];
  let declared = 0;
  let set = 0;
  for (const name of environments.length ? environments : [undefined]) {
    const loaded = loadProject(dir, { environment: name, env });
    const result = resolveSecrets(loaded.config, sources, {
      environment: loaded.environment?.name,
      file: loaded.file,
    });
    const names = Object.keys(loaded.config.secrets ?? {});
    declared += names.length;
    set += Object.keys(result.secrets).length;
    const label = loaded.environment?.name ?? "default";
    for (const missing of result.missing) {
      const fix = result.diagnostics.find(
        (d) => d.code === "SECRET_MISSING" && d.path === `secrets.${missing}`,
      )?.fix;
      if (fix) fixes.push(sentence(fix));
      details.push(
        `${label}: ${missing} is not set. Fix: ${fix ? sentence(fix) : `Set ${missing}.`}`,
      );
    }
    for (const invalid of result.invalid) {
      const fix = result.diagnostics.find(
        (d) => d.code === "SECRET_INVALID" && d.path === `secrets.${invalid}`,
      )?.fix;
      if (fix) fixes.push(sentence(fix));
      details.push(
        `${label}: ${invalid} has a value that isn't valid. Fix: ${fix ? sentence(fix) : "Replace it."}`,
      );
    }
  }
  if (declared === 0) {
    return { id: "secrets", title: "Secrets", status: "ok", message: "No secrets declared." };
  }
  if (details.length > 0) {
    return {
      id: "secrets",
      title: "Secrets",
      status: "fail",
      message: `${set} of ${declared} declared secret value${declared === 1 ? "" : "s"} set (names only; values are never shown).`,
      fix:
        fixes.length === 1
          ? (fixes[0] as string)
          : "Set each one listed below (in .env, .env.<environment>, or the environment).",
      details,
    };
  }
  return {
    id: "secrets",
    title: "Secrets",
    status: "ok",
    message: `All ${declared} declared secret value${declared === 1 ? " is" : "s are"} set.`,
  };
}

async function modelsCheck(
  config: Config,
  environment: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  sources: readonly SecretSource[],
): Promise<DoctorCheck[]> {
  const providers = resolveProviders(config, sources, environment, env);
  const pools = resolvePools(config, providers);
  const resolved = MODEL_ROLES.map((role) => ({
    role,
    entry: pools[role].find((entry) => entry.usable),
  }));
  const unusable = resolved.filter((r) => !r.entry).map((r) => r.role);
  const keyNames = [
    ...new Set(
      unusable.flatMap((role) =>
        pools[role].flatMap((entry) => providers.get(entry.provider)?.settings.keySecret ?? []),
      ),
    ),
  ];
  const checks: DoctorCheck[] = [];
  if (unusable.length > 0) {
    checks.push({
      id: "models",
      title: "AI models",
      status: "fail",
      message: `No usable model for the ${unusable.join(" and ")} role${unusable.length === 1 ? "" : "s"}.`,
      fix: `Sign in to Claude Code (\`claude auth login\`) or Codex (\`codex login\`) to use your subscription, or set ${keyNames.length ? keyNames.join(", ") : "an API key"} in .env. \`${brand.cliName} login\` shows what's ready.`,
    });
    return checks;
  }
  const describe = (provider: string, model: string) => {
    const kind = providers.get(provider)?.settings.kind;
    return `${provider} / ${model}${kind && isDelegatedKind(kind) ? ` (via your ${VENDOR_LABEL[kind]})` : ""}`;
  };
  checks.push({
    id: "models",
    title: "AI models",
    status: "ok",
    message: resolved
      .map(({ role, entry }) => `${role} → ${entry ? describe(entry.provider, entry.model) : "-"}`)
      .join(", "),
  });
  // Validate the providers that will actually answer: key valid, or subscription tool signed in.
  const used = new Set(resolved.flatMap((r) => (r.entry ? [r.entry.provider] : [])));
  const models = config.models;
  const onlyUsed = {
    ...config,
    models: {
      ...models,
      providers: Object.fromEntries(
        Object.entries(models?.providers ?? {}).filter(([id]) => used.has(id)),
      ),
    },
  } as Config;
  const results = await checkProviders(onlyUsed, { sources, environment, env });
  for (const result of results) {
    const ok = result.status === "valid";
    checks.push({
      id: `provider:${result.provider}`,
      title: `AI provider ${result.provider}`,
      status: ok ? "ok" : "fail",
      message: result.message,
      ...(ok ? {} : { fix: result.fix }),
    });
  }
  return checks;
}

async function decisionsCheck(
  config: Config,
  environment: string | undefined,
  sources: readonly SecretSource[],
): Promise<DoctorCheck[]> {
  const settings = config.decisions as DecisionsSettings;
  const selection = resolveDecisionBackend(
    { secrets: config.secrets, decisions: settings },
    { sources, ...(environment ? { environment } : {}) },
  );
  const routing = `during: ${selection.during.summary}; after: ${selection.after.summary}`;
  const selected = [
    ...new Set([selection.during.selected, selection.after.selected].filter((s) => s !== "none")),
  ] as ModelBackendId[];
  const checks: DoctorCheck[] = [];
  const problems = selection.problems.map((p) => `${p.message} Fix: ${p.fix}`);
  checks.push(
    problems.length
      ? {
          id: "decisions",
          title: "Decisions",
          status: "warn",
          message: routing,
          fix: (selection.problems[0] as { fix: string }).fix,
          details: problems,
        }
      : { id: "decisions", title: "Decisions", status: "ok", message: routing },
  );
  for (const id of selected) {
    const s = settings[id];
    const apiKey = selection.keys[id].key;
    const check: BackendCheck =
      id === "laya"
        ? await checkLaya({ baseUrl: s.baseUrl, model: s.model, apiKey })
        : await checkSystemOne({
            backend: id,
            baseUrl: s.baseUrl,
            model: s.model,
            keySecret: s.keySecret,
            apiKey,
          });
    const ok = check.status === "ok";
    checks.push({
      id: `decisions:${id}`,
      title: `Decision backend ${id}`,
      status: ok ? "ok" : "fail",
      message: check.message,
      ...(ok
        ? {}
        : {
            fix:
              check.fix ??
              `Run \`${brand.cliName} decisions --check\` for details, or set decisions.backend: auto.`,
          }),
    });
  }
  return checks;
}

async function inboxCheck(
  config: Config,
  environment: string | undefined,
  sources: readonly SecretSource[],
): Promise<DoctorCheck> {
  const provider = config.inbox?.provider ?? "none";
  if (provider === "none") {
    return {
      id: "inbox",
      title: "Test inbox",
      status: "skip",
      message: "Not used (inbox.provider: none).",
    };
  }
  const created = createInbox(config, { sources, environment });
  if (!created.ok) {
    return {
      id: "inbox",
      title: "Test inbox",
      status: "fail",
      message: `${provider}: ${created.message}`,
      fix: created.fix ?? `Fix the inbox section in ${brand.configFileName}.`,
    };
  }
  const check = await created.inbox.check();
  return check.ok
    ? {
        id: "inbox",
        title: "Test inbox",
        status: "ok",
        message: `${check.provider} (${check.host}): ${check.message}`,
      }
    : {
        id: "inbox",
        title: "Test inbox",
        status: "fail",
        message: `${check.provider} (${check.host}): ${check.message}`,
        fix: check.fix ?? `Run \`${brand.cliName} inbox check\` for details.`,
      };
}

/** The real browser: Chromium through the harness, no evidence kept. */
export const harnessProbes: DoctorProbes = {
  async openBrowser() {
    const harness = await import("@testament/browser");
    let launched: Awaited<ReturnType<typeof harness.launchBrowser>>;
    try {
      launched = await harness.launchBrowser({ browser: "chromium" });
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        fix:
          error instanceof harness.BrowserSetupError
            ? error.fix
            : `Run \`${brand.cliName} install-browsers\`.`,
      };
    }
    return {
      async request(baseUrl, allowedDomains) {
        const dir = mkdtempSync(join(tmpdir(), `${brand.cliName}-doctor-`));
        try {
          const session = await harness.openSession({
            browser: launched,
            allowedDomains: [...allowedDomains],
            baseUrl,
            evidence: { video: false, trace: false, console: false, network: false, dir },
          });
          try {
            return await session.hookRequest({ method: "GET", target: baseUrl, timeoutMs: 10_000 });
          } finally {
            await session.close();
          }
        } catch (error) {
          return {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      close: () => launched.close(),
    };
  },
};

async function browserChecks(
  loaded: LoadedProject,
  environments: string[],
  probes: DoctorProbes,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (loaded.config.project?.target === "android") {
    checks.push({
      id: "browsers",
      title: "Browsers",
      status: "skip",
      message: "Android project: no browser needed.",
    });
    return checks;
  }
  const browser = await probes.openBrowser();
  if ("error" in browser) {
    checks.push({
      id: "browsers",
      title: "Browsers",
      status: "fail",
      message: `Chromium can't start: ${browser.error.split("\n")[0]}`,
      fix: browser.fix,
    });
  } else {
    checks.push({
      id: "browsers",
      title: "Browsers",
      status: "ok",
      message: "Chromium is installed and starts.",
    });
  }
  try {
    for (const name of environments) {
      const settings = loaded.config.environments[name];
      const id = `base-url:${name}`;
      const title = `Base URL (${name})`;
      if (!settings?.baseUrl) continue; // Reported by the project file check.
      const where = `environments.${name}.baseUrl in ${brand.configFileName}`;
      if ("error" in browser) {
        checks.push({
          id,
          title,
          status: "skip",
          message: `${settings.baseUrl}: needs a browser (see Browsers).`,
        });
        continue;
      }
      const result = await browser.request(settings.baseUrl, settings.allowedDomains);
      const http = result.httpStatus;
      if (result.status === "ok" || (http !== undefined && http >= 300 && http < 400)) {
        checks.push({
          id,
          title,
          status: "ok",
          message: `${settings.baseUrl} answers${http ? ` (HTTP ${http})` : ""}.`,
        });
      } else if (result.status === "failed" && http !== undefined) {
        checks.push({
          id,
          title,
          status: "warn",
          message: `${settings.baseUrl} answers HTTP ${http}.`,
          fix: `Check that ${settings.baseUrl} is your app's home page, or change ${where}.`,
        });
      } else if (result.status === "refused") {
        checks.push({
          id,
          title,
          status: "fail",
          message: `${settings.baseUrl} is outside the allowed domains (${settings.allowedDomains.join(", ") || "none"}).`,
          fix: `Add ${new URL(settings.baseUrl).host} to environments.${name}.allowedDomains in ${brand.configFileName}.`,
        });
      } else {
        checks.push({
          id,
          title,
          status: "fail",
          message: `${settings.baseUrl} can't be reached${result.message ? `: ${result.message.split("\n")[0]}` : "."}`,
          fix: `Start your app so it answers at ${settings.baseUrl}, or change ${where}.`,
        });
      }
    }
  } finally {
    if (!("error" in browser)) await browser.close();
  }
  return checks;
}

async function recordingsChecks(
  dir: string,
  loaded: LoadedProject,
  environment: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<DoctorCheck[]> {
  const config = loaded.config;
  const tests = await loadTests(dir, config, { environment });
  const testsDir = config.tests?.dir ?? DEFAULT_TESTS.dir;
  const missing = tests.tests.filter(
    (test) => !existsSync(join(dir, recordingPath(testsDir, test.id))),
  );
  const checks: DoctorCheck[] = [];
  const total = tests.tests.length;
  if (total === 0) return checks;
  const recorded = total - missing.length;
  checks.push(
    missing.length === 0
      ? {
          id: "recordings",
          title: "Recordings",
          status: "ok",
          message: `All ${total} tests are recorded.`,
        }
      : {
          id: "recordings",
          title: "Recordings",
          status: "warn",
          message: `${recorded} of ${total} tests recorded; the others run with the AI until they are.`,
          fix: `Record each one: \`${brand.cliName} author ${(missing[0] as { path: string }).path}\`${missing.length > 1 ? " (and the others below)" : ""}.`,
          details: missing.map(
            (test) => `${test.path}: not recorded. Fix: \`${brand.cliName} author ${test.path}\``,
          ),
        },
  );
  if (recorded === 0) return checks;
  if (loaded.diagnostics.some((d) => d.severity === "error")) {
    checks.push({
      id: "specs",
      title: "Playwright specs",
      status: "skip",
      message: "Not checked until the project file is fixed.",
    });
    return checks;
  }
  const { generateProject } = await import("@testament/codegen/node");
  const generated = await generateProject({ projectDir: dir, environment, env, check: true });
  if (!generated.ok) {
    checks.push({
      id: "specs",
      title: "Playwright specs",
      status: "fail",
      message: generated.problems[0] ?? "The specs can't be generated.",
      fix: `Run \`${brand.cliName} generate\` for details.`,
    });
    return checks;
  }
  const stale = generated.files.filter((f) => f.status === "stale");
  const edited = generated.files.filter((f) => f.status === "edited");
  const specCount = generated.files.filter((f) => f.test).length;
  if (stale.length > 0) {
    checks.push({
      id: "specs",
      title: "Playwright specs",
      status: "warn",
      message: `${stale.length} generated file${stale.length === 1 ? " is" : "s are"} out of date.`,
      fix: `Run \`${brand.cliName} generate\`.`,
      details: stale.map((f) => `${f.path}: out of date. Fix: \`${brand.cliName} generate\``),
    });
  }
  if (edited.length > 0) {
    checks.push({
      id: "specs:edited",
      title: "Playwright specs",
      status: "warn",
      message: `${edited.length} generated file${edited.length === 1 ? " was" : "s were"} changed by hand and won't be regenerated.`,
      fix: `Keep your edits, or run \`${brand.cliName} generate --force\` to replace ${edited.length === 1 ? "it" : "them"}.`,
      details: edited.map((f) => f.path),
    });
  }
  if (stale.length === 0 && edited.length === 0) {
    checks.push({
      id: "specs",
      title: "Playwright specs",
      status: "ok",
      message: `${specCount} spec${specCount === 1 ? "" : "s"} up to date.`,
    });
  }
  return checks;
}

function playwrightCheck(dir: string, config: Config): DoctorCheck | undefined {
  const testsDir = config.tests?.dir ?? DEFAULT_TESTS.dir;
  const overlap = playwrightOverlap(dir, testsDir);
  if (!overlap) return undefined;
  return overlap.ignored
    ? {
        id: "playwright",
        title: "Your Playwright setup",
        status: "ok",
        message: `${overlap.configFile} ignores the generated specs.`,
      }
    : {
        id: "playwright",
        title: "Your Playwright setup",
        status: "warn",
        message: `${overlap.configFile} would also pick up the specs generated in ${testsDir}/${brand.dataDirName}/.`,
        fix: overlap.fix,
      };
}

function summarize(
  checks: DoctorCheck[],
  strict: boolean,
): Pick<DoctorReport, "summary" | "exitCode"> {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) summary[check.status]++;
  const exitCode = summary.fail > 0 ? 2 : strict && summary.warn > 0 ? 1 : 0;
  return { summary, exitCode };
}

/**
 * Runs every check (the desktop app's Setup check calls this). Changes nothing
 * on disk. Never throws on project problems: each is a check with a fix.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const start = resolve(options.dir);
  const dir = findProject(start) ?? start;
  const checks: DoctorCheck[] = [nodeCheck()];
  const done = (project: string | null, environments: string[]): DoctorReport => ({
    schema: 1,
    project,
    environments,
    checks,
    ...summarize(checks, options.strict ?? false),
  });

  if (!existsSync(projectFile(dir))) {
    checks.push({
      id: "project",
      title: "Project file",
      status: "fail",
      message: `No ${brand.configFileName} in ${start} or any folder above it.`,
      fix: `Run \`${brand.cliName} init\` in your repository, or run this inside a project folder.`,
    });
    return done(null, []);
  }

  const loaded = loadProject(dir, { environment: options.environment, env });
  checks.push(projectCheck(loaded, dir));
  if (loaded.diagnostics.some((d) => d.code === "ENV_NOT_FOUND" || d.code === "YAML_SYNTAX")) {
    return done(dir, []);
  }
  const environments = options.environment
    ? [options.environment]
    : Object.keys(loaded.config.environments ?? {});
  const environment = loaded.environment?.name;
  const sources = [processEnvSource(env), dotenvSource(dir)];

  checks.push(await testsCheck(dir, environment, env));
  checks.push(...(await browserChecks(loaded, environments, options.probes ?? harnessProbes)));
  checks.push(secretsCheck(dir, environments, env, sources));
  checks.push(...(await modelsCheck(loaded.config, environment, env, sources)));
  checks.push(...(await decisionsCheck(loaded.config, environment, sources)));
  checks.push(await inboxCheck(loaded.config, environment, sources));
  checks.push(...(await recordingsChecks(dir, loaded, environment, env)));
  const overlap = playwrightCheck(dir, loaded.config);
  if (overlap) checks.push(overlap);
  return done(dir, environments);
}

// ── the command ───────────────────────────────────────────────────────────────

export interface DoctorCommandOptions {
  env?: string;
  dir?: string;
  json?: boolean;
  strict?: boolean;
}

const LABEL: Record<DoctorStatus, string> = { ok: "ok", warn: "warn", fail: "FAIL", skip: "skip" };

/** The report as text: one line per check, then its fix and details. */
export function formatDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.title.length));
  const lines = [
    report.project
      ? `${brand.productName} doctor  ${report.project}${report.environments.length ? `  (${report.environments.join(", ")})` : ""}`
      : `${brand.productName} doctor`,
    "",
  ];
  for (const check of report.checks) {
    lines.push(
      `  ${LABEL[check.status].padEnd(4)}  ${check.title.padEnd(width)}  ${check.message}`,
    );
    const indent = " ".repeat(10 + width);
    if (check.fix && check.status !== "ok" && check.status !== "skip")
      lines.push(`${indent}Fix: ${check.fix}`);
    for (const detail of check.details ?? []) lines.push(`${indent}- ${detail}`);
  }
  const { ok, warn, fail, skip } = report.summary;
  lines.push(
    "",
    `${ok} ok, ${warn} warning${warn === 1 ? "" : "s"}, ${fail} failed${skip ? `, ${skip} skipped` : ""}.`,
  );
  return lines.join("\n");
}

/** Exit 0 all ok (warnings allowed), 1 warnings with --strict, 2 any failure. */
export async function runDoctorCommand(
  options: DoctorCommandOptions,
  io: CommandIo,
  probes?: DoctorProbes,
): Promise<number> {
  const report = await runDoctor({
    dir: options.dir ? resolve(io.cwd, options.dir) : io.cwd,
    environment: options.env,
    env: io.env,
    strict: options.strict ?? false,
    ...(probes ? { probes } : {}),
  });
  const text = options.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report);
  io.stdout(`${defaultRedactor.redact(text)}\n`);
  return report.exitCode;
}

export function registerDoctorCommand(program: Command, io: () => CommandIo): void {
  program
    .command("doctor")
    .description(
      "check the project, tests, secrets, AI setup, browsers and recordings; every problem comes with its fix",
    )
    .option("-e, --env <name>", "check only this environment (default: all)")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--strict", "exit 1 when there are warnings")
    .option("--json", "print machine-readable JSON")
    .action(async (options: DoctorCommandOptions) => {
      process.exitCode = await runDoctorCommand(options, io());
    });
}
