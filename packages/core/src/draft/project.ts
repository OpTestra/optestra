import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { inboxEmailDomain } from "@optestra/auth";
import { type LaunchedBrowser, launchBrowser, openSession } from "@optestra/browser";
import { type Config, hasErrors } from "@optestra/config";
import {
  dotenvSource,
  loadProject,
  processEnvSource,
  projectFile,
  resolveSecrets,
  type SecretSource,
} from "@optestra/config/node";
import { BudgetMeter, createModels, type Models, projectUsageStore } from "@optestra/models";
import { loadTests, nodeFileReader } from "@optestra/spec/node";
import { type DraftEvent, type DraftLimits, type DraftResult, exploreDraft } from "./draft.js";
import { slugOf } from "./phrasing.js";
import { exploreStarters, type StarterSuggestions } from "./starters.js";

// Drafting against a project folder (AUT-7, ONB-2): the project's settings,
// environment, secrets (by name and description, never values), models and a
// fresh browser with no trace, video or HAR. Returns drafts; writes nothing.

/** Drafting can't start: the message says what's wrong, `fix` what to do. */
export class DraftSetupError extends Error {
  override name = "DraftSetupError";
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

export interface ProjectDraftOptions {
  /** The project folder. */
  project: string;
  environment?: string | undefined;
  /** Where the test starts (default "/"). */
  start?: string | undefined;
  /** Another base URL than the environment's (it is allowed for this draft). */
  baseUrl?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  headless?: boolean | undefined;
  browser?: "chromium" | "firefox" | "webkit" | undefined;
  /** Injected AI client (tests). `null`: no AI (starters: the home page only). */
  models?: Models | null | undefined;
  secretSources?: readonly SecretSource[] | undefined;
  limits?: Partial<DraftLimits> | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: DraftEvent) => void) | undefined;
}

export interface ProjectDraft extends DraftResult {
  /** Absolute path where it would be saved (a free name in the tests folder). */
  absolutePath: string;
  environment: string;
}

export interface Prepared {
  dir: string;
  config: Config;
  environment: string;
  baseUrl: string;
  allowedDomains: string[];
  secrets: ReturnType<typeof resolveSecrets>["secrets"];
  described: Record<string, string | undefined>;
  hints: string[];
  models: Models | undefined;
  budget: BudgetMeter;
  testsDir: string;
  emailDomain: string | undefined;
}

