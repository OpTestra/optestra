import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { brand } from "@testament/brand";
import { hasErrors } from "@testament/config";
import {
  dotenvSource,
  findProject,
  loadProject,
  processEnvSource,
  projectFile,
  resolveSecrets,
} from "@testament/config/node";
import { hasSpecErrors } from "@testament/spec";
import { loadTest } from "@testament/spec/node";
import type { CommandIo } from "./config.js";
import { formatSpecDiagnostic } from "./tests.js";

// `author <test>`: the first AI run (LOOP-1). Opens a harness session, runs the
// test's setup hooks, lets the agent carry out every action step, and writes the
// recording (next to the tests) and the authoring report. The harness, models
// and engine are imported only when this runs.

export interface AuthorCommandOptions {
  env?: string;
  headed?: boolean;
  device?: string;
  browser?: string;
  video?: boolean;
  dir?: string;
}

const posix = (path: string) => path.split(sep).join("/");
const money = (usd: number | null) => (usd === null ? "$?" : `${usd.toFixed(4)}`);
/** Subscription calls cost the run nothing; say so instead of "$0.0000". */
const costText = (calls: readonly { billing?: string | undefined }[], usd: number | null) =>
  calls.length > 0 && calls.every((c) => c.billing === "subscription")
    ? "via your subscription"
    : money(usd);

