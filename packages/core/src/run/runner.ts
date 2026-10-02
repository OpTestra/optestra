import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  checkTestAuth,
  createInbox,
  createInboxValues,
  type Inbox,
  type InboxValues,
  inboxEmailDomain,
  SessionStore,
  testAuth,
} from "@optestra/auth";
// The android config section (version, device), so Android projects load here too.
import "@optestra/android/section";
import { brand } from "@optestra/brand";
import {
  type Config,
  hasErrors,
  protectedHeaderSpecs,
  protectionSecretNames,
} from "@optestra/config";
import {
  createLogger,
  defaultRedactor,
  dotenvSource,
  loadProject,
  processEnvSource,
  resolveSecrets,
  type SecretSource,
} from "@optestra/config/node";
import {
  type ArtifactRef,
  type Attempt,
  type BlockedReason,
  CONTRACT_VERSION,
  type DecisionRecord,
  type Event,
  type AccessibilityReport,
  type EvidenceRef,
  type FailureCause,
  type HealPolicy,
  type MatrixEntry,
  type MockUse,
  type ModelCall,
  needsRerecord,
  portablePath,
  portableSegment,
  REPEATED_HEALS,
  type Run,
  type RunMode,
  runLayout,
  type TestResult,
  type Trigger,
  ulid,
} from "@optestra/contract";
import { createRunWriter, type EmitInput, type RunWriter, runDir } from "@optestra/contract/node";
import {
  type AttemptObservations,
  classifyFailure,
  type Decisions,
  type FailureGroup,
  groupFailures,
} from "@optestra/decide";
import { createProjectDecisions } from "@optestra/decide/node";
import {
  AiWaits,
  BudgetMeter,
  createModels,
  type Models,
  projectUsageStore,
  withAiWaits,
} from "@optestra/models";
import {
  type CheckRecording,
  RECORDING_EPOCH,
  RECORDING_VERSION,
  type Recording,
  type StepRecording,
} from "@optestra/recording";
import {
  detectBranch,
  readRecording,
  recordingBranch,
  recordingFiles,
  writeRecording,
} from "@optestra/recording/node";
import { type ExpandedTest, hasSpecErrors } from "@optestra/spec";
import { datasetColumnProblems, loadDataset, loadTest, loadTests } from "@optestra/spec/node";
import { promptVersionFor } from "../author/agent.js";
import { createTestInbox, type TestInbox } from "../author/inbox.js";
import { applyPatches, type HealPatch } from "../heal/patch.js";
import { markAutoApplied } from "../heal/policy.js";
import { DEFAULT_HOOKS, type HookContext } from "../hooks/exec.js";
import { muteState, muteSuggestion } from "../quarantine/quarantine.js";
import { chaptersVtt, consoleErrors } from "./evidence.js";
import { recentAiUsage, recentHeals, recentVerdicts } from "./history.js";
import { profileFlowPath, profileLogin, replayProfileFlow } from "./profiles.js";
import { replayAttempt } from "./replay.js";
import { type Shard, selectShard } from "./shard.js";
import { runSpecTest } from "./spec-run.js";
import { parseViewport } from "./viewport.js";
import {
  cellLabel,
  engineKey,
  launchWorker,
  matrixOf,
  resolveTarget,
  type TargetCell,
  TargetLaunchError,
  type TargetWorker,
} from "./target.js";
import type { ReplayResult, ReplaySession, StepShotType } from "./types.js";
import { type AttemptRecord, decideVerdict, fallbackCause } from "./verdict.js";

// runTests (LOOP-4): the whole run. One browser per worker, one fresh session
// per test attempt (setup hooks first, then the start page), replay with no
// AI, fresh checks, honest verdicts, and a contract run folder written through
// the RunWriter (live events, scrubbed artifacts, final documents).

export interface RunTestsOptions {
  projectDir: string;
  /** Test files or folders (absolute, or relative to `cwd`). Default: every test. */
  tests?: readonly string[];
  cwd?: string;
  /** Only tests with one of these tags. */
  tags?: readonly string[];
  /** Only tests whose name contains this (case-insensitive). */
  grep?: string;
  /** Only this machine's slice of the selection (CLI-3): see `selectShard`. */
  shard?: Shard;
  environment?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Default: the project's run.mode. */
  mode?: RunMode;
  /** Extra attempts after a failure. Default: the project's run.retries. */
  retries?: number;
  /** Parallel browsers. Default 1. */
  workers?: number;
  /** Overrides run.budget.maxPerRunUsd. */
  budgetUsd?: number;
  headless?: boolean;
  browser?: BrowserName;
  /** A web device preset, or on Android a device profile. Default: the project's. */
  device?: string;
  /** Android: the version to run on. Default: the project's android.version. */
  androidVersion?: string;
  /**
   * A matrix (TGT-5): every test runs once per browser × device (web) or Android
   * version × device (Android), with one TestResult per entry (its testId gets
   * `@<browser>-<device>` / `@android<version>-<device>`). Overrides the single
   * values.
   */
  browsers?: readonly BrowserName[];
  devices?: readonly string[];
  androidVersions?: readonly string[];
  /** Android: a running emulator to share (tests, Bench); left running. Implies one worker. */
  emulator?: import("@optestra/android").LaunchedEmulator;
  /** Browser locale and timezone for every session (ENV-5), e.g. "de-DE", "Europe/Berlin". */
  locale?: string;
  timezone?: string;
  /**
   * Websites (TGT-3): a custom browser size for every session, instead of the
   * device preset's (its user agent, scale and touch stay). See `parseViewport`.
   */
  viewport?: { width: number; height: number };
  /**
   * ENV-4: recorded network traffic. `record`: keep each test's fetch/XHR answers
   * (scrubbed) in `<tests>/<data dir>/<test id>.network.har`. Default: answer from
   * that file when it exists (`replay`); `live`: never.
   */
  network?: "record" | "replay" | "live";
  /** EVD-6: `warn` scans every page visited with axe-core (default: the project's `accessibility`). */
  accessibility?: "off" | "warn";
  /** Record a video per attempt (default true, EVD-1). */
  video?: boolean;
  /**
   * Evidence per attempt (EVD-1). Default: `run.evidence`, else `full` in CI
   * (the CI variable is set) and `failures` elsewhere. See EvidenceMode.
   */
  evidence?: EvidenceMode;
  /**
   * Stops the run cleanly: no new test starts, the running one stops before its
   * next step (its attempt is blocked `aborted`, its evidence written), and the
   * run is recorded as blocked `aborted`.
   */
  signal?: AbortSignal;
  /**
   * The Node for JS subscription CLIs and code-step specs. Default: detected
   * (`nodeRuntime`: this process when it is Node, else `node` on PATH, else the
   * app's own binary in Node mode).
   */
  node?: string;
  trigger?: Trigger;
  /** Every event as it is written, `artifact.written` included. */
  onEvent?: (event: Event) => void;
  /**
   * Called before each attempt's hooks, with the fresh session (e.g. a Bench
   * harness resetting the fixture). Not a test step.
   */
  beforeAttempt?: (context: {
    testId: string;
    attempt: number;
    session: ReplaySession;
  }) => Promise<void>;
  /** Secret sources (default: process env, then the project's .env files). */
  secretSources?: readonly SecretSource[];
  /** Injected AI client (tests). `null`: no AI at all. Default: from the project. */
  models?: Models | null;
  /** Injected decisions (tests). Default: the project's decision layer. */
  decisions?: Decisions;
  /** Regenerate the portable spec after authoring (default true). */
  generateSpecs?: boolean;
  /** How long a check waits for its condition (default 5000 ms). */
  checkTimeoutMs?: number;
  /**
   * Injected test inbox (tests, Bench). `null`: none. Default: the project's
   * `inbox` settings (Mailpit, Mailosaur, MailSlurp).
   */
  inbox?: Inbox | null;
}

