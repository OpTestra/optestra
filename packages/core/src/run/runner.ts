import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { brand } from "@testament/brand";
import { type Config, hasErrors } from "@testament/config";
import {
  defaultRedactor,
  dotenvSource,
  loadProject,
  processEnvSource,
  resolveSecrets,
  type SecretSource,
} from "@testament/config/node";
import {
  type ArtifactRef,
  type Attempt,
  type BlockedReason,
  CONTRACT_VERSION,
  type DecisionRecord,
  type Event,
  type EvidenceRef,
  type FailureCause,
  type HealPolicy,
  type HealProposal,
  type ModelCall,
  needsRerecord,
  REPEATED_HEALS,
  type Run,
  type RunMode,
  runLayout,
  type TestResult,
  type Trigger,
  ulid,
} from "@testament/contract";
import { createRunWriter, type EmitInput, runDir, type RunWriter } from "@testament/contract/node";
import {
  classifyFailure,
  type AttemptObservations,
  type Decisions,
  type FailureGroup,
  groupFailures,
} from "@testament/decide";
import { createProjectDecisions } from "@testament/decide/node";
import { BudgetMeter, createModels, type Models, projectUsageStore } from "@testament/models";
import {
  type CheckRecording,
  RECORDING_EPOCH,
  RECORDING_VERSION,
  type Recording,
  type StepRecording,
} from "@testament/recording";
import { readRecording, recordingPath, writeRecording } from "@testament/recording/node";
import { hasSpecErrors, type ExpandedTest } from "@testament/spec";
import { loadTest, loadTests } from "@testament/spec/node";
import { PROMPT_VERSION } from "../author/agent.js";
import { applyPatches, type HealPatch } from "../heal/patch.js";
import { markAutoApplied } from "../heal/policy.js";
import { chaptersVtt, consoleErrors } from "./evidence.js";
import { recentAiUsage, recentHeals } from "./history.js";
import { replayAttempt } from "./replay.js";
import { runSpecTest } from "./spec-run.js";
import type { ReplayResult, ReplaySession } from "./types.js";
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
  browser?: "chromium" | "firefox" | "webkit";
  device?: string;
  /** Record a video per attempt (default true, EVD-1). */
  video?: boolean;
  trigger?: Trigger;
  /** Every event as it is written. */
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

interface TestPlan {
  path: string;
  id: string;
  name: string;
  tags: string[];
  problem?: string;
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
        ? PROMPT_VERSION
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
  const writer: RunWriter = createRunWriter(dir, { scrub: (text) => redactor.redact(text), runId });
  const emit = (event: EmitInput) => {
    const written = writer.emit(event);
    options.onEvent?.(written);
    return written;
  };
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
  if (!environment || !settings?.baseUrl)
    return finishBlocked(
      "config_error",
      `The environment${environment ? ` "${environment.name}"` : ""} has no baseUrl. Choose one with --env, or set baseUrl.`,
    );
  const baseUrl = settings.baseUrl;

  const all = await loadTests(projectDir, config, { environment: environment.name, seed: runId });
  const selected = selectTests(
    projectDir,
    all.tests.map((t) => ({
      path: t.path,
      name: t.expanded.name,
      tags: t.expanded.tags,
    })),
    options,
  );
  const plans: TestPlan[] = selected.map((t) => {
    const loadedTest = all.tests.find((l) => l.path === t.path);
    const problems = loadedTest?.diagnostics.filter((d) => d.severity === "error") ?? [];
    return {
      path: t.path,
      id: loadedTest?.id ?? t.path,
      name: t.name,
      tags: t.tags,
      ...(hasSpecErrors(problems)
        ? { problem: problems.map((d) => `${d.code}: ${d.message}`).join(" ") }
        : {}),
    };
  });

  const sources = options.secretSources ?? [processEnvSource(env), dotenvSource(projectDir)];
  const secrets = resolveSecrets(config, sources, { environment: environment.name });
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

  const browserModule = await import("@testament/browser");
  const device = options.device ?? browserModule.DEFAULT_DEVICE;
  const browserName = options.browser ?? "chromium";
  const retries = Math.max(0, options.retries ?? settings.run?.retries ?? config.run.retries);
  const testsDir = resolve(projectDir, config.tests?.dir ?? "tests");
  const history = recentAiUsage(dataDir, { exclude: runId });
  const healHistory = recentHeals(dataDir, { exclude: runId, limit: REPEATED_HEALS.runs - 1 });
  const results: TestResult[] = [];
  const contexts = new Map<
    string,
    { attempts: Record<number, AttemptObservations>; stepFlows: Record<number, string[]> }
  >();
  const recorded: RunTestsResult["recorded"] = [];
  const healsPerTest: RunTestsResult["heals"] = {};
  const scratch = mkdtempSync(join(tmpdir(), `${brand.cliName}-run-`));

