import type { Action, LocatorSpec, PageCopy } from "@testament/browser";
import { defaultRedactor } from "@testament/config/node";
import { type ModelCall, ulid } from "@testament/contract";
import { type ModelCallRecord, toModelCall } from "@testament/models";
import {
  type CheckOp,
  type CheckRecording,
  checkKey,
  type Command,
  describeCheck,
  type Locator,
  RECORDING_EPOCH,
  RECORDING_VERSION,
  type RecordedAction,
  type Recording,
  routeOf,
  type StepRecording,
  stepKey,
} from "@testament/recording";
import type {
  BoundText,
  ExactOp,
  ExpandedStep,
  ExpandedTest,
  Locator as SpecLocator,
} from "@testament/spec";
import { type CompiledCheck, compileCheck, verifyCheck } from "../checks/index.js";
import { type ActionStepResult, PROMPT_VERSION, runActionStep } from "./agent.js";
import { commandOf } from "./commands.js";
import { parseGuard } from "./guards.js";
import {
  type AuthoringReport,
  type AuthorOptions,
  type AuthorResult,
  type CheckReport,
  DEFAULT_LIMITS,
  FAILURE_REASONS,
  type HookReport,
  type StepReport,
  type StopReason,
} from "./types.js";
import { type StepVariables, segmentsTemplate, stepVariables } from "./variables.js";

// authorTest (LOOP-1): runs a test's expanded steps once with the AI agent and
// returns the recording (what was done, for replay without AI) and an authoring
// report. No verdicts. Expect/Soft lines are compiled into typed checks against
// the page as it is at that point (LOOP-2), evaluated once and sanity-tested; a
// check that fails while authoring is kept and flagged, never dropped.

type BoundValue = BoundText;

function specLocator(locator: SpecLocator): Locator {
  switch (locator.by) {
    case "role":
      return locator.name === undefined
        ? { kind: "role", role: locator.role }
        : { kind: "role", role: locator.role, name: locator.name, exact: true };
    case "label":
      return { kind: "label", text: locator.value, exact: true };
    case "testid":
      return { kind: "testId", value: locator.value };
    case "text":
      return { kind: "text", text: locator.value, exact: true };
    case "placeholder":
      return { kind: "placeholder", text: locator.value, exact: true };
    case "css":
      return { kind: "css", selector: locator.value };
  }
}

const templateOf = (value: unknown): string =>
  segmentsTemplate((value as { segments: Parameters<typeof segmentsTemplate>[0] }).segments);

/** The check op of an `Exact:` expect op, or undefined for exact actions. */
export function exactCheck(op: ExactOp<BoundValue>): CheckOp | undefined {
  switch (op.op) {
    case "expectUrl":
      return { type: "url", match: op.match, value: templateOf(op.value) };
    case "expectText":
      return {
        type: "text",
        target: specLocator(op.target),
        match: op.match === "text" ? "equals" : "contains",
        value: templateOf(op.value),
      };
    case "expectState":
      return { type: "element_state", target: specLocator(op.target), state: op.state };
    case "expectCount":
      return { type: "count", target: specLocator(op.target), n: op.count };
    default:
      return undefined;
  }
}