export interface RunTestsResult {
  dir: string;
  run: Run;
  tests: TestResult[];
  /** DIA-4: failed, flaky and blocked tests grouped by cause. */
  groups: FailureGroup[];
  /** Tests that recorded or compiled something, with the files written. */
  recorded: { test: string; recording: string; specs: string[]; warnings: string[] }[];
  /** Heals without AI, by the fixer, and misses left needing AI, per test (for Bench). */
  heals: Record<string, { withoutAi: number; byFixer: number; needsAi: number }>;
}

/**
 * Evidence per attempt (EVD-1). Every mode keeps the console log, the video
 * with chapters (unless `video: false`) and a PNG of the step that failed.
 * - full: plus the trace, the network log and a screenshot per step (JPEG,
 *   taken in the background), for every attempt.
 * - failures: the trace and network log are recorded for every attempt, and
 *   kept for failed, blocked, healed and retried attempts; a clean first-try
 *   pass drops them unread. No per-step screenshots (the trace has them).
 * - minimal: no trace or network log, except on a retry.
 */
export type EvidenceMode = "full" | "failures" | "minimal";

type BrowserName = "chromium" | "firefox" | "webkit";

interface TestPlan {
  path: string;
  /** The result id: the test id, plus `#<row>` for a dataset row (AUT-9). */
  id: string;
  /** The test's own id: its recording (every row shares it). */
  testId: string;
  name: string;
  tags: string[];
  problem?: string;
  /** AUT-9: this plan is one row of the test's dataset. */
  row?: { row: number; values: Record<string, string> };
}

const posix = (path: string) => path.split(sep).join("/");

function selectTests(
  projectDir: string,
  all: { path: string; name: string; tags: string[] }[],
  options: RunTestsOptions,
) {
  const cwd = options.cwd ?? projectDir;
  const picks = (options.tests ?? []).map((entry) => {
    const absolute = isAbsolute(entry) ? entry : resolve(cwd, entry);
    const rel = posix(relative(projectDir, absolute));
    const isDir = existsSync(absolute) && statSync(absolute).isDirectory();
    return { rel, isDir };
  });
  const grep = options.grep?.toLowerCase();
  return all.filter((test) => {
    if (
      picks.length > 0 &&
      !picks.some(({ rel, isDir }) =>
        isDir ? rel === "" || test.path.startsWith(`${rel}/`) : test.path === rel,
      )
    )
      return false;
    if (options.tags?.length && !options.tags.some((tag) => test.tags.includes(tag))) return false;
    if (grep && !test.name.toLowerCase().includes(grep)) return false;
    return true;
  });
}

/** The recording after this run: authored steps and checks replace old ones, nothing else changes. */
export function mergeRecording(
  test: ExpandedTest,
  previous: Recording | undefined,
  authored: { steps: StepRecording[]; checks: CheckRecording[]; model: string | null },
  meta: {
    testPath: string;
    target: "web" | "android";
    engineVersion: string;
    browser: string;
    device: string;
    environment: string | null;
    now: string;
  },
): Recording {
  const freshSteps = new Map(authored.steps.map((s) => [s.textKey, s]));
  const freshChecks = new Map(authored.checks.map((c) => [c.textKey, c]));
  const oldSteps = new Map((previous?.steps ?? []).map((s) => [s.textKey, s]));
  const oldChecks = new Map((previous?.checks ?? []).map((c) => [c.textKey, c]));
  const steps: StepRecording[] = [];
  const checks: CheckRecording[] = [];
  for (const step of test.steps) {
    if (step.kind === "action" || step.kind === "exact") {
      const entry = freshSteps.get(step.textKey) ?? oldSteps.get(step.textKey);
      if (entry && !steps.includes(entry)) steps.push(entry);
    }
    if (step.kind === "expect" || step.kind === "soft") {
      const entry = freshChecks.get(step.textKey) ?? oldChecks.get(step.textKey);
      if (entry && !checks.includes(entry)) checks.push(entry);
    }
  }
  // Exact expect ops keep their stored checks as they were (they are the test itself).
  for (const old of previous?.checks ?? [])
    if (old.generatedBy === "exact" && !checks.includes(old)) checks.push(old);
  return {
    recordingVersion: RECORDING_VERSION,
    testId: test.id,
    testPath: meta.testPath,
    target: meta.target,
    recordedWith: {
      engineVersion: meta.engineVersion,
      epoch: RECORDING_EPOCH,
      browser: meta.browser,
      device: meta.device,
      environment: meta.environment,
      model: authored.model ?? previous?.recordedWith.model ?? null,
      promptVersion: authored.model
        ? promptVersionFor(meta.target)
        : (previous?.recordedWith.promptVersion ?? null),
    },
    updatedAt: meta.now,
    steps,
    checks,
  };
}