/** Exit 0: every action step recorded. 1: a step failed. 2: stopped, or a config/test problem. */
export async function runAuthorCommand(
  file: string,
  options: AuthorCommandOptions,
  io: CommandIo,
): Promise<number> {
  const absolute = resolve(io.cwd, file);
  if (!existsSync(absolute)) {
    io.stdout(`No such test file: ${file}\n`);
    return 2;
  }
  const dir = options.dir
    ? resolve(io.cwd, options.dir)
    : (findProject(dirname(absolute)) ?? io.cwd);
  if (!existsSync(projectFile(dir))) {
    io.stdout(`No project file found for ${file}. Create one (the app's "New project") first.\n`);
    return 2;
  }
  // Registers the models section before the config is loaded.
  const models = await import("@testament/models");
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  if (hasErrors(loaded.diagnostics)) {
    for (const d of loaded.diagnostics.filter((d) => d.severity === "error")) {
      io.stdout(`error ${d.code}: ${d.message}\n  Fix: ${d.fix}\n`);
    }
    return 2;
  }
  const environment = loaded.environment;
  const settings = environment?.settings;
  if (!environment || !settings?.baseUrl) {
    io.stdout(
      `The environment${environment ? ` "${environment.name}"` : ""} has no baseUrl. Choose one with --env, or set baseUrl.\n`,
    );
    return 2;
  }
  const config = loaded.config;
  const path = posix(relative(dir, absolute));
  const test = await loadTest(dir, path, config, {
    environment: environment.name,
    seed: `author-${Date.now().toString(36)}`,
  });
  if (!test) {
    io.stdout(`Could not read ${path}.\n`);
    return 2;
  }
  if (hasSpecErrors(test.diagnostics)) {
    io.stdout(`${path} has problems:\n${test.diagnostics.map(formatSpecDiagnostic).join("\n")}\n`);
    return 2;
  }
  if (test.expanded.kind === "flow") {
    io.stdout(`${path} is a flow. Author the tests that use it.\n`);
    return 2;
  }

  const sources = [processEnvSource(io.env), dotenvSource(dir)];
  const secrets = resolveSecrets(config, sources, { environment: environment.name });
  const browser = await import("@testament/browser");
  const core = await import("@testament/core");
  const coreNode = await import("@testament/core/node");
  const { readRecording, recordingPath } = await import("@testament/recording/node");

  const budget = models.BudgetMeter.forRun(config);
  const client = models.createModels({
    config,
    sources,
    environment: environment.name,
    budgets: [budget],
    usageStore: models.projectUsageStore(dir),
  });
  if (!client.pool("planner").some((entry) => entry.usable)) {
    io.stdout(
      "No AI model is available for authoring (no planner provider has a key).\nFix: set a provider key, e.g. ANTHROPIC_API_KEY, or configure models.roles.planner.\n",
    );
    return 2;
  }

  const device = options.device ?? browser.DEFAULT_DEVICE;
  let session: Awaited<ReturnType<typeof browser.openSession>>;
  try {
    session = await browser.openSession({
      browser: (options.browser as "chromium" | "firefox" | "webkit" | undefined) ?? "chromium",
      headless: !options.headed,
      device,
      baseUrl: settings.baseUrl,
      allowedDomains: settings.allowedDomains,
      secrets: secrets.secrets,
      allowUpload: { dir: dirname(absolute) },
      evidence: { trace: true, console: true, network: true, video: options.video ?? false },
    });
  } catch (error) {
    const fix = error instanceof browser.BrowserSetupError ? `\nFix: ${error.fix}` : "";
    io.stdout(`${error instanceof Error ? error.message : String(error)}${fix}\n`);
    return 2;
  }

  const testsDir = resolve(dir, config.tests?.dir ?? "tests");
  const previous = readRecording(recordingPath(testsDir, test.id));
  io.stdout(`Authoring ${path} on ${settings.baseUrl} (${environment.name})\n`);
  let result: Awaited<ReturnType<typeof core.authorTest>>;
  let closed: Awaited<ReturnType<typeof session.close>> | undefined;
  try {
    result = await core.authorTest(test.expanded, {
      session,
      models: client,
      budget,
      production: settings.production,
      timeoutMs: (test.expanded.timeout ?? config.run.timeoutSeconds) * 1000,
      ...(previous?.ok ? { previous: previous.recording } : {}),
      meta: {
        testPath: path,
        target: config.project.target,
        engineVersion: core.version(),
        device,
        environment: environment.name,
      },
      onEvent: (event) => {
        if (event.type === "hook") {
          io.stdout(
            `  setup  ${event.hook.description}  ${event.hook.status}${event.hook.message ? ` (${event.hook.message})` : ""}\n`,
          );
        }
        if (event.type === "step.finished") {
          const step = event.step;
          const label = `${step.number ?? ""}. ${step.text}`.slice(0, 60).padEnd(60);
          const detail = `${step.actions.length} action${step.actions.length === 1 ? "" : "s"} · ${step.modelCalls.length} AI call${step.modelCalls.length === 1 ? "" : "s"} · ${costText(step.modelCalls, step.costUsd)}`;
          if (step.check) {
            // A compiled check (LOOP-2): how it was made, how it did, and what it checks.
            const check = step.check;
            const how =
              check.generatedBy === "rules" && check.rule
                ? `rules/${check.rule}`
                : check.generatedBy;
            const result =
              check.status === "not_compiled"
                ? "not compiled"
                : check.passed === null
                  ? check.status
                  : check.passed
                    ? "passed"
                    : "FAILED";
            const ai = step.modelCalls.length
              ? ` · ${step.modelCalls.length} AI call${step.modelCalls.length === 1 ? "" : "s"}`
              : "";
            io.stdout(
              `  ${label}  check     ${how} · ${result}${check.sanity?.provesNothing ? " · proves nothing" : ""}${ai}\n`,
            );
            io.stdout(`      ${check.summary}\n`);
            if (check.passed === false)
              io.stdout(
                `      expected ${JSON.stringify(check.expected)}, saw ${JSON.stringify(check.actual)}\n`,
              );
            if (check.problem) io.stdout(`      ${check.problem}\n`);
            return;
          }
          io.stdout(`  ${label}  ${step.status.padEnd(8)}  ${detail}\n`);
          if (step.status !== "recorded" && step.message)
            io.stdout(`      ${step.reason}: ${step.message}\n`);
        }
      },
    });
  } finally {
    // Closing always happens: evidence is written and the browser shut down.
    closed = await session.close();
  }
  const saved = coreNode.saveAuthoring({
    projectDir: dir,
    testsDir,
    result,
    evidence: closed.evidence,
  });
  const report = saved.report;
  for (const step of report.steps.filter((s) => s.status === "skipped")) {
    io.stdout(`  ${`${step.number ?? ""}. ${step.text}`.slice(0, 60).padEnd(60)}  skipped\n`);
  }
  const t = report.totals;
  const c = report.checks;
  io.stdout(
    `\nChecks: ${c.total - c.notCompiled} of ${c.total} compiled (${c.rules} by rules, ${c.ai} by AI, ${c.exact} exact)` +
      `${c.failedAtAuthoring ? `, ${c.failedAtAuthoring} failed while authoring (a bug in the app, or the test is wrong)` : ""}` +
      `${c.provesNothing ? `, ${c.provesNothing} prove nothing` : ""}. Details: ${brand.cliName} checks ${file}\n`,
  );
  io.stdout(
    `\n${report.outcome === "recorded" ? "Recorded every action step." : `Stopped: ${report.stopReason}${report.message ? ` (${report.message})` : ""}`}\n` +
      `AI: ${t.aiCalls} calls, ${t.tokens.input} input + ${t.tokens.output} output tokens, ${t.billing === "subscription" ? "via your subscription (no API cost)" : money(t.costUsd)}${t.billing === "mixed" ? " (partly via your subscription)" : ""}${t.unknownCostCalls ? ` (+${t.unknownCostCalls} calls of unknown cost)` : ""}\n` +
      `Recording: ${posix(relative(io.cwd, saved.recordingPath))}\n` +
      `Report:    ${posix(relative(io.cwd, saved.reportPath))}\n`,
  );
  return report.outcome === "recorded" ? 0 : report.outcome === "failed" ? 1 : 2;
}