export async function authorTest(
  test: ExpandedTest,
  options: AuthorOptions,
): Promise<AuthorResult> {
  const now = options.now ?? (() => new Date());
  const redact = options.redact ?? ((text: string) => defaultRedactor.redact(text));
  const session = options.session;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const runId = ulid();
  const startedAt = now().toISOString();
  const screenshots = new Map<string, Uint8Array>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), options.timeoutMs);

  const hooks: HookReport[] = [];
  const steps: StepReport[] = [];
  const recorded = new Map<string, StepRecording>();
  const compiled = new Map<string, CheckRecording>();
  // The page as the latest action step began (sanity before-state; network checks count from here).
  let before: PageCopy | undefined;
  let stop: { reason: StopReason; message?: string } | undefined;
  let model: string | null = null;
  const emit = options.onEvent ?? (() => {});

  const guardSteps = test.guards;
  const guardContext = {
    guards: guardSteps.map((g) => parseGuard(g.display)),
    production: options.production ?? false,
    allowDestructive: test.allowDestructive,
  };

  try {
    // Setup hooks (AUT-10): requests only for now.
    if (options.hooks ?? true) {
      for (const hook of test.setup) {
        const report = await runHook(session, hook, "setup");
        hooks.push(report);
        emit({ type: "hook", hook: report });
        if (report.status === "unsupported") {
          stop = { reason: "hook_unsupported", message: report.message ?? "" };
          break;
        }
        if (report.status !== "ok") {
          stop = {
            reason: report.status === "refused" ? "disallowed_domain" : "setup_failed",
            message: report.message ?? "",
          };
          break;
        }
      }
    }

    // The test's login (auth: <profile>, SEC-3): after the setup hooks, before the start page.
    if (!stop && options.prepare) {
      const prepared = await options.prepare();
      if (!prepared.ok) stop = { reason: prepared.reason, message: redact(prepared.message) };
    }

    if (!stop && test.start && (options.openStart ?? true)) {
      const url = test.start.display;
      const outcome = await session.act({ type: "goto", url });
      if (outcome.status === "refused")
        stop = { reason: "disallowed_domain", message: outcome.message ?? "" };
      else if (outcome.status !== "ok")
        stop = {
          reason: "setup_failed",
          message: `Could not open ${url}: ${outcome.message ?? outcome.status}`,
        };
    }

    for (const step of test.steps) {
      const base: StepReport = {
        index: step.index,
        number: step.number,
        kind: step.kind,
        text: step.text,
        status: "skipped",
        actions: [],
        modelCalls: [],
        costUsd: 0,
        screenshots: {},
        refusals: [],
      };
      const exact =
        step.kind === "exact" && step.exact?.form === "op"
          ? exactCheck(step.exact.op as ExactOp<BoundValue>)
          : undefined;
      if (step.kind === "expect" || step.kind === "soft" || exact) {
        if (stop || options.checks === false || controller.signal.aborted) {
          steps.push({
            ...base,
            status: stop || controller.signal.aborted ? "skipped" : "pending",
            message: stop
              ? "Not checked: the test stopped before this step."
              : "Checks were not compiled in this run.",
          });
          continue;
        }
        emit({ type: "step.started", index: step.index, number: step.number, text: step.text });
        const report: StepReport = { ...base, route: routeOf(session.url) };
        const outcome = await authorCheck(step, exact, {
          session,
          models: options.models,
          budget: options.budget,
          signal: controller.signal,
          tags: { test: test.id, step: String(step.number ?? step.index + 1) },
          values: stepVariables(test, step).values,
          before,
          ...(options.checkTimeoutMs !== undefined ? { timeoutMs: options.checkTimeoutMs } : {}),
        });
        report.status = outcome.check.op.type === "pending" ? "pending" : "recorded";
        report.check = {
          ...outcome.check,
          ...(outcome.check.problem ? { problem: redact(outcome.check.problem) } : {}),
          ...(outcome.check.actual !== null ? { actual: redact(outcome.check.actual) } : {}),
        };
        if (outcome.check.problem) report.message = redact(outcome.check.problem);
        else if (outcome.check.passed === false)
          report.message = redact(
            `The check failed while authoring: expected ${JSON.stringify(outcome.check.expected)}, saw ${JSON.stringify(outcome.check.actual)}.`,
          );
        report.modelCalls = outcome.modelCalls;
        report.costUsd = outcome.modelCalls.some((c) => c.costUsd === null)
          ? null
          : outcome.modelCalls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
        if (outcome.model) model = outcome.model;
        steps.push(report);
        emit({ type: "step.finished", step: report });
        compiled.set(step.textKey, {
          key: checkKey(step.textKey),
          textKey: step.textKey,
          text: step.text,
          soft: step.kind === "soft",
          check: outcome.check.op,
          generatedBy: outcome.check.generatedBy,
          summary: outcome.check.summary,
          ...(outcome.check.rule ? { rule: outcome.check.rule } : {}),
          ...(outcome.check.sanity ? { sanity: outcome.check.sanity } : {}),
          ...(outcome.check.passed === false
            ? {
                failedAtAuthoring: {
                  expected: outcome.check.expected,
                  actual: outcome.check.actual === null ? null : redact(outcome.check.actual),
                },
              }
            : {}),
          ...(outcome.check.problem ? { problem: redact(outcome.check.problem) } : {}),
          recordedAt: now().toISOString(),
        });
        continue;
      }
      if (stop) {
        steps.push(base);
        continue;
      }
      if (controller.signal.aborted) {
        stop = { reason: "timeout", message: "The test's time limit was reached." };
        steps.push({ ...base, status: "stopped", reason: "timeout", message: stop.message ?? "" });
        continue;
      }

      const route = routeOf(session.url);
      const key = stepKey(step.textKey, route);
      emit({ type: "step.started", index: step.index, number: step.number, text: step.text });
      const variables = stepVariables(test, step);
      const report: StepReport = { ...base, route, key };
      const shoot = async (when: "before" | "after") => {
        if (options.screenshots === false) return;
        const shot = await session.screenshot();
        if (shot.status !== "ok") return;
        const path = `steps/${step.index}-${when}.png`;
        screenshots.set(path, shot.bytes);
        report.screenshots[when] = path;
      };

      let outcome: ActionStepResult;
      // A copy of the page before the action, for the sanity test of the checks after it (VER-6).
      if (options.checks !== false) before = await session.pageCopy();
      await shoot("before");
      if (step.kind === "exact" && step.exact?.form === "code") {
        outcome = {
          status: "stopped",
          reason: "code_step_needs_replay",
          message:
            "Code steps run from the generated Playwright spec (replay), not while authoring.",
          commands: [],
          actions: [],
          modelCalls: [],
          records: [],
          refusals: [],
        };
      } else if (step.kind === "exact" && step.exact?.form === "op") {
        outcome = await runExactOp(session, step, step.exact.op as ExactOp<BoundValue>, variables);
      } else {
        outcome = await runActionStep(
          {
            session,
            models: options.models,
            budget: options.budget,
            guards: guardContext,
            limits,
            guardLines: guardSteps.map((g) => g.display),
            signal: controller.signal,
            tags: { test: test.id },
            inbox: { runtime: options.inbox, test },
          },
          step,
          variables,
        );
      }
      await shoot("after");

      report.status = outcome.status;
      if (outcome.reason) report.reason = outcome.reason;
      if (outcome.message !== undefined) report.message = redact(outcome.message);
      report.actions = outcome.actions.map((a) => ({
        ...a,
        description: redact(a.description),
        ...(a.message !== undefined ? { message: redact(a.message) } : {}),
      }));
      report.modelCalls = outcome.modelCalls;
      report.costUsd = outcome.modelCalls.some((c) => c.costUsd === null)
        ? null
        : outcome.modelCalls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
      report.refusals = outcome.refusals.map(redact);
      if (outcome.model) model = outcome.model;
      steps.push(report);
      emit({ type: "step.finished", step: report });

      if (outcome.status === "recorded") {
        const entry: StepRecording = {
          key,
          textKey: step.textKey,
          route,
          text: step.text,
          kind: step.kind === "exact" ? "exact" : "action",
          commands: outcome.commands,
          source: step.kind === "exact" ? "exact" : "ai",
          recordedAt: now().toISOString(),
        };
        if (outcome.reasoning) entry.reasoning = redact(outcome.reasoning);
        recorded.set(step.textKey, entry);
      } else {
        stop = {
          reason: outcome.reason ?? "step_impossible",
          ...(report.message !== undefined ? { message: report.message } : {}),
        };
      }
    }

    if (options.hooks ?? true) {
      for (const hook of test.teardown) {
        const report = await runHook(session, hook, "teardown");
        hooks.push(report);
        emit({ type: "hook", hook: report });
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const recording = assemble(test, options, recorded, compiled, model, now);
  const calls = steps.flatMap((s) => s.modelCalls);
  const checkReports = steps.flatMap((s) => (s.check ? [s.check] : []));
  const report: AuthoringReport = {
    reportVersion: 1,
    runId,
    testId: test.id,
    testPath: options.meta.testPath,
    startedAt,
    finishedAt: now().toISOString(),
    environment: options.meta.environment,
    browser: session.browserName,
    device: options.meta.device,
    promptVersion: PROMPT_VERSION,
    outcome: !stop ? "recorded" : FAILURE_REASONS.has(stop.reason) ? "failed" : "stopped",
    ...(stop ? { stopReason: stop.reason } : {}),
    ...(stop?.message ? { message: redact(stop.message) } : {}),
    hooks,
    steps,
    totals: {
      aiCalls: calls.length,
      tokens: {
        input: calls.reduce((s, c) => s + c.tokens.input, 0),
        output: calls.reduce((s, c) => s + c.tokens.output, 0),
        cached: calls.reduce((s, c) => s + c.tokens.cached, 0),
        cacheWrite: calls.reduce((s, c) => s + c.tokens.cacheWrite, 0),
      },
      costUsd: calls.reduce((s, c) => s + (c.costUsd ?? 0), 0),
      unknownCostCalls: calls.filter((c) => c.costUsd === null).length,
      billing: billingOf(calls),
    },
    checks: {
      total: checkReports.length,
      rules: checkReports.filter((c) => c.generatedBy === "rules" && c.op.type !== "pending")
        .length,
      ai: checkReports.filter((c) => c.generatedBy === "ai").length,
      exact: checkReports.filter((c) => c.generatedBy === "exact").length,
      notCompiled: checkReports.filter((c) => c.op.type === "pending").length,
      failedAtAuthoring: checkReports.filter((c) => c.passed === false).length,
      provesNothing: checkReports.filter((c) => c.sanity?.provesNothing).length,
    },
    evidence: [],
  };
  return { recording, report, screenshots };
}

function billingOf(
  calls: readonly { billing?: "api" | "subscription" | undefined }[],
): AuthoringReport["totals"]["billing"] {
  if (calls.length === 0) return null;
  const subscription = calls.filter((c) => c.billing === "subscription").length;
  return subscription === 0 ? "api" : subscription === calls.length ? "subscription" : "mixed";
}

/** Steps in test order: this run's recording, else the previous one for the same key. */
function assemble(
  test: ExpandedTest,
  options: AuthorOptions,
  recorded: Map<string, StepRecording>,
  compiled: Map<string, CheckRecording>,
  model: string | null,
  now: () => Date,
): Recording {
  const previousSteps = new Map((options.previous?.steps ?? []).map((s) => [s.textKey, s]));
  const previousChecks = new Map((options.previous?.checks ?? []).map((c) => [c.textKey, c]));
  const steps: StepRecording[] = [];
  const checks: CheckRecording[] = [];
  const at = now().toISOString();
  for (const step of test.steps) {
    const fresh = recorded.get(step.textKey);
    if (fresh) steps.push(fresh);
    else if (step.kind === "action" || step.kind === "exact") {
      const old = previousSteps.get(step.textKey);
      if (old) steps.push(old);
    }
    const exact =
      step.kind === "exact" && step.exact?.form === "op"
        ? exactCheck(step.exact.op as ExactOp<BoundValue>)
        : undefined;
    if (step.kind === "expect" || step.kind === "soft" || exact) {
      const fresh = compiled.get(step.textKey);
      const old = previousChecks.get(step.textKey);
      // This run's check; else a compiled one from before survives; a pending one is rewritten.
      if (fresh) checks.push(fresh);
      else if (old && old.check.type !== "pending" && !exact && old.text === step.text)
        checks.push(old);
      else {
        checks.push({
          key: checkKey(step.textKey),
          textKey: step.textKey,
          text: step.text,
          soft: step.kind === "soft",
          check: exact ?? { type: "pending" },
          generatedBy: exact ? "exact" : "rules",
          summary: describeCheck(exact ?? { type: "pending" }),
          recordedAt: old?.check.type === "pending" && old.text === step.text ? old.recordedAt : at,
        });
      }
    }
  }
  return {
    recordingVersion: RECORDING_VERSION,
    testId: test.id,
    testPath: options.meta.testPath,
    target: options.meta.target,
    recordedWith: {
      engineVersion: options.meta.engineVersion,
      epoch: RECORDING_EPOCH,
      browser: options.session.browserName,
      device: options.meta.device,
      environment: options.meta.environment,
      model: model ?? options.previous?.recordedWith.model ?? null,
      promptVersion: model
        ? PROMPT_VERSION
        : (options.previous?.recordedWith.promptVersion ?? null),
    },
    updatedAt: at,
    steps,
    checks,
  };
}

export interface CheckOutcome {
  check: CheckReport & { op: CheckRecording["check"] };
  modelCalls: ModelCall[];
  model?: string;
}

/** Compiles (or, for exact ops, takes) the step's check, evaluates it once and sanity-tests it. */
export async function authorCheck(
  step: ExpandedStep,
  exact: CheckOp | undefined,
  ctx: Parameters<typeof compileCheck>[1],
): Promise<CheckOutcome> {
  let result: CompiledCheck | (Omit<CompiledCheck, "generatedBy"> & { generatedBy: "exact" });
  if (exact) {
    const verified = await verifyCheck(exact, ctx);
    const problem = verified.sanity.provesNothing
      ? "This check also passes where it shouldn't (see the sanity test), so it can't show that the step worked."
      : verified.evaluation.status === "refused" || verified.evaluation.status === "error"
        ? verified.evaluation.message
        : undefined;
    result = {
      op: exact,
      generatedBy: "exact",
      summary: describeCheck(exact),
      evaluation: verified.evaluation,
      sanity: verified.sanity,
      ...(problem ? { problem } : {}),
      records: verified.evaluation.record ? [verified.evaluation.record] : [],
    };
  } else {
    result = await compileCheck(
      { text: segmentsTemplate(step.bound), soft: step.kind === "soft" },
      ctx,
    );
  }
  const evaluation = result.evaluation;
  const ran = evaluation && (evaluation.status === "passed" || evaluation.status === "failed");
  const records: ModelCallRecord[] = [
    ...result.records,
    ...(evaluation?.record && !result.records.includes(evaluation.record)
      ? [evaluation.record]
      : []),
  ];
  return {
    check: {
      op: result.op,
      summary: result.summary,
      generatedBy: result.generatedBy,
      ...(result.rule ? { rule: result.rule } : {}),
      status: evaluation ? evaluation.status : "not_compiled",
      passed: ran ? evaluation.passed : null,
      expected: evaluation?.expected ?? null,
      actual: evaluation?.actual ?? null,
      sanity: result.sanity,
      ...(result.problem ? { problem: result.problem } : {}),
    },
    modelCalls: records.map(toModelCall),
    ...(result.model
      ? { model: result.model }
      : evaluation?.model
        ? { model: evaluation.model }
        : {}),
  };
}

/** Runs one setup/teardown hook through the harness (request hooks only for now). */
export async function runHook(
  session: AuthorOptions["session"],
  hook: ExpandedTest["setup"][number],
  phase: "setup" | "teardown",
): Promise<HookReport> {
  if (hook.type !== "request") {
    return {
      phase,
      kind: hook.type,
      description: hook.type === "run" ? `run ${hook.script}` : `sql ${hook.statement}`,
      status: "unsupported",
      message: `\`${hook.type}\` hooks are not supported yet; only \`request\` hooks run.`,
    };
  }
  const description = `${hook.method} ${hook.target}`;
  const result = await session.hookRequest({
    method: hook.method,
    target: hook.target,
    ...(hook.body !== undefined ? { body: hook.body } : {}),
    ...(hook.headers ? { headers: hook.headers } : {}),
  });
  const report: HookReport = { phase, kind: "request", description, status: result.status };
  if (result.httpStatus !== undefined) report.httpStatus = result.httpStatus;
  if (result.message !== undefined) report.message = result.message;
  return report;
}

/** Exact ops run straight through the harness, no model (AUT-3). */
export async function runExactOp(
  session: AuthorOptions["session"],
  step: ExpandedStep,
  op: ExactOp<BoundValue>,
  variables: StepVariables,
): Promise<ActionStepResult> {
  const result: ActionStepResult = {
    status: "failed",
    commands: [],
    actions: [],
    modelCalls: [],
    records: [],
    refusals: [],
  };
  let action: Action;
  let recorded: RecordedAction;
  const resolve = (value: BoundValue): string | { secret: string } => {
    const segments = value.segments;
    if (segments.length === 1 && segments[0]?.kind === "secret")
      return { secret: segments[0].name };
    return value.display;
  };
  switch (op.op) {
    case "goto":
      action = { type: "goto", url: String(resolve(op.url)) };
      recorded = { type: "goto", url: templateOf(op.url) };
      break;
    case "click":
      action = { type: "click", target: specLocator(op.target) as LocatorSpec };
      recorded = { type: "click", target: specLocator(op.target) };
      break;
    case "fill":
      action = {
        type: "fill",
        target: specLocator(op.target) as LocatorSpec,
        value: resolve(op.value),
      };
      recorded = { type: "fill", target: specLocator(op.target), value: templateOf(op.value) };
      break;
    case "select":
      action = {
        type: "select",
        target: specLocator(op.target) as LocatorSpec,
        option: String(resolve(op.option)),
      };
      recorded = { type: "select", target: specLocator(op.target), option: templateOf(op.option) };
      break;
    case "press":
      action = { type: "press", key: op.key };
      recorded = { type: "press", key: op.key };
      break;
    default:
      return { ...result, status: "recorded" };
  }
  const outcome = await session.act(action);
  result.actions.push({
    tool: `exact ${op.op}`,
    description: step.text,
    status: outcome.status,
    changed: outcome.post.changed,
    settledMs: outcome.settledMs,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
  });
  for (const refusal of outcome.post.refused)
    result.refusals.push(`${refusal.type} ${refusal.url}`);
  if (
    outcome.status === "refused" &&
    (outcome.reason === "disallowed_domain" || outcome.reason === "missing_secret")
  ) {
    return { ...result, status: "stopped", reason: outcome.reason, message: outcome.message ?? "" };
  }
  if (outcome.status !== "ok") {
    return {
      ...result,
      status: "failed",
      reason: "step_impossible",
      message: outcome.message ?? outcome.status,
    };
  }
  if (!outcome.post.changed && op.op !== "press") {
    return {
      ...result,
      status: "failed",
      reason: "no_visible_effect",
      message: "The action had no visible effect: the page didn't change after it.",
    };
  }
  const command: Command = commandOf(recorded, null, outcome, variables.pageList);
  return { ...result, status: "recorded", commands: [command] };
}