/** Runs the project's tests and writes a contract run folder. */
export async function runTests(options: RunTestsOptions): Promise<RunTestsResult> {
  const projectDir = resolve(options.projectDir);
  const env = options.env ?? process.env;
  const { version } = await import("../index.js");
  const engineVersion = version();
  const loaded = loadProject(projectDir, { environment: options.environment, env });
  const dataDir = join(projectDir, brand.dataDirName);
  const runId = ulid();
  const dir = runDir(dataDir, runId);
  const redactor = defaultRedactor;
  const writer: RunWriter = createRunWriter(dir, {
    scrub: (text) => redactor.redact(text),
    runId,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  const emit = (event: EmitInput) => writer.emit(event);
  const config: Config = loaded.config;
  const environment = loaded.environment;
  const mode: RunMode = options.mode ?? (config.run.mode as RunMode) ?? "normal";
  emit({
    type: "run.started",
    engineVersion,
    project: config.project?.name ?? "project",
    environment: environment?.name ?? null,
    target: config.project?.target ?? "web",
    trigger: options.trigger ?? "cli",
    mode,
    // The branch, when there is one (REP-8): git's HEAD or the GitHub Action's variables.
    ...gitInfo(env, projectDir),
  });
  const empty: Omit<RunTestsResult, "run" | "tests"> = { dir, groups: [], recorded: [], heals: {} };
  const finishBlocked = (reason: BlockedReason, message: string): RunTestsResult => {
    emit({ type: "run.finished", blocked: { reason, message } });
    const folded = writer.finish();
    return { ...empty, run: folded.run, tests: folded.tests };
  };
  if (hasErrors(loaded.diagnostics)) {
    const errors = loaded.diagnostics.filter((d) => d.severity === "error");
    return finishBlocked(
      "config_error",
      errors.map((d) => `${d.code}: ${d.message} Fix: ${d.fix}`).join(" "),
    );
  }
  const settings = environment?.settings;
  if (!environment || !settings)
    return finishBlocked(
      "config_error",
      "No environment is selected. Choose one with --env, or set defaultEnvironment.",
    );
  const resolvedTarget = await resolveTarget(projectDir, config, environment, options);
  if (!resolvedTarget.ok) return finishBlocked("config_error", resolvedTarget.message);
  const target = resolvedTarget.target;
  if (options.viewport) {
    const checked = parseViewport(options.viewport);
    if (!checked.ok) return finishBlocked("config_error", checked.message);
    if (target.name !== "web")
      return finishBlocked(
        "config_error",
        "A custom viewport is for websites; an Android run uses its device profile's screen.",
      );
  }

  const sources = options.secretSources ?? [processEnvSource(env), dotenvSource(projectDir)];
  // The test inbox (SEC-5): {{unique.email}} lands in it (ENV-3), codes and links are read from it.
  let inbox: Inbox | undefined;
  let inboxProblem: string | undefined;
  if (options.inbox !== undefined) inbox = options.inbox ?? undefined;
  else if (config.inbox && config.inbox.provider !== "none") {
    const created = createInbox(config, { sources, environment: environment.name });
    if (created.ok) inbox = created.inbox;
    else {
      inboxProblem = `${created.message}${created.fix ? ` Fix: ${created.fix}` : ""}`;
      emit({
        type: "log",
        level: "warn",
        message: `The test inbox can't be used: ${inboxProblem}`,
      });
    }
  }
  const emailDomain =
    options.inbox !== undefined
      ? inbox?.emailDomain
      : config.inbox && config.inbox.provider !== "none"
        ? inboxEmailDomain(config.inbox)
        : undefined;
  const inboxValues: InboxValues | undefined = inbox
    ? createInboxValues({
        inbox,
        allowedDomains: settings.allowedDomains,
        timeoutMs: (config.inbox?.timeoutSeconds ?? 60) * 1000,
        redactor,
      })
    : undefined;
  const testInbox = (since: Date): TestInbox | undefined => {
    if (inboxValues && inbox)
      return createTestInbox({
        values: inboxValues,
        provider: inbox.provider,
        allowedDomains: settings.allowedDomains,
        since,
        redactor,
      });
    if (!inboxProblem) return undefined;
    // Configured but unusable (e.g. a missing key): every read says why.
    const problem = inboxProblem;
    return {
      provider: config.inbox?.provider ?? "inbox",
      secrets: {},
      addressFor: () => null,
      read: async () => ({
        ok: false,
        outcome: "blocked",
        reason: "inbox_unavailable",
        message: `The test inbox can't be used: ${problem}`,
      }),
    };
  };
  // Saved logins (SEC-3); the runner reports them as events, so the store only logs warnings.
  const sessions = new SessionStore({
    projectDir,
    redactor,
    logger: createLogger({ level: "warn", redactor }),
  });
  const testsDirRelative = config.tests?.dir ?? "tests";

  const all = await loadTests(projectDir, config, {
    environment: environment.name,
    seed: runId,
    emailDomain,
  });
  const selected = selectTests(
    projectDir,
    all.tests.map((t) => ({
      path: t.path,
      name: t.expanded.name,
      tags: t.expanded.tags,
    })),
    options,
  );
  const sliced = options.shard
    ? selectShard(
        selected,
        options.shard,
        (t) => all.tests.find((l) => l.path === t.path)?.id ?? t.path,
      )
    : selected;
  const plans: TestPlan[] = sliced.flatMap((t): TestPlan[] => {
    const loadedTest = all.tests.find((l) => l.path === t.path);
    const problems = loadedTest?.diagnostics.filter((d) => d.severity === "error") ?? [];
    const authProblems = loadedTest ? checkTestAuth(loadedTest.spec, config.auth) : [];
    const id = loadedTest?.id ?? t.path;
    // AUT-9: a dataset runs the test once per row; a broken dataset blocks the test.
    const dataset = loadedTest?.expanded.dataset
      ? loadDataset(projectDir, t.path, loadedTest.expanded.dataset)
      : undefined;
    if (dataset && loadedTest && dataset.diagnostics.length === 0)
      dataset.diagnostics.push(...datasetColumnProblems(loadedTest.spec, dataset));
    const allProblems = [...problems, ...authProblems, ...(dataset?.diagnostics ?? [])];
    const base: TestPlan = {
      path: t.path,
      id,
      testId: id,
      name: t.name,
      tags: t.tags,
      ...(hasSpecErrors(problems) ||
      authProblems.length > 0 ||
      (dataset?.diagnostics.length ?? 0) > 0
        ? {
            problem: allProblems
              .map(
                (d) =>
                  `${d.code}: ${d.message}${d.code.startsWith("AUTH_") || d.code.startsWith("DATASET_") ? ` Fix: ${d.fix}` : ""}`,
              )
              .join(" "),
          }
        : {}),
    };
    if (!dataset || base.problem) return [base];
    return dataset.rows.map((row) => ({
      ...base,
      id: `${id}#${row.row}`,
      name: `${t.name} #${row.row}`,
      row,
    }));
  });

  const secrets = resolveSecrets(config, sources, { environment: environment.name });
  // Protected previews (SEC-8): without their secrets (a fork PR gets none, SAF-6)
  // the preview can't be reached, so every test is blocked with the reason.
  const protectedHeaders = protectedHeaderSpecs(settings.protection);
  const protectionMissing = protectionSecretNames(settings.protection).filter(
    (name) => !secrets.secrets[name],
  );
  const budget =
    options.budgetUsd !== undefined
      ? new BudgetMeter("run", options.budgetUsd, "--budget")
      : BudgetMeter.forRun(config);
  const models: Models | undefined =
    options.models === null || mode === "replay-only"
      ? undefined
      : (options.models ??
        createModels({
          config,
          sources,
          environment: environment.name,
          budgets: [budget],
          usageStore: projectUsageStore(projectDir),
          env,
          ...(options.node ? { node: options.node } : {}),
        }));
  const usable = (role: "planner" | "fixer") => {
    try {
      return models?.pool(role).some((entry) => entry.usable) ?? false;
    } catch {
      return false;
    }
  };
  const plannerAvailable = usable("planner");
  const fixerAvailable = usable("fixer");

  // Decisions land in the test attempt that made them (AsyncLocalStorage), else in the run.
  const where = new AsyncLocalStorage<{
    testId: string;
    attempt: number;
    sink: DecisionRecord[];
  }>();
  /**
   * Runs one attempt with its decisions routed to it and its AI waits measured
   * (left out of its time limit) and shown live as model.waiting events.
   */
  const inAttempt = <T>(
    here: { testId: string; attempt: number; sink: DecisionRecord[] },
    fn: () => T,
  ): T => {
    const waits = new AiWaits((info) =>
      emit({ type: "model.waiting", testId: here.testId, attempt: here.attempt, ...info }),
    );
    return where.run(here, () => withAiWaits(waits, fn));
  };
  const onDecision = (record: DecisionRecord) => {
    const here = where.getStore();
    here?.sink.push(record);
    emit({
      type: "decision.made",
      testId: here?.testId ?? null,
      attempt: here?.attempt ?? null,
      decision: record,
    });
  };
  let decisions: Decisions;
  if (options.decisions) {
    decisions = options.decisions;
  } else {
    const project = createProjectDecisions({
      config,
      projectDir,
      onDecision,
      sources,
      environment: environment.name,
      scrub: (text) => redactor.redact(text),
    });
    decisions = project.decisions;
    const warm = await project.warmUp();
    if (!warm.ok)
      emit({
        type: "log",
        level: "warn",
        message: `Decision model warm-up failed: ${warm.failure ?? ""} (rules still decide).`,
      });
  }

  // run:/sql: hooks (AUT-10): from the project folder, with its secrets, scrubbed.
  const hookContext: HookContext = {
    projectDir,
    settings: config.hooks ?? DEFAULT_HOOKS,
    production: settings.production ?? false,
    secrets: secrets.secrets,
    redact: (text) => redactor.redact(text),
    env,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const cells: TargetCell[] = target.cells;
  /** A matrix run gives each entry its own TestResult (TGT-5): the test id plus the entry. */
  const resultId = (plan: TestPlan, cell: TargetCell) =>
    cells.length > 1 ? `${plan.id}@${cellLabel(cell)}` : plan.id;
  const evidenceMode: EvidenceMode =
    options.evidence ??
    (settings.run?.evidence as EvidenceMode | undefined) ??
    (config.run.evidence as EvidenceMode | undefined) ??
    (inCi(env) ? "full" : "failures");
  const signal = options.signal;
  const retries = Math.max(0, options.retries ?? settings.run?.retries ?? config.run.retries);
  const testsDir = resolve(projectDir, config.tests?.dir ?? "tests");
  // REP-8: on a feature branch, recordings are read from and written to the branch's own.
  const branch = recordingBranch(config.recordings ?? { branches: "auto" }, env, projectDir);
  if (branch)
    emit({
      type: "log",
      level: "info",
      message: `Branch ${branch.name}: recordings are written to the branch's own (main's are used where it has none). Promote them after the merge: ${brand.cliName} recordings promote.`,
    });
  const history = recentAiUsage(dataDir, { exclude: runId });
  const healHistory = recentHeals(dataDir, { exclude: runId, limit: REPEATED_HEALS.runs - 1 });
  // DIA-5: today's mutes, and each test's recent verdicts (for mute suggestions).
  const runDate = new Date();
  const verdictHistory = recentVerdicts(dataDir, { exclude: runId });
  const results: TestResult[] = [];
  const contexts = new Map<
    string,
    { attempts: Record<number, AttemptObservations>; stepFlows: Record<number, string[]> }
  >();
  const recorded: RunTestsResult["recorded"] = [];
  const healsPerTest: RunTestsResult["heals"] = {};
  const scratch = mkdtempSync(join(tmpdir(), `${brand.cliName}-run-`));

  const runOne = async (
    plan: TestPlan,
    cell: TargetCell,
    worker: TargetWorker,
    workerIndex: number,
  ) => {
    const device = cell.device;
    const browserName: BrowserName = cell.target === "web" ? cell.browser : "chromium";
    // What recordings note as the browser: the web engine, or "android".
    const recordedBrowser = cell.target === "web" ? cell.browser : "android";
    const testId = resultId(plan, cell);
    const matrix = matrixOf(cell);
    emit({
      type: "test.started",
      testId,
      file: plan.path,
      name: plan.name,
      tags: plan.tags,
      matrix,
    });
    const recent = history.get(testId) ?? null;
    // DIA-5: a muted test runs as usual; only its verdict doesn't count.
    const mute = muteState(config.quarantine ?? [], { path: plan.path, id: plan.testId }, runDate);
    const muteFields = {
      ...(mute.muted ? { muted: mute.muted } : {}),
      ...(mute.expired ? { muteExpired: mute.expired } : {}),
    };
    if (mute.expired)
      emit({
        type: "log",
        level: "warn",
        testId,
        message: `The mute of ${plan.path} ended on ${mute.expired.until} ("${mute.expired.reason}"): it counts again. Renew it with ${brand.cliName} mute ${plan.path} --renew --until <date> --reason "…", or fix the test.`,
      });
    if (plan.problem) {
      emit({
        type: "test.finished",
        testId,
        verdict: "blocked",
        decidedBy: [{ kind: "blocked", reason: "config_error", message: plan.problem }],
        failureCause: "blocked",
        headline: `Blocked: the test file has problems: ${plan.problem}`,
        recentAi: recent,
        ...muteFields,
      });
      return;
    }
    if (protectionMissing.length > 0) {
      const names = protectionMissing.join(", ");
      const message = `The protected preview needs ${names}, which has no value here (pull requests from forks get no secrets).`;
      emit({
        type: "test.finished",
        testId,
        verdict: "blocked",
        decidedBy: [{ kind: "blocked", reason: "missing_secret", message }],
        failureCause: "blocked",
        headline: `Blocked: ${message}`,
        recentAi: recent,
        ...muteFields,
      });
      return;
    }
    // Every dataset row replays (and records into) the test's one recording.
    const files = recordingFiles(testsDir, plan.testId, branch);
    const file = files.write;
    const stored = readRecording(files.read);
    const previous = stored?.ok ? stored.recording : undefined;
    if (stored && !stored.ok)
      emit({
        type: "log",
        level: "warn",
        testId,
        message: `The recording of ${plan.path} can't be read; it will be re-recorded where possible.`,
      });

    const records: (AttemptRecord & {
      modelCalls: ModelCall[];
      decisions: DecisionRecord[];
      artifacts: ArtifactRef[];
    })[] = [];
    const observations: Record<number, AttemptObservations> = {};
    let expandedForFlows: ExpandedTest | undefined;
    let lastReplay: ReplayResult | undefined;
    const authoredSteps: StepRecording[] = [];
    const authoredChecks: CheckRecording[] = [];
    let authoredModel: string | null = null;
    let withoutAi = 0;
    let byFixer = 0;
    let needsAi = 0;
    // Heals the `auto` policy applied (final attempt only: a heal counts once it proved itself).
    let autoPatches: HealPatch[] = [];
    let policy: HealPolicy = (settings.run?.healPolicy ?? config.run.healPolicy) as HealPolicy;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const sink: DecisionRecord[] = [];
      // 1.5: what the attempt's attempt.finished carries besides its status.
      const attemptExtras: { mocks?: MockUse[]; accessibility?: AccessibilityReport } = {};
      const artifacts: ArtifactRef[] = [];
      const loadedTest = await loadTest(projectDir, plan.path, config, {
        environment: environment.name,
        seed: `${runId}:${testId}:${attempt}`,
        emailDomain,
        ...(plan.row ? { data: plan.row.values } : {}),
      });
      const expanded = loadedTest?.expanded;
      emit({ type: "attempt.started", testId, attempt });
      if (!expanded) {
        emit({ type: "attempt.finished", testId, attempt, status: "blocked" });
        records.push({
          attempt,
          status: "blocked",
          steps: [],
          checks: [],
          heals: [],
          failure: null,
          blocked: {
            reason: "config_error",
            message: `${plan.path} can't be read.`,
            stepIndex: null,
          },
          modelCalls: [],
          decisions: [],
          artifacts,
        });
        break;
      }
      expandedForFlows = expanded;
      policy = (expanded.heal ?? settings.run?.healPolicy ?? config.run.healPolicy) as HealPolicy;
      const hasCode = expanded.steps.some((s) => s.kind === "exact" && s.exact?.form === "code");
      const auth = testAuth(expanded.auth ?? undefined, config.auth);
      // Not on Android yet (MOB-1): code steps run in Playwright, auth profiles keep browser state.
      const unsupported =
        target.name !== "android"
          ? undefined
          : hasCode
            ? "Code steps (```ts) run in a browser: they can't run on Android yet."
            : auth.kind === "profile"
              ? `The auth profile "${auth.name}" keeps a browser login: profiles can't be used on Android yet. Log in with steps instead.`
              : undefined;
      if (unsupported) {
        emit({ type: "attempt.finished", testId: plan.id, attempt, status: "blocked" });
        records.push({
          attempt,
          status: "blocked",
          steps: [],
          checks: [],
          heals: [],
          failure: null,
          blocked: { reason: "config_error", message: unsupported, stepIndex: null },
          modelCalls: [],
          decisions: sink,
          artifacts,
        });
        break;
      }
      const attemptEmit = (event: Parameters<Parameters<typeof replayAttempt>[0]["emit"]>[0]) => {
        switch (event.type) {
          case "step.started":
            emit({
              type: "step.started",
              testId,
              attempt,
              index: event.index,
              key: event.key,
              text: event.text,
              kind: event.kind,
            });
            break;
          case "step.finished":
            emit({ type: "step.finished", testId, attempt, step: event.step });
            break;
          case "check.evaluated":
            emit({ type: "check.evaluated", testId, attempt, check: event.check });
            break;
          case "heal.proposed":
            // Under `auto` a heal is emitted when its attempt ends, accepted only if the attempt passed.
            if (policy !== "auto")
              emit({ type: "heal.proposed", testId, attempt, heal: event.heal });
            break;
          case "model.called":
            emit({ type: "model.called", testId, attempt, call: event.call });
            break;
          case "log":
            emit({ type: "log", level: event.level, testId, message: event.message });
            break;
        }
      };

      let result: ReplayResult;
      if (hasCode) {
        result = await inAttempt({ testId, attempt, sink }, () =>
          runSpecTest({
            projectDir,
            testPath: plan.path,
            test: expanded,
            attempt,
            environment: environment.name,
            env,
            emit: attemptEmit,
            newId: ulid,
            headless: options.headless ?? true,
            browser: browserName,
            node: options.node,
          }),
        );
      } else {
        const evidenceDir = mkdtempSync(join(scratch, `${portableSegment(testId)}-${attempt}-`));
        // Minimal evidence records no trace or network log, except on a retry (after a failure).
        const fullCapture = evidenceMode !== "minimal" || attempt > 1;
        const attemptInbox = testInbox(new Date());
        // ENV-4: the test's recorded traffic (web), recorded or answered from.
        const trafficFile = join(testsDir, brand.dataDirName, `${plan.testId}.network.har`);
        const networkMode =
          target.name !== "web" || options.network === "live"
            ? undefined
            : options.network === "record"
              ? "record"
              : existsSync(trafficFile)
                ? "replay"
                : undefined;
        const opened = await worker.openAttempt({
          ...(networkMode
            ? {
                network: {
                  mode: networkMode,
                  file: trafficFile,
                  label: posix(relative(projectDir, trafficFile)),
                },
              }
            : {}),
          allowedDomains: settings.allowedDomains,
          secrets: { ...secrets.secrets, ...attemptInbox?.secrets },
          protectedHeaders,
          uploadDir: dirname(join(projectDir, plan.path)),
          evidenceDir,
          video: options.video ?? true,
          capture: { trace: fullCapture, network: fullCapture },
          ...(options.locale ? { locale: options.locale } : {}),
          ...(options.timezone ? { timezone: options.timezone } : {}),
          ...(options.viewport ? { viewport: options.viewport } : {}),
          redact: (text) => redactor.redact(text),
        });
        if (!opened.ok) {
          rmSync(evidenceDir, { recursive: true, force: true });
          emit({ type: "attempt.finished", testId, attempt, status: "blocked" });
          records.push({
            attempt,
            status: "blocked",
            steps: [],
            checks: [],
            heals: [],
            failure: null,
            blocked: { reason: opened.reason, message: opened.message, stepIndex: null },
            modelCalls: [],
            decisions: sink,
            artifacts,
          });
          break;
        }
        const open = opened.session;
        const web = opened.web;
        const commonReplay = {
          mode,
          decisions,
          models,
          budget,
          fixerAvailable,
          plannerAvailable,
          production: settings.production,
          ...(options.checkTimeoutMs !== undefined
            ? { checkTimeoutMs: options.checkTimeoutMs }
            : {}),
          newId: ulid,
          redact: (text: string) => redactor.redact(text),
        };
        const openLogin = worker.openLoginSession;
        const prepare =
          auth.kind === "profile" && web && openLogin
            ? () =>
                profileLogin({
                  name: auth.name,
                  profile: auth.profile,
                  auth: config.auth,
                  store: sessions,
                  environment: environment.name,
                  worker: workerIndex,
                  session: web,
                  stepIndex: expanded.steps.length,
                  runFlow: () =>
                    replayProfileFlow({
                      projectDir,
                      config,
                      branch,
                      environment: environment.name,
                      profile: auth.profile,
                      seed: `${runId}:auth:${auth.name}:${testId}:${attempt}`,
                      emailDomain,
                      inbox: () => testInbox(new Date()),
                      openSession: (extra) =>
                        openLogin({
                          allowedDomains: settings.allowedDomains,
                          secrets: { ...secrets.secrets, ...extra },
                          ...(options.locale ? { locale: options.locale } : {}),
                          ...(options.timezone ? { timezone: options.timezone } : {}),
                          ...(options.viewport ? { viewport: options.viewport } : {}),
                          redact: (text) => redactor.redact(text),
                        }),
                      replay: {
                        ...commonReplay,
                        policy: (settings.run?.healPolicy ?? config.run.healPolicy) as HealPolicy,
                      },
                      onLog: (message) => emit({ type: "log", level: "info", testId, message }),
                      saveAuthored: (flow, previousFlow, authored, paths) => {
                        writeRecording(
                          paths.recording,
                          mergeRecording(flow, previousFlow, authored, {
                            testPath: paths.test,
                            target: config.project?.target ?? "web",
                            engineVersion,
                            browser: recordedBrowser,
                            device,
                            environment: environment.name,
                            now: new Date().toISOString(),
                          }),
                        );
                        recorded.push({
                          test: paths.test,
                          recording: posix(relative(projectDir, paths.recording)),
                          specs: [],
                          warnings: [],
                        });
                      },
                    }),
                })
            : undefined;
        let replayed: ReplayResult | undefined;
        try {
          if (options.beforeAttempt)
            await options.beforeAttempt({ testId, attempt, session: open });
          result = await inAttempt({ testId, attempt, sink }, () =>
            replayAttempt({
              projectDir,
              accessibility: (options.accessibility ?? config.accessibility ?? "off") === "warn",
              hookContext,
              inbox: attemptInbox,
              ...(prepare ? { prepare } : {}),
              test: expanded,
              recording: previous,
              session: open,
              attempt,
              mode,
              policy,
              testPath: plan.path,
              decisions,
              models,
              budget,
              fixerAvailable,
              plannerAvailable,
              production: settings.production,
              timeoutMs:
                (expanded.timeout ?? settings.run?.timeoutSeconds ?? config.run.timeoutSeconds) *
                1000,
              ...(options.checkTimeoutMs !== undefined
                ? { checkTimeoutMs: options.checkTimeoutMs }
                : {}),
              emit: attemptEmit,
              // A screenshot per step with full evidence; else only where a step failed.
              screenshots: evidenceMode === "full" ? true : "failures",
              screenshotPath: (index, when, contentType) =>
                portablePath(redactor.redact(shotPath(testId, attempt, index, when, contentType))),
              saveScreenshot: (index, when, bytes, contentType) =>
                writer.writeArtifact(
                  {
                    kind: "screenshot",
                    path: shotPath(testId, attempt, index, when, contentType),
                    contentType,
                    scrubbed: true,
                    testId,
                    attempt,
                  },
                  bytes,
                ).path,
              newId: ulid,
              redact: (text) => redactor.redact(text),
              ...(signal ? { signal } : {}),
            }),
          );
          replayed = result;
          if (result.accessibility) attemptExtras.accessibility = result.accessibility;
        } finally {
          // `failures`: a first attempt that passed cleanly doesn't keep its trace and network log.
          const clean =
            evidenceMode === "failures" &&
            attempt === 1 &&
            replayed?.status === "passed" &&
            replayed.heals.length === 0;
          // ENV-4: what mocks and recorded traffic answered (shown apart in reports).
          const uses = opened.web?.mockUses();
          if (uses?.length) attemptExtras.mocks = uses;
          const traffic = opened.web?.traffic();
          if (traffic?.mode === "record")
            emit({
              type: "log",
              level: "info",
              testId,
              message: `Recorded ${traffic.recorded} network answers of ${plan.path} to ${posix(relative(projectDir, trafficFile))} (scrubbed). Later runs answer those requests from it; --live-network turns that off.`,
            });
          const closed = await open.close(clean ? { discard: ["trace", "network"] } : {});
          for (const evidence of closed.evidence) {
            try {
              const bytes = readFileSync(evidence.path);
              if (evidence.kind === "console") {
                const errors = consoleErrors(bytes.toString("utf8"));
                observations[attempt] = { ...observations[attempt], consoleErrors: errors };
              }
              artifacts.push(
                writer.writeArtifact(
                  {
                    kind: evidence.kind,
                    path: runLayout.attemptFile(testId, attempt, evidence.file),
                    contentType: evidence.contentType,
                    scrubbed: true,
                    testId,
                    attempt,
                  },
                  bytes,
                ),
              );
            } catch {
              // A missing evidence file (e.g. no video frames) is not a test problem.
            }
          }
          rmSync(evidenceDir, { recursive: true, force: true });
        }
        if (result.chapters.length > 0)
          artifacts.push(
            writer.writeArtifact(
              {
                kind: "other",
                path: `${runLayout.attemptDir(testId, attempt)}/chapters.vtt`,
                contentType: "text/vtt",
                scrubbed: true,
                testId,
                attempt,
              },
              chaptersVtt(result.chapters),
            ),
          );
      }
      lastReplay = result;
      // What each heal changes in the recording, kept with the run (applied on accept).
      for (const patch of result.patches)
        artifacts.push(
          writer.writeArtifact(
            {
              kind: "other",
              path: runLayout.healPatch(testId, attempt, patch.healId),
              contentType: "application/json",
              scrubbed: true,
              testId,
              attempt,
            },
            `${JSON.stringify(patch, null, 2)}\n`,
          ),
        );
      if (policy === "auto") {
        markAutoApplied(result.heals, result.status === "passed");
        for (const heal of result.heals) {
          emit({ type: "heal.proposed", testId, attempt, heal });
          if (heal.status === "pending" && heal.classification === "behavior_change")
            emit({
              type: "log",
              level: "warn",
              testId,
              message: `Not applied (heal policy auto): the app's behaviour may have changed at step ${heal.stepIndex + 1} of ${plan.path}. Check before accepting (${brand.cliName} heal).`,
            });
        }
        autoPatches = result.patches.filter((p) =>
          result.heals.some((h) => h.id === p.healId && h.status === "accepted"),
        );
      }
      observations[attempt] = { ...result.observations, ...observations[attempt] };
      authoredSteps.push(...result.authored.steps);
      authoredChecks.push(...result.authored.checks);
      authoredModel = result.authored.model ?? authoredModel;
      withoutAi += result.healedWithoutAi;
      byFixer += result.healedByFixer;
      needsAi += result.needsAi;
      emit({ type: "attempt.finished", testId, attempt, status: result.status, ...attemptExtras });
      records.push({ ...result, decisions: sink, artifacts });
      if (result.status !== "failed" || signal?.aborted) break;
    }
    healsPerTest[testId] = { withoutAi, byFixer, needsAi };

    // ── the verdict (code, not a model) and the diagnosis ─────────────────────
    const verdict = decideVerdict(records);
    const last = records.at(-1);
    const stepFlows: Record<number, string[]> = Object.fromEntries(
      (expandedForFlows?.steps ?? []).map((s) => [s.index, s.flowPath]),
    );
    // The auth profile's login step (after the test's own steps) ran its flow.
    const profile = expandedForFlows
      ? testAuth(expandedForFlows.auth ?? undefined, config.auth)
      : undefined;
    if (expandedForFlows && profile?.kind === "profile")
      stepFlows[expandedForFlows.steps.length] = [
        profileFlowPath(testsDirRelative, profile.profile.flow),
      ];
    contexts.set(testId, { attempts: observations, stepFlows });
    let failureCause: FailureCause | null = verdict.verdict === "blocked" ? "blocked" : null;
    const failureEvidence: EvidenceRef[] = [];
    if (verdict.verdict === "failed" || verdict.verdict === "flaky") {
      const provisional = provisionalResult(
        { ...plan, id: testId },
        runId,
        records,
        verdict,
        matrix,
      );
      const lastAttempt = last?.attempt ?? 1;
      const sink = records.at(-1)?.decisions ?? [];
      const before = sink.length;
      const answer = await where.run({ testId, attempt: lastAttempt, sink }, () =>
        classifyFailure(provisional, { decisions, context: { attempts: observations, stepFlows } }),
      );
      const failed = records.find((r) => r.attempt === verdict.failedAttempt);
      failureCause =
        answer.cause && answer.cause !== "blocked"
          ? answer.cause
          : failed?.failure
            ? fallbackCause(
                failed.failure,
                failed.steps,
                verdict.verdict === "flaky" ? "flaky" : "failed",
              )
            : "test_drift";
      for (const item of answer.evidence) {
        const ref = item.ref as EvidenceRef | undefined;
        if (ref && isKnownRef(ref, records)) failureEvidence.push(ref);
      }
      const decision = sink.slice(before).find((d) => d.task === "failure_cause");
      if (decision)
        failureEvidence.push({ kind: "decision", attempt: lastAttempt, decisionId: decision.id });
      if (failed?.failure) {
        const d = failed.failure.decider;
        failureEvidence.push(
          d.kind === "check"
            ? { kind: "check", attempt: d.attempt, checkId: d.checkId }
            : { kind: "step", attempt: d.attempt, stepIndex: d.stepIndex },
        );
        const index =
          d.kind === "step"
            ? d.stepIndex
            : failed.checks.find((c) => c.id === d.checkId)?.stepIndex;
        const shot =
          failed.steps.find((s) => s.index === index)?.screenshots.after ??
          [...failed.steps].reverse().find((s) => s.screenshots.after)?.screenshots.after;
        if (shot) failureEvidence.push({ kind: "artifact", path: shot });
        const trace = failed.artifacts.find((a) => a.kind === "trace");
        if (trace) failureEvidence.push({ kind: "artifact", path: trace.path });
      }
    }
    // DIA-5: a test that looks flaky gets a mute suggestion (never a mute).
    let muteSuggested: Awaited<ReturnType<typeof muteSuggestion>>;
    if (!mute.muted && (verdict.verdict === "failed" || verdict.verdict === "flaky")) {
      const provisional = provisionalResult(
        { ...plan, id: testId },
        runId,
        records,
        verdict,
        matrix,
      );
      muteSuggested = await where.run(
        { testId, attempt: last?.attempt ?? 1, sink: records.at(-1)?.decisions ?? [] },
        () => muteSuggestion(provisional, decisions, verdictHistory.get(testId) ?? []),
      );
      if (muteSuggested)
        emit({
          type: "log",
          level: "info",
          testId,
          message: `${plan.path} looks flaky (${muteSuggested.reason}). While it's being fixed you can mute it: ${brand.cliName} mute ${plan.path} --reason "…" --until 14d`,
        });
    }
    if (mute.muted && verdict.verdict !== "passed")
      emit({
        type: "log",
        level: "info",
        testId,
        message: `${plan.path} is muted until ${mute.muted.until} ("${mute.muted.reason}"): it ran (${verdict.verdict}), and doesn't count.`,
      });
    // HEAL-7: a test that keeps healing should be re-recorded.
    const pastHeals = healHistory.get(testId) ?? { runs: 0, healed: 0 };
    const healsNow = {
      runs: pastHeals.runs + 1,
      healed: pastHeals.healed + (verdict.verdict === "healed" ? 1 : 0),
    };
    if (needsRerecord(healsNow))
      emit({
        type: "log",
        level: "warn",
        testId,
        message: `${plan.path} healed ${healsNow.healed} times in its last ${healsNow.runs} runs: re-record this test (${brand.cliName} run ${plan.path} --rerecord).`,
      });
    emit({
      type: "test.finished",
      testId,
      verdict: verdict.verdict,
      decidedBy: verdict.decidedBy,
      failureCause,
      failureEvidence: dedupeRefs(failureEvidence),
      headline: verdict.headline,
      checkedSummary: verdict.checkedSummary,
      recentAi: recent,
      recentHeals: healsNow,
      ...muteFields,
      ...(muteSuggested ? { muteSuggested } : {}),
    });

    // ── keep what was recorded or compiled (REP-4), heals `auto` applied, and the portable spec ──
    // Only the final attempt's heals count, and only when it passed.
    if (last?.status !== "passed") autoPatches = [];
    let base = previous;
    const applied: string[] = [];
    if (autoPatches.length > 0 && previous) {
      const patched = applyPatches(previous, autoPatches);
      base = patched.recording;
      applied.push(...patched.applied);
      for (const conflict of patched.conflicts)
        emit({
          type: "log",
          level: "warn",
          testId,
          message: `Heal ${conflict.healId} was not applied: ${conflict.reason}.`,
        });
    }
    if (
      (authoredSteps.length > 0 || authoredChecks.length > 0 || applied.length > 0) &&
      expandedForFlows &&
      lastReplay
    ) {
      const next = mergeRecording(
        expandedForFlows,
        base,
        { steps: authoredSteps, checks: authoredChecks, model: authoredModel },
        {
          testPath: plan.path,
          target: config.project?.target ?? "web",
          engineVersion,
          browser: recordedBrowser,
          device,
          environment: environment.name,
          now: new Date().toISOString(),
        },
      );
      writeRecording(file, next);
      const entry = {
        test: plan.path,
        recording: posix(relative(projectDir, file)),
        specs: [] as string[],
        warnings: [] as string[],
      };
      // The portable copy: a Playwright spec, or a Maestro flow for Android (MOB-6).
      if (options.generateSpecs ?? true) {
        try {
          const { generateAfterRecording } = await import("@optestra/codegen/node");
          const generated = await generateAfterRecording(projectDir, plan.path, {
            environment: environment.name,
            env,
          });
          for (const f of generated.files) {
            if (f.status === "edited")
              entry.warnings.push(
                `${f.path} was changed by hand: not regenerated (use generate --force).`,
              );
            else if (f.status !== "unchanged") entry.specs.push(f.path);
          }
          entry.warnings.push(...generated.problems);
        } catch (error) {
          entry.warnings.push(
            `The portable spec could not be regenerated: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      for (const warning of entry.warnings)
        emit({ type: "log", level: "warn", testId: null, message: warning });
      recorded.push(entry);
    }
  };

  // ── workers: tests (× matrix entries) pulled from a shared queue; each worker
  // launches an engine (a browser, an emulator) per kind of cell it needs, once ──
  // Android runs every test on one emulator before booting the next (cell by cell).
  const queue =
    target.name === "android"
      ? cells.flatMap((cell) => plans.map((plan) => ({ plan, cell })))
      : plans.flatMap((plan) => cells.map((cell) => ({ plan, cell })));
  const total = queue.length;
  const workerCount = options.emulator
    ? 1
    : Math.max(1, Math.min(options.workers ?? 1, queue.length || 1));
  const launchErrors = new Map<string, { message: string; reason: BlockedReason }>();
  const unlaunched: typeof queue = [];
  let started = 0;
  const worker = async (index: number) => {
    const engines = new Map<string, TargetWorker>();
    try {
      for (let item = queue.shift(); item; item = queue.shift()) {
        if (signal?.aborted) {
          queue.unshift(item);
          break;
        }
        const key = engineKey(item.cell);
        let launched = engines.get(key);
        if (!launched && item.cell.target === "android") {
          // One emulator per worker at a time: they are heavy.
          for (const [other, engine] of engines) {
            await engine.close();
            engines.delete(other);
          }
        }
        if (!launched && !launchErrors.has(key)) {
          try {
            launched = await launchWorker(target, item.cell, {
              headless: options.headless ?? true,
              ...(options.emulator ? { emulator: options.emulator } : {}),
            });
            engines.set(key, launched);
          } catch (error) {
            launchErrors.set(key, {
              message: error instanceof Error ? error.message : String(error),
              reason: error instanceof TargetLaunchError ? error.reason : "config_error",
            });
          }
        }
        if (!launched) {
          unlaunched.push(item);
          continue;
        }
        started++;
        await runOne(item.plan, item.cell, launched, index);
      }
    } finally {
      for (const engine of engines.values()) await engine.close();
    }
  };
  try {
    await Promise.all(Array.from({ length: workerCount }, (_, index) => worker(index)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (unlaunched.length > 0 && started === 0 && !signal?.aborted) {
    const first = [...launchErrors.values()][0];
    return finishBlocked(
      first?.reason ?? "config_error",
      [...new Set([...launchErrors.values()].map((e) => e.message))].join(" "),
    );
  }
  // An engine of the matrix that couldn't start: its entries are blocked, the rest ran.
  for (const { plan, cell } of unlaunched) {
    const testId = resultId(plan, cell);
    const failed = launchErrors.get(engineKey(cell));
    const message = failed?.message ?? `${cellLabel(cell)} could not start.`;
    emit({
      type: "test.started",
      testId,
      file: plan.path,
      name: plan.name,
      tags: plan.tags,
      matrix: matrixOf(cell),
    });
    emit({
      type: "test.finished",
      testId,
      verdict: "blocked",
      decidedBy: [{ kind: "blocked", reason: failed?.reason ?? "config_error", message }],
      failureCause: "blocked",
      headline: `Blocked: ${message}`,
    });
  }
  const notRun = signal?.aborted ? queue.length : 0;

  // ── DIA-4: group the run's failures (one broken login, many tests) ─────────
  const folded = await (async () => {
    // Fold what has been written so far to get the test results.
    const { foldEvents } = await import("@optestra/contract");
    const events = readEvents(writer);
    return foldEvents([
      ...events,
      {
        seq: events.length,
        ts: new Date().toISOString(),
        runId,
        type: "run.finished",
        blocked: null,
      } as Event,
    ]);
  })();
  results.push(...folded.tests);
  const groups = await groupFailures(results, {
    decisions,
    context: (result) => contexts.get(result.testId) ?? {},
  });
  for (const group of groups) {
    if (group.testIds.length < 2) continue;
    emit({
      type: "log",
      level: "info",
      message: `Failure group ${group.id}: ${group.testIds.length} tests share one failure (${group.signature.cause ?? "unknown cause"}): ${group.signature.headline}`,
    });
  }
  emit({
    type: "run.finished",
    blocked: signal?.aborted
      ? {
          reason: "aborted",
          message: `The run was stopped before it finished${notRun > 0 ? `: ${notRun} of ${total} tests didn't run` : ""}.`,
        }
      : null,
  });
  const final = writer.finish();
  return { dir, run: final.run, tests: final.tests, groups, recorded, heals: healsPerTest };
}

/** CI is set (GitHub Actions, GitLab, most CI services), and not to "false" or "0". */
function inCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.CI?.trim().toLowerCase();
  return Boolean(value) && value !== "false" && value !== "0";
}

/** A step screenshot's place in the run folder: .png for a failed step, .jpg otherwise. */
function shotPath(
  testId: string,
  attempt: number,
  index: number,
  when: "before" | "after",
  contentType: StepShotType,
): string {
  return runLayout.screenshot(
    testId,
    attempt,
    index,
    when,
    contentType === "image/jpeg" ? "jpg" : "png",
  );
}

/** Every event written so far, re-read from the run folder (the writer keeps no public list). */
function readEvents(writer: RunWriter): Event[] {
  const text = readFileSync(join(writer.dir, "events.ndjson"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);
}

function dedupeRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = JSON.stringify(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isKnownRef(
  ref: EvidenceRef,
  records: readonly (AttemptRecord & { decisions: DecisionRecord[] })[],
): boolean {
  if (ref.kind === "artifact") return true;
  const attempt = records.find((r) => r.attempt === ref.attempt);
  if (!attempt) return false;
  if (ref.kind === "check") return attempt.checks.some((c) => c.id === ref.checkId);
  if (ref.kind === "step") return attempt.steps.some((s) => s.index === ref.stepIndex);
  return attempt.decisions.some((d) => d.id === ref.decisionId);
}

/** The TestResult as far as it is known before its cause (for failure_cause's input). */
function provisionalResult(
  plan: TestPlan,
  runId: string,
  records: readonly (AttemptRecord & {
    modelCalls: ModelCall[];
    decisions: DecisionRecord[];
    artifacts: ArtifactRef[];
  })[],
  verdict: ReturnType<typeof decideVerdict>,
  matrix: MatrixEntry,
): TestResult {
  const now = new Date().toISOString();
  const attempts: Attempt[] = records.map((r) => ({
    attempt: r.attempt,
    status: r.status,
    startedAt: now,
    durationMs: 0,
    steps: [...r.steps],
    checks: [...r.checks],
    modelCalls: r.modelCalls,
    decisions: r.decisions,
    heals: [...r.heals],
    artifacts: r.artifacts,
  }));
  return {
    contractVersion: CONTRACT_VERSION,
    runId,
    testId: plan.id,
    file: plan.path,
    name: plan.name,
    tags: plan.tags,
    matrix,
    verdict: verdict.verdict,
    decidedBy: verdict.decidedBy,
    failureCause: null,
    failureEvidence: [],
    headline: verdict.headline,
    checkedSummary: verdict.checkedSummary,
    startedAt: now,
    durationMs: 0,
    ai: {
      calls: 0,
      costUsd: 0,
      unpricedCalls: 0,
      tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 },
      recent: null,
    },
    attempts,
  };
}

/** Run.git from the branch detection (git isn't run); omitted outside a repository. */
function gitInfo(
  env: Readonly<Record<string, string | undefined>>,
  projectDir: string,
): { git?: { branch: string; commit: string | null; pr: number | null } } {
  const branch = detectBranch(env, projectDir);
  if (!branch) return {};
  const pr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "")?.[1];
  return {
    git: { branch: branch.name, commit: env.GITHUB_SHA ?? null, pr: pr ? Number(pr) : null },
  };
}