/** Values the project's flows use by default (logins), as hints for the drafter. */
async function projectHints(dir: string, config: Config, environment: string): Promise<string[]> {
  const loaded = await loadTests(dir, config, { environment });
  const hints: string[] = [];
  for (const flow of loaded.flows) {
    const params = Object.entries(flow.spec.frontmatter.params)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key} = ${value?.raw}`);
    if (params.length)
      hints.push(
        `the flow ${flow.path} ("${flow.spec.frontmatter.name}") uses ${params.join(", ")}`,
      );
  }
  return hints.slice(0, 12);
}

export async function prepare(
  options: ProjectDraftOptions,
  needModels: boolean,
): Promise<Prepared> {
  const dir = resolve(options.project);
  if (!existsSync(projectFile(dir)))
    throw new DraftSetupError(`No project file in ${dir}.`, "Create one first (init).");
  const env = options.env ?? process.env;
  const loaded = loadProject(dir, { environment: options.environment, env });
  if (hasErrors(loaded.diagnostics)) {
    const errors = loaded.diagnostics.filter((d) => d.severity === "error");
    throw new DraftSetupError(
      errors.map((d) => `${d.code}: ${d.message}`).join(" "),
      errors.map((d) => d.fix).join(" "),
    );
  }
  const config = loaded.config;
  const environment = loaded.environment;
  const baseUrl = options.baseUrl ?? environment?.settings.baseUrl;
  if (!environment || !baseUrl)
    throw new DraftSetupError(
      `The environment${environment ? ` "${environment.name}"` : ""} has no baseUrl.`,
      "Choose one with --env, or set baseUrl.",
    );
  const allowedDomains = [...environment.settings.allowedDomains];
  if (options.baseUrl) {
    const host = new URL(options.baseUrl).hostname;
    if (!allowedDomains.includes(host)) allowedDomains.push(host);
  }
  const sources = options.secretSources ?? [processEnvSource(env), dotenvSource(dir)];
  const resolved = resolveSecrets(config, sources, { environment: environment.name });
  const declared = (config.secrets ?? {}) as Record<string, { description?: string }>;
  const described = Object.fromEntries(
    Object.keys(resolved.secrets).map((name) => [name, declared[name]?.description]),
  );
  const budget = BudgetMeter.forRun(config);
  let models: Models | undefined;
  if (options.models !== undefined) models = options.models ?? undefined;
  else {
    models = createModels({
      config,
      sources,
      environment: environment.name,
      budgets: [budget],
      usageStore: projectUsageStore(dir),
      env,
    });
    if (!models.pool("drafter").some((entry) => entry.usable)) models = undefined;
  }
  if (needModels && !models)
    throw new DraftSetupError(
      "No AI model is available for drafting (no planner provider has a key).",
      "Set a provider key, e.g. ANTHROPIC_API_KEY, sign in to Claude Code, or configure models.roles.planner.",
    );
  const usesInbox = config.inbox !== undefined && config.inbox.provider !== "none";
  return {
    dir,
    config,
    environment: environment.name,
    baseUrl,
    allowedDomains,
    secrets: resolved.secrets,
    described,
    hints: await projectHints(dir, config, environment.name),
    models,
    budget,
    testsDir: config.tests?.dir ?? "tests",
    emailDomain: usesInbox ? inboxEmailDomain(config.inbox) : undefined,
  };
}

export function freePath(dir: string, testsDir: string, name: string): string {
  const slug = slugOf(name);
  for (let n = 1; ; n++) {
    const path = `${testsDir}/${slug}${n === 1 ? "" : `-${n}`}.test.md`;
    if (!existsSync(join(dir, path))) return path;
  }
}

export async function withBrowser<T>(
  options: ProjectDraftOptions,
  run: (browser: LaunchedBrowser) => Promise<T>,
): Promise<T> {
  const browser = await launchBrowser({
    browser: options.browser ?? "chromium",
    headless: options.headless ?? true,
  });
  try {
    return await run(browser);
  } finally {
    await browser.close();
  }
}

export function sessionFor(prepared: Prepared, browser: LaunchedBrowser) {
  return openSession({
    browser,
    baseUrl: prepared.baseUrl,
    allowedDomains: prepared.allowedDomains,
    secrets: prepared.secrets,
    evidence: { trace: false, console: false, network: false, video: false },
  });
}

/**
 * Drafts a test for `sentence` by exploring the project's app (AUT-7). Nothing
 * is written: the result says where it would go (`path`, a free name).
 */
export async function draftTest(
  sentence: string,
  options: ProjectDraftOptions,
): Promise<ProjectDraft> {
  const prepared = await prepare(options, true);
  const models = prepared.models as Models;
  return withBrowser(options, async (browser) => {
    const session = await sessionFor(prepared, browser);
    try {
      const result = await exploreDraft(sentence, {
        session,
        models,
        budget: prepared.budget,
        start: options.start,
        testsDir: prepared.testsDir,
        pathFor: (name) => freePath(prepared.dir, prepared.testsDir, name),
        secrets: prepared.described,
        hints: prepared.hints,
        config: prepared.config,
        readFile: nodeFileReader(prepared.dir),
        emailDomain: prepared.emailDomain,
        limits: options.limits,
        signal: options.signal,
        onEvent: options.onEvent,
      });
      return {
        ...result,
        absolutePath: join(prepared.dir, result.path),
        environment: prepared.environment,
      };
    } finally {
      await session.close();
    }
  });
}

/**
 * Explores the app at `url` (default: the environment's baseUrl) and proposes
 * three starter tests as drafts (ONB-2). Nothing is written.
 */
export async function suggestStarterTests(
  url: string | undefined,
  options: ProjectDraftOptions & { count?: number },
): Promise<StarterSuggestions & { environment: string }> {
  const prepared = await prepare({ ...options, baseUrl: url ?? options.baseUrl }, false);
  return withBrowser(options, async (browser) => {
    const suggestions = await exploreStarters({
      openSession: () => sessionFor(prepared, browser),
      models: prepared.models,
      budget: prepared.budget,
      start: options.start,
      count: options.count,
      testsDir: prepared.testsDir,
      taken: (path) => existsSync(join(prepared.dir, path)),
      secrets: prepared.described,
      hints: prepared.hints,
      config: prepared.config,
      readFile: nodeFileReader(prepared.dir),
      emailDomain: prepared.emailDomain,
      limits: options.limits,
      signal: options.signal,
      onEvent: options.onEvent,
    });
    return { ...suggestions, environment: prepared.environment };
  });
}