  const runOne = async (plan: TestPlan, launched: import("@testament/browser").LaunchedBrowser) => {
    const matrix = { target: "web" as const, browser: browserName, device };
    emit({
      type: "test.started",
      testId: plan.id,
      file: plan.path,
      name: plan.name,
      tags: plan.tags,
      matrix,
    });
    const recent = history.get(plan.id) ?? null;
    if (plan.problem) {
      emit({
        type: "test.finished",
        testId: plan.id,
        verdict: "blocked",
        decidedBy: [{ kind: "blocked", reason: "config_error", message: plan.problem }],
        failureCause: "blocked",
        headline: `Blocked: the test file has problems: ${plan.problem}`,
        recentAi: recent,
      });
      return;
    }
    const file = recordingPath(testsDir, plan.id);
    const stored = readRecording(file);
    const previous = stored?.ok ? stored.recording : undefined;
    if (stored && !stored.ok)
      emit({
        type: "log",
        level: "warn",
        testId: plan.id,
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
      const artifacts: ArtifactRef[] = [];
      const loadedTest = await loadTest(projectDir, plan.path, config, {
        environment: environment.name,
        seed: `${runId}:${plan.id}:${attempt}`,
      });
      const expanded = loadedTest?.expanded;
      emit({ type: "attempt.started", testId: plan.id, attempt });
      if (!expanded) {
        emit({ type: "attempt.finished", testId: plan.id, attempt, status: "blocked" });
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
      const attemptEmit = (event: Parameters<Parameters<typeof replayAttempt>[0]["emit"]>[0]) => {
        switch (event.type) {
          case "step.started":
            emit({
              type: "step.started",
              testId: plan.id,
              attempt,
              index: event.index,
              key: event.key,
              text: event.text,
              kind: event.kind,
            });
            break;
          case "step.finished":
            emit({ type: "step.finished", testId: plan.id, attempt, step: event.step });
            break;
          case "check.evaluated":
            emit({ type: "check.evaluated", testId: plan.id, attempt, check: event.check });
            break;
          case "heal.proposed":
            // Under `auto` a heal is emitted when its attempt ends, accepted only if the attempt passed.
            if (policy !== "auto")
              emit({ type: "heal.proposed", testId: plan.id, attempt, heal: event.heal });
            break;
          case "model.called":
            emit({ type: "model.called", testId: plan.id, attempt, call: event.call });
            break;
          case "log":
            emit({ type: "log", level: event.level, testId: plan.id, message: event.message });
            break;
        }
      };

      let result: ReplayResult;
      if (hasCode) {
        result = await where.run({ testId: plan.id, attempt, sink }, () =>
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
          }),
        );
      } else {
        const evidenceDir = mkdtempSync(join(scratch, `${plan.id}-${attempt}-`));
        let session: import("@testament/browser").Session | undefined;
        try {
          session = await browserModule.openSession({
            browser: launched,
            device,
            baseUrl,
            allowedDomains: settings.allowedDomains,
            secrets: secrets.secrets,
            allowUpload: { dir: dirname(join(projectDir, plan.path)) },
            evidence: {
              trace: true,
              console: true,
              network: true,
              video: options.video ?? true,
              dir: evidenceDir,
            },
            redact: (text) => redactor.redact(text),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emit({ type: "attempt.finished", testId: plan.id, attempt, status: "blocked" });
          records.push({
            attempt,
            status: "blocked",
            steps: [],
            checks: [],
            heals: [],
            failure: null,
            blocked: {
              reason: "config_error",
              message: `The browser could not start: ${message}`,
              stepIndex: null,
            },
            modelCalls: [],
            decisions: sink,
            artifacts,
          });
          break;
        }
        const open = session;
        try {
          if (options.beforeAttempt)
            await options.beforeAttempt({ testId: plan.id, attempt, session: open });
          result = await where.run({ testId: plan.id, attempt, sink }, () =>
            replayAttempt({
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
              saveScreenshot: (index, when, bytes) =>
                writer.writeArtifact(
                  {
                    kind: "screenshot",
                    path: runLayout.screenshot(plan.id, attempt, index, when),
                    contentType: "image/png",
                    scrubbed: true,
                    testId: plan.id,
                    attempt,
                  },
                  bytes,
                ).path,
              newId: ulid,
              redact: (text) => redactor.redact(text),
            }),
          );
        } finally {
          const closed = await open.close();
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
                    path: runLayout.attemptFile(plan.id, attempt, evidence.file),
                    contentType: evidence.contentType,
                    scrubbed: true,
                    testId: plan.id,
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
                path: `${runLayout.attemptDir(plan.id, attempt)}/chapters.vtt`,
                contentType: "text/vtt",
                scrubbed: true,
                testId: plan.id,
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
              path: runLayout.healPatch(plan.id, attempt, patch.healId),
              contentType: "application/json",
              scrubbed: true,
              testId: plan.id,
              attempt,
            },
            `${JSON.stringify(patch, null, 2)}\n`,
          ),
        );
      if (policy === "auto") {
        markAutoApplied(result.heals, result.status === "passed");
        for (const heal of result.heals) {
          emit({ type: "heal.proposed", testId: plan.id, attempt, heal });
          if (heal.status === "pending" && heal.classification === "behavior_change")
            emit({
              type: "log",
              level: "warn",
              testId: plan.id,
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
      emit({ type: "attempt.finished", testId: plan.id, attempt, status: result.status });
      records.push({ ...result, decisions: sink, artifacts });
      if (result.status !== "failed") break;
    }
    healsPerTest[plan.id] = { withoutAi, byFixer, needsAi };

    // ── the verdict (code, not a model) and the diagnosis ─────────────────────
    const verdict = decideVerdict(records);
    const last = records.at(-1);
    const stepFlows = Object.fromEntries(
      (expandedForFlows?.steps ?? []).map((s) => [s.index, s.flowPath]),
    );
    contexts.set(plan.id, { attempts: observations, stepFlows });
    let failureCause: FailureCause | null = verdict.verdict === "blocked" ? "blocked" : null;
    const failureEvidence: EvidenceRef[] = [];
    if (verdict.verdict === "failed" || verdict.verdict === "flaky") {
      const provisional = provisionalResult(
        plan,
        runId,
        records,
        verdict,
        matrixOf(browserName, device),
      );
      const lastAttempt = last?.attempt ?? 1;
      const sink = records.at(-1)?.decisions ?? [];
      const before = sink.length;
      const answer = await where.run({ testId: plan.id, attempt: lastAttempt, sink }, () =>
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
    // HEAL-7: a test that keeps healing should be re-recorded.
    const pastHeals = healHistory.get(plan.id) ?? { runs: 0, healed: 0 };
    const healsNow = {
      runs: pastHeals.runs + 1,
      healed: pastHeals.healed + (verdict.verdict === "healed" ? 1 : 0),
    };
    if (needsRerecord(healsNow))
      emit({
        type: "log",
        level: "warn",
        testId: plan.id,
        message: `${plan.path} healed ${healsNow.healed} times in its last ${healsNow.runs} runs: re-record this test (${brand.cliName} run ${plan.path} --rerecord).`,
      });
    emit({
      type: "test.finished",
      testId: plan.id,
      verdict: verdict.verdict,
      decidedBy: verdict.decidedBy,
      failureCause,
      failureEvidence: dedupeRefs(failureEvidence),
      headline: verdict.headline,
      checkedSummary: verdict.checkedSummary,
      recentAi: recent,
      recentHeals: healsNow,
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
          testId: plan.id,
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
          browser: browserName,
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
      if (options.generateSpecs ?? true) {
        try {
          const { generateAfterRecording } = await import("@testament/codegen/node");
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

  // ── workers: one browser each, tests pulled from a shared queue ─────────────
  const queue = [...plans];
  const workerCount = Math.max(1, Math.min(options.workers ?? 1, queue.length || 1));
  let setupError: string | undefined;
  const worker = async () => {
    let launched: import("@testament/browser").LaunchedBrowser | undefined;
    try {
      launched = await browserModule.launchBrowser({
        browser: browserName,
        headless: options.headless ?? true,
      });
    } catch (error) {
      const fix = error instanceof browserModule.BrowserSetupError ? ` Fix: ${error.fix}` : "";
      setupError = `${error instanceof Error ? error.message : String(error)}${fix}`;
      return;
    }
    try {
      for (let plan = queue.shift(); plan; plan = queue.shift()) await runOne(plan, launched);
    } finally {
      await launched.close();
    }
  };
  try {
    await Promise.all(Array.from({ length: workerCount }, worker));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (setupError && queue.length === plans.length && plans.length > 0)
    return finishBlocked("config_error", `The browser could not start: ${setupError}`);

  // ── DIA-4: group the run's failures (one broken login, many tests) ─────────
  const folded = await (async () => {
    // Fold what has been written so far to get the test results.
    const { foldEvents } = await import("@testament/contract");
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
  emit({ type: "run.finished", blocked: null });
  const final = writer.finish();
  return { dir, run: final.run, tests: final.tests, groups, recorded, heals: healsPerTest };
}

function matrixOf(browser: "chromium" | "firefox" | "webkit", device: string) {
  return { target: "web" as const, browser, device };
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
  matrix: ReturnType<typeof matrixOf>,
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
