import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { hasErrors } from "@optestra/config";
import {
  dotenvSource,
  findProject,
  loadProject,
  processEnvSource,
  projectFile,
  resolveSecrets,
} from "@optestra/config/node";
import { hasSpecErrors } from "@optestra/spec";
import { loadTest } from "@optestra/spec/node";
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
  /** Android projects: the Android version. */
  android?: string;
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
  const models = await import("@optestra/models");
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  if (hasErrors(loaded.diagnostics)) {
    for (const d of loaded.diagnostics.filter((d) => d.severity === "error")) {
      io.stdout(`error ${d.code}: ${d.message}\n  Fix: ${d.fix}\n`);
    }
    return 2;
  }
  const environment = loaded.environment;
  const settings = environment?.settings;
  if (!environment || !settings) {
    io.stdout("No environment is selected. Choose one with --env, or set defaultEnvironment.\n");
    return 2;
  }
  const config = loaded.config;
  const coreNode = await import("@optestra/core/node");
  // The target (MOB-1): a browser on the environment's baseUrl, or the app on an emulator.
  const resolved = await coreNode.resolveTarget(dir, config, environment, {
    ...(options.browser ? { browser: options.browser as "chromium" | "firefox" | "webkit" } : {}),
    ...(options.device ? { device: options.device } : {}),
    ...(options.android ? { androidVersion: options.android } : {}),
  });
  if (!resolved.ok) {
    io.stdout(`${resolved.message}\n`);
    return 2;
  }
  const target = resolved.target;
  const path = posix(relative(dir, absolute));
  const auth = await import("@optestra/auth");
  const usesInbox = config.inbox !== undefined && config.inbox.provider !== "none";
  const test = await loadTest(dir, path, config, {
    environment: environment.name,
    seed: `author-${Date.now().toString(36)}`,
    // {{unique.email}} lands in the test inbox (ENV-3).
    emailDomain: usesInbox ? auth.inboxEmailDomain(config.inbox) : undefined,
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
  const core = await import("@optestra/core");
  const { readRecording, recordingBranch, recordingFiles } = await import(
    "@optestra/recording/node"
  );

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

  // The test inbox (SEC-5): read_inbox and {{inbox.code}} / {{inbox.link}}.
  let inbox: import("@optestra/core").TestInbox | undefined;
  if (usesInbox) {
    const created = auth.createInbox(config, { sources, environment: environment.name });
    if (created.ok)
      inbox = core.createTestInbox({
        values: auth.createInboxValues({
          inbox: created.inbox,
          allowedDomains: settings.allowedDomains,
          timeoutMs: config.inbox.timeoutSeconds * 1000,
        }),
        provider: created.inbox.provider,
        allowedDomains: settings.allowedDomains,
        since: new Date(),
      });
    else
      io.stdout(`The test inbox can't be used: ${created.message}
`);
  }

  // Authoring records once, on one matrix entry: the first (browser/device, or Android version/device).
  const cell = target.cells[0];
  if (!cell) {
    io.stdout("Nothing to author on: the run has no matrix entry.\n");
    return 2;
  }
  const device = cell.device;
  // auth: <profile> (SEC-3): log in like a run does, before the start page.
  const profileName = test.expanded.auth;
  const profile =
    profileName && profileName !== "none" ? config.auth?.profiles?.[profileName] : undefined;
  if (profileName && profileName !== "none" && !profile) {
    io.stdout(`auth: ${profileName} is not a profile in the project settings.\n`);
    return 2;
  }
  if (profile && target.name === "android") {
    io.stdout(
      `auth: ${profileName} keeps a browser login: profiles can't be used on Android yet. Log in with steps instead.\n`,
    );
    return 2;
  }

  let worker: import("@optestra/core/node").TargetWorker;
  try {
    worker = await coreNode.launchWorker(target, cell, { headless: !options.headed });
  } catch (error) {
    io.stdout(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const evidenceDir = mkdtempSync(join(tmpdir(), `${brand.cliName}-author-`));
  const opened = await worker.openAttempt({
    allowedDomains: settings.allowedDomains,
    secrets: { ...secrets.secrets, ...inbox?.secrets },
    uploadDir: dirname(absolute),
    evidenceDir,
    video: options.video ?? false,
  });
  if (!opened.ok) {
    await worker.close();
    rmSync(evidenceDir, { recursive: true, force: true });
    io.stdout(`${opened.reason}: ${opened.message}\n`);
    return 2;
  }
  const session = opened.session;
  const web = opened.web;
  const openLogin = worker.openLoginSession;
  const { createDecisions } = await import("@optestra/decide");
  const { ulid } = await import("@optestra/contract");
  const prepare =
    profileName && profile && web && openLogin
      ? coreNode.authoringLogin({
          projectDir: dir,
          config,
          environment: environment.name,
          name: profileName,
          profile,
          session: web,
          emailDomain: usesInbox ? auth.inboxEmailDomain(config.inbox) : undefined,
          openSession: (extra) =>
            openLogin({
              allowedDomains: settings.allowedDomains,
              secrets: { ...secrets.secrets, ...extra },
            }),
          replay: {
            mode: "normal",
            policy: config.run.healPolicy as "strict" | "review" | "auto",
            decisions: createDecisions(),
            models: client,
            budget,
            fixerAvailable: false,
            plannerAvailable: true,
            production: settings.production,
            newId: ulid,
          },
          meta: { engineVersion: core.version(), browser: session.browserName, device },
          onLog: (message) => io.stdout(`  ${message}\n`),
        })
      : undefined;

  const testsDir = resolve(dir, config.tests?.dir ?? "tests");
  // REP-8: on a feature branch the recording is the branch's own (main's until it has one).
  const branch = recordingBranch(config.recordings ?? { branches: "auto" }, io.env, dir);
  const files = recordingFiles(testsDir, test.id, branch);
  const previous = readRecording(files.read);
  const where =
    target.name === "web"
      ? target.baseUrl
      : `Android ${cell.target === "android" ? cell.androidVersion : ""} (${device})`;
  io.stdout(`Authoring ${path} on ${where} (${environment.name})\n`);
  let result: Awaited<ReturnType<typeof core.authorTest>>;
  let closed: Awaited<ReturnType<typeof session.close>> | undefined;
  try {
    const { defaultRedactor } = await import("@optestra/config/node");
    result = await core.authorTest(test.expanded, {
      session,
      hookContext: {
        projectDir: dir,
        settings: config.hooks ?? core.DEFAULT_HOOKS,
        production: settings.production ?? false,
        secrets: secrets.secrets,
        redact: (text) => defaultRedactor.redact(text),
        env: io.env,
      },
      models: client,
      budget,
      production: settings.production,
      ...(inbox ? { inbox } : {}),
      ...(prepare ? { prepare } : {}),
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
    // Closing always happens: evidence is written and the browser or emulator shut down.
    try {
      closed = await session.close();
    } finally {
      await worker.close();
    }
  }
  const saved = coreNode.saveAuthoring({
    projectDir: dir,
    testsDir,
    result,
    evidence: closed.evidence,
    recordingFile: files.write,
  });
  rmSync(evidenceDir, { recursive: true, force: true });
  const report = saved.report;
  // Keep the portable copy in sync with the recording (never over a hand edit): a
  // Playwright spec, or for Android a Maestro flow (MOB-6).
  const specNotes: string[] = [];
  try {
    const { generateAfterRecording } = await import("@optestra/codegen/node");
    const generated = await generateAfterRecording(dir, path, {
      environment: environment.name,
      env: io.env,
    });
    for (const f of generated.files) {
      if (f.status === "edited")
        specNotes.push(`${f.path} was changed by hand: not regenerated (use generate --force).`);
      else if (f.status !== "unchanged" && f.test)
        specNotes.push(`${target.name === "android" ? "Flow:      " : "Spec:      "}${f.path}`);
    }
  } catch (error) {
    specNotes.push(
      `The spec could not be regenerated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
      `Report:    ${posix(relative(io.cwd, saved.reportPath))}\n` +
      specNotes.map((note) => `${note}\n`).join(""),
  );
  return report.outcome === "recorded" ? 0 : report.outcome === "failed" ? 1 : 2;
}
