import { setTimeout as sleep } from "node:timers/promises";
import { defaultRedactor } from "@optestra/config/node";
import {
  type CheckResult,
  type HealProposal,
  HealProposalSchema,
  type ModelCall,
  type StepResult,
} from "@optestra/contract";
import {
  classifyHeal,
  decideMiss,
  decideSameElement,
  healInput,
  type LiveCandidate,
  type MissActionInput,
  missContext,
  type ObservedRequest,
  type RankResult,
  rankCandidates,
  type SameElementAnswer,
  sameElementInputFor,
} from "@optestra/decide";
import { toModelCall } from "@optestra/models";
import {
  type CheckOp,
  type CheckRecording,
  type Command,
  checkKey,
  describeCheck,
  describeLocator,
  type Fingerprint,
  type Locator,
  routeOf,
  type StepRecording,
  stepKey,
} from "@optestra/recording";
import type { BoundText, ExactOp, ExpandedStep } from "@optestra/spec";
import { runActionStep } from "../author/agent.js";
import { authorCheck, exactCheck, runExactOp, runHook } from "../author/author.js";
import { applyMock, isMockOp, type MockOp, type MockSession } from "../mock/mock.js";
import type { AccessibilityViolation } from "@optestra/contract";
import type { Session } from "@optestra/browser";
import { parseGuard } from "../author/guards.js";
import { inboxMemberOfAction, prepareInbox } from "../author/inbox.js";
import { DEFAULT_LIMITS } from "../author/types.js";
import {
  inboxMemberOf,
  type StepVariables,
  stepVariables,
  withInbox,
} from "../author/variables.js";
import { evaluateCheck } from "../checks/evaluate.js";
import { isAbsence } from "../checks/sanity.js";
import { runFixer } from "../heal/fixer.js";
import { HEAL_PATCH_VERSION, type HealPatch, relocatedCommand } from "../heal/patch.js";
import type {
  ActionOutcome,
  CheckEvaluation,
  ElementFacts,
  Observation,
  PageCopy,
  RequestMark,
} from "../target/harness.js";
import { targetOfSession } from "../target/harness.js";
import { bindAction, retarget, targetOf } from "./bind.js";
import { checkResult, evaluationText, unusableCheck } from "./checks.js";
import { fixerProposal, healFacts, healProposal } from "./heal.js";
import { checkable, lateMatch, type PostCheck, verifyOutcome } from "./post-state.js";
import type { Chapter, ReplayOptions, ReplayResult } from "./types.js";
import type { AttemptBlock, AttemptFailure } from "./verdict.js";

// Replaying one attempt of a test (REP-3…REP-5): no AI on an unchanged app.
// Each recorded command is bound to this run's values, its element validated
// against the fingerprint before acting (a mismatch is a miss, never a silent
// success), acted on, and its recorded effect checked (VER-5). A miss goes up
// the DEC-3 healing ladder; the no-AI rungs (a stored fallback, a clear
// re-find) are done here and become pending heal proposals. Every check is
// evaluated fresh (LRN-2). Steps with no recording are authored in place
// (normal mode), and pending checks compiled in place.

const LATE_EFFECT_MS = 400;
const MAX_LEARNED_WAIT_MS = 3_000;
/** The least time replay looks for a command's recorded effect before settling as usual. */
const MIN_EFFECT_WAIT_MS = 1_000;
const MAX_REFIND_CANDIDATES = 40;

type Stop = { kind: "failed"; failure: AttemptFailure } | { kind: "blocked"; block: AttemptBlock };

type CommandResult =
  | {
      kind: "ok";
      used: "primary" | "fallback" | "refind" | "none";
      locator: Locator | null;
      post: PostCheck;
      outcome: ActionOutcome;
      heal?: HealProposal;
      patch?: HealPatch;
    }
  | {
      kind: "failed";
      error: string;
      post: PostCheck | null;
      notFound: boolean;
      needsAi?: boolean;
      /** miss_action said call_fixer: the step goes to the fixer model. */
      fixer?: { reason: string; miss: MissActionInput };
      outcome?: ActionOutcome;
    }
  | { kind: "blocked"; reason: string; message: string; outcome?: ActionOutcome };

const BLOCKING_REASONS = new Set([
  "disallowed_domain",
  "missing_secret",
  "inbox_unavailable",
  "ai_unavailable",
  "budget_exceeded",
  "captcha",
]);

function toObserved(outcome: ActionOutcome | undefined): ObservedRequest[] {
  return (outcome?.post.requests ?? []).map((r) => ({
    method: r.method,
    url: r.url,
    status: r.status,
    resourceType: r.resourceType,
  }));
}

/**
 * The step as the test file numbers it (StepResult `label`): "3", or "1 › Log
 * in step 4" for step 4 of the flow "Log in" used at step 1 (flows inside flows
 * add a part each). Headlines, the test list and reports all show `step <label>`.
 */
export function stepLabelOf(step: ExpandedStep): string {
  const own = String(step.origin.at(-1)?.number ?? step.number ?? step.index + 1);
  const uses = step.origin.slice(0, -1);
  if (step.flowPath.length === 0 || uses.length === 0) return own;
  const via = uses.map(
    (frame, i) => `${frame.number ?? "?"} › ${frame.flow ?? step.flowPath[i] ?? "flow"}`,
  );
  return `${via.join(" step ")} step ${own}`;
}

/** The line a person reads first (DIA-3): the step, numbered as in the test file. */
function where(step: ExpandedStep): string {
  return `Step ${stepLabelOf(step)}`;
}

const quoteText = (text: string | null) => (text === null ? "nothing" : JSON.stringify(text));

const EMAIL_READ =
  /\b(code|link)\b[^.]*\b(from|in)\s+the\s+([a-z-]+\s+)?(e-?mail|inbox|message)\b|\{\{\s*inbox\./i;

/**
 * The step reads a test inbox: an `{{inbox.…}}` value, or plain words like "the
 * code from the verification email". Without a configured inbox such a step
 * can't run (blocked `inbox_unavailable`, no AI spent).
 */
export function readsInbox(step: ExpandedStep): string | null {
  const ref = step.bound.find((s) => s.kind === "unresolved" && s.ref.startsWith("inbox."));
  if (ref && ref.kind === "unresolved") return `{{${ref.ref}}}`;
  return EMAIL_READ.test(step.text) ? "an email's code or link" : null;
}

export async function replayAttempt(options: ReplayOptions): Promise<ReplayResult> {
  const { test, session, attempt, mode } = options;
  const now = options.now ?? (() => new Date());
  const redact = options.redact ?? ((text: string) => defaultRedactor.redact(text));
  const decisions = options.decisions;
  const recording = mode === "rerecord" ? undefined : options.recording;
  const started = Date.now();
  const deadline = started + options.timeoutMs;
  const checkTimeoutMs = options.checkTimeoutMs ?? 5_000;

  const steps: StepResult[] = [];
  const checks: CheckResult[] = [];
  const heals: HealProposal[] = [];
  const modelCalls: ModelCall[] = [];
  const chapters: Chapter[] = [];
  const authoredSteps: StepRecording[] = [];
  const authoredChecks: CheckRecording[] = [];
  let authoredModel: string | null = null;
  let stop: Stop | undefined;
  let needsAi = 0;
  let healedWithoutAi = 0;
  let healedByFixer = 0;
  const patches: HealPatch[] = [];
  let lastOutcome: ActionOutcome | undefined;
  // Android (MOB-1): the app crashing or hanging is the app's fault, like an uncaught page error.
  const appProblems: string[] = [];
  let notFoundAtFailure = false;
  // Where the current action step began: network checks count from here.
  let stepMark: RequestMark | undefined;
  // The page before the latest action step: the sanity before-state for checks compiled now.
  let before: PageCopy | undefined;
  // The latest screenshot's path: the next action step's "before" (checks between them only read the page).
  let lastShot: { path: string | null } | undefined;
  // Screenshots of passing steps are taken in the background; all land before the attempt ends.
  const pendingShots: Promise<void>[] = [];
  // The page where the attempt stopped (for the failure classifier).
  let observationsAt: Awaited<ReturnType<typeof pageInfo>> | undefined;
  // Where a failed login stopped (it ran in its own session).
  let preparedObservations: ReplayResult["observations"] | undefined;

  const recordedSteps = new Map((recording?.steps ?? []).map((s) => [s.key, s]));
  const recordedByText = new Map((recording?.steps ?? []).map((s) => [s.textKey, s]));
  const recordedChecks = new Map((recording?.checks ?? []).map((c) => [c.textKey, c]));
  const needsCopies =
    mode !== "replay-only" &&
    test.steps.some((step) => {
      if (step.kind !== "expect" && step.kind !== "soft") return false;
      const check = recordedChecks.get(step.textKey);
      return mode === "rerecord" || !check || check.check.type === "pending";
    });
  const guardContext = {
    guards: test.guards.map((g) => parseGuard(g.display)),
    production: options.production,
    allowDestructive: test.allowDestructive,
  };

  const emitCall = (call: ModelCall) => {
    modelCalls.push(call);
    options.emit({ type: "model.called", call });
  };

  /**
   * A step screenshot (EVD-1): PNG where a step failed, else a JPEG taken in the
   * background (its path is known up front) so the next step doesn't wait for it.
   */
  const shoot = async (
    index: number,
    when: "before" | "after",
    failing = false,
  ): Promise<string | null> => {
    const save = options.saveScreenshot;
    if (options.screenshots === false || !save) return null;
    if (options.screenshots === "failures" && !failing) return null;
    // Nothing happened since the last screenshot: the page is the same, point to it.
    if (when === "before" && lastShot) return lastShot.path;
    const contentType = failing ? "image/png" : "image/jpeg";
    const format = failing ? "png" : "jpeg";
    if (!failing && options.screenshotPath) {
      const path = options.screenshotPath(index, when, contentType);
      pendingShots.push(
        session.screenshot({ format }).then(
          (shot) => {
            if (shot.status === "ok") save(index, when, shot.bytes, contentType);
          },
          () => {},
        ),
      );
      lastShot = { path };
      return path;
    }
    const shot = await session.screenshot({ format });
    if (shot.status !== "ok") return null;
    const path = save(index, when, shot.bytes, contentType);
    lastShot = { path };
    return path;
  };

  const pageInfo = async (outcome?: ActionOutcome) => {
    const requests = toObserved(outcome);
    let observation: Observation | undefined;
    try {
      observation = await session.observe();
    } catch {
      observation = undefined;
    }
    const heading =
      observation?.elements.find((e) => e.role === "heading" && e.states.level === 1)?.name ??
      observation?.elements.find((e) => e.role === "heading")?.name ??
      "";
    const text = (observation?.elements ?? [])
      .map((e) => e.text ?? e.name)
      .filter(Boolean)
      .join(" ")
      .slice(0, 2000);
    const documentStatus = [...requests]
      .reverse()
      .find((r) => r.resourceType === "document" && typeof r.status === "number")?.status;
    const page = {
      status: typeof documentStatus === "number" ? documentStatus : null,
      title: observation?.title ?? "",
      heading,
      text,
    };
    const decided = await decisions.decide("page_is_error", {
      status: page.status && page.status >= 100 && page.status <= 599 ? page.status : null,
      title: page.title.slice(0, 500),
      heading: page.heading.slice(0, 500),
      text: page.text.slice(0, 4000),
    });
    const isError =
      decided.status === "decided"
        ? Boolean((decided.answers as { is_error: boolean }).is_error)
        : null;
    return {
      page,
      isError,
      requests,
      appDown: requests.some((r) => r.resourceType === "document" && r.status === "failed"),
      serverErrors: requests.filter((r) => typeof r.status === "number" && r.status >= 500).length,
      networkFailures: requests.filter((r) => r.status === "failed").length,
      observation,
    };
  };

  const block = (reason: string, message: string, stepIndex: number | null): Stop => ({
    kind: "blocked",
    block: { reason, message: redact(message), stepIndex },
  });

  const push = (step: StepResult) => {
    steps.push(step);
    options.emit({ type: "step.finished", step });
  };

  const skipped = (step: ExpandedStep, key: string, kind: StepResult["kind"]): StepResult => ({
    index: step.index,
    label: stepLabelOf(step),
    key,
    text: step.text,
    kind,
    status: "skipped",
    recovery: "none",
    locator: null,
    postState: null,
    startedAt: now().toISOString(),
    durationMs: 0,
    settledMs: null,
    screenshots: { before: null, after: null },
    error: null,
    checkIds: [],
    modelCallIds: [],
    decisionIds: [],
    healIds: [],
  });

  // ── setup hooks and the start page ──────────────────────────────────────────
  for (const hook of test.setup) {
    const report = await runHook(session, hook, "setup", options.hookContext);
    if (report.status === "ok") continue;
    const message = `Setup ${report.description} ${report.status}${report.message ? `: ${report.message}` : ""}`;
    stop =
      report.reason === "missing_secret"
        ? block("missing_secret", message, null)
        : report.status === "unsupported" ||
            (report.status === "refused" && report.kind !== "request")
          ? block("config_error", message, null)
          : report.status === "refused"
            ? block("disallowed_domain", message, null)
            : report.status === "error"
              ? block("app_down", message, null)
              : block("setup_failed", message, null);
    break;
  }
  // The test's login (auth: <profile>, SEC-3): after the setup hooks, before the start page.
  // The auth login is not one of the test's own steps (an empty test still proves nothing).
  let loginStep: (typeof steps)[number] | undefined;
  if (!stop && options.prepare) {
    const prepared = await options.prepare();
    for (const call of prepared.modelCalls ?? []) emitCall(call);
    for (const heal of prepared.heals ?? []) {
      heals.push(heal);
      healedWithoutAi++;
      options.emit({ type: "heal.proposed", heal });
    }
    for (const line of prepared.logs ?? [])
      options.emit({ type: "log", level: "info", message: line });
    if (prepared.step) {
      loginStep = prepared.step;
      push(prepared.step);
    }
    if (prepared.observations && prepared.status !== "ready")
      preparedObservations = prepared.observations;
    if (prepared.status === "failed" && prepared.step)
      stop = {
        kind: "failed",
        failure: {
          decider: { kind: "step", attempt, stepIndex: prepared.step.index },
          headline: redact(prepared.message),
        },
      };
    else if (prepared.status === "blocked" || prepared.status === "failed")
      stop = block(
        prepared.reason ?? "login_failed",
        prepared.message,
        prepared.step?.index ?? null,
      );
  }
  // EVD-6: axe-core warnings, once per distinct page (route), never part of the verdict.
  const a11y = options.accessibility
    ? { pages: new Set<string>(), ms: 0, violations: new Map<string, AccessibilityViolation>() }
    : undefined;
  const scanPage = async () => {
    const scan = (session as { accessibility?: Session["accessibility"] }).accessibility;
    if (!a11y || !scan || stop?.kind === "blocked") return;
    const page = routeOf(session.url);
    if (a11y.pages.has(page)) return;
    a11y.pages.add(page);
    const result = await scan.call(session);
    a11y.ms += result.ms;
    for (const v of result.violations) {
      const key = `${page}\u0000${v.rule}`;
      const seen = a11y.violations.get(key);
      if (seen) seen.nodes = Math.max(seen.nodes, v.nodes);
      else a11y.violations.set(key, { ...v, page });
    }
  };

  if (!stop && test.start) {
    const url = test.start.display;
    // The start page's effect is the page loading: its document answered.
    const outcome = await session.act(
      { type: "goto", url },
      {
        until: (post) =>
          post.requests.some((r) => r.resourceType === "document" && typeof r.status === "number"),
        ceilingMs: MIN_EFFECT_WAIT_MS,
      },
    );
    lastOutcome = outcome;
    if (outcome.status === "refused")
      stop = block(outcome.reason ?? "disallowed_domain", outcome.message ?? url, null);
    else if (outcome.status !== "ok")
      stop = block("app_down", `Could not open ${url}: ${outcome.message ?? outcome.status}`, null);
    if (!stop) await scanPage();
  }

  // ── one recorded command ────────────────────────────────────────────────────
  const act = async (
    action: Parameters<typeof session.act>[0],
    actOptions?: Parameters<typeof session.act>[1],
  ) => {
    const outcome = await session.act(action, actOptions);
    lastOutcome = outcome;
    const crashed = outcome.problem === "app_crashed" || outcome.post?.app === "crashed";
    const hung = outcome.problem === "app_not_responding" || outcome.post?.app === "not_responding";
    if (crashed || hung)
      appProblems.push(
        crashed
          ? `FATAL EXCEPTION: the app crashed during ${outcome.action.type}`
          : `ANR: the app stopped responding during ${outcome.action.type}`,
      );
    return outcome;
  };

  /**
   * LRN-4: act, then move on the moment the command's recorded effect shows
   * (the learned time, doubled, is how long to look before settling as usual).
   * A command that recorded no effect settles with the generic quiet window.
   */
  const learnedWait = (
    command: Command,
    variables: StepVariables,
    renamedTo?: string,
  ): Parameters<typeof session.act>[1] => {
    if (!checkable(command.expectPost)) return undefined;
    const self = selfOf(command, renamedTo);
    // Writes the command made when recorded (a save, a login) must have been sent before
    // moving on: one can start a moment after the page already changed ("Saving…"), and
    // the next step could cut it off. Reads (the page loading its data) need no wait:
    // the next step's element check and every Expect wait for what they need.
    const writes = (command.expectPost.requests ?? []).filter(
      (r) => r.method !== "GET" && r.method !== "HEAD" && r.method !== "OPTIONS",
    );
    return {
      until: (post) =>
        verifyOutcome(command.expectPost, { post } as ActionOutcome, variables.pageList, self)
          .status === "verified" &&
        writes.every((r) =>
          post.requests.some((seen) => seen.method === r.method && routeOf(seen.url) === r.route),
        ),
      ceilingMs: Math.min(
        MAX_LEARNED_WAIT_MS,
        Math.max(MIN_EFFECT_WAIT_MS, 2 * command.wait.settledMs),
      ),
    };
  };

  /** An AbortController that also fires when the run is stopped (reported like the time limit). */
  const stoppable = () => {
    const controller = new AbortController();
    options.signal?.addEventListener("abort", () => controller.abort(new Error("timeout")), {
      once: true,
    });
    return controller;
  };

  /** The page as it would be after a full settle, for what needs it (authoring, copies, some checks). */
  const settlePage = async () => {
    if (session.unsettled) await session.settle();
  };

  /** VER-5 with a second look: the recorded effect now, or after the learned wait. */
  const verify = async (
    command: Command,
    outcome: ActionOutcome,
    variables: StepVariables,
    renamedTo?: string,
  ) => {
    const self = selfOf(command, renamedTo);
    const post = verifyOutcome(command.expectPost, outcome, variables.pageList, self);
    if (post.status !== "mismatch") return post;
    // LRN-4: wait as long as the page took when recorded (at least a moment), then look again.
    const wait = Math.min(
      MAX_LEARNED_WAIT_MS,
      Math.max(LATE_EFFECT_MS, command.wait.settledMs - outcome.settledMs),
    );
    await sleep(wait);
    const observation = await session.observe();
    const late = lateMatch(command.expectPost, session.url, observation, variables.pageList);
    if (late) return { ...post, status: "verified" as const, observed: late };
    for (const request of command.expectPost.requests ?? []) {
      const seen = await session.check(
        { type: "network", method: request.method, url: request.route },
        { timeoutMs: 0, ...(stepMark ? { since: stepMark } : {}) },
      );
      if (seen.passed)
        return {
          ...post,
          status: "verified" as const,
          observed: `requests: ${request.method} ${request.route} a moment later`,
        };
    }
    return post;
  };

  const sameAs = (
    fingerprint: Fingerprint,
    facts: ElementFacts,
    foundBy: LiveCandidate["foundBy"],
  ) => decideSameElement(fingerprint, { facts, foundBy, matches: 1 }, { decisions });

  /** Live elements to re-find the recorded one among (same role, or anything interactive). */
  const liveCandidates = async (fingerprint: Fingerprint) => {
    const observation = await session.observe();
    const refs = observation.elements.filter(
      (e) =>
        e.ref && (e.role === fingerprint.role || (e.interactive && fingerprint.role === "generic")),
    );
    const found: { ref: string; candidate: LiveCandidate }[] = [];
    for (const element of refs.slice(0, MAX_REFIND_CANDIDATES)) {
      const facts = await session.factsOf(element.ref as string);
      if (facts)
        found.push({
          ref: element.ref as string,
          candidate: { facts, foundBy: "refind", matches: 1 },
        });
    }
    return found;
  };

  const replayCommand = async (
    step: ExpandedStep,
    key: string,
    command: Command,
    commandIndex: number,
    stepVariables: StepVariables,
  ): Promise<CommandResult> => {
    // A recorded {{inbox.code}} / {{inbox.link}} (AUTH-1): typed by the harness from the email.
    const recordedMember =
      command.action.type === "fill"
        ? inboxMemberOf(command.action.value)
        : command.action.type === "goto"
          ? inboxMemberOf(command.action.url)
          : null;
    const variables = recordedMember ? withInbox(stepVariables, recordedMember) : stepVariables;
    const bound = bindAction(command.action, variables);
    if (!bound.ok) {
      if (bound.reason === "unresolved")
        return {
          kind: "blocked",
          reason: "config_error",
          message: `${bound.message} Set it for this environment.`,
        };
      return { kind: "failed", error: bound.message, post: null, notFound: false };
    }
    const member = inboxMemberOfAction(bound.action);
    if (member) {
      const read = await prepareInbox(options.inbox, test, step, member, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!read.ok)
        return read.outcome === "blocked"
          ? { kind: "blocked", reason: read.reason, message: read.message }
          : { kind: "failed", error: read.message, post: null, notFound: false };
    }
    const target = targetOf(command.action);
    const fingerprint = command.fingerprint;
    let missReason:
      | "not_found"
      | "multiple_matches"
      | "fingerprint_mismatch"
      | "post_state_mismatch"
      | null = null;
    let primarySame: SameElementAnswer | undefined;

    const validate = async (): Promise<typeof missReason> => {
      const inspected = await session.inspect(target as never);
      if (inspected.status === "ok" && inspected.facts && fingerprint) {
        primarySame = await sameAs(fingerprint, inspected.facts, "primary");
        return primarySame.same !== true ? "fingerprint_mismatch" : null;
      }
      if (inspected.status === "multiple") return "multiple_matches";
      return inspected.status !== "ok" ? "not_found" : null;
    };
    if (target) {
      missReason = await validate();
      // The previous command moved on at its effect: let the page finish before calling this a miss.
      if (missReason && session.unsettled) {
        await session.settle();
        missReason = await validate();
      }
    }

    let outcome: ActionOutcome | undefined;
    if (!missReason) {
      outcome = await act(bound.action, learnedWait(command, variables));
      if (outcome.status === "refused") {
        const reason = outcome.reason ?? "invalid_action";
        if (BLOCKING_REASONS.has(reason))
          return { kind: "blocked", reason, message: outcome.message ?? reason, outcome };
        return {
          kind: "failed",
          error: outcome.message ?? reason,
          post: null,
          notFound: false,
          outcome,
        };
      }
      if (outcome.status !== "ok") {
        if (target) missReason = "not_found";
        else {
          const info = await pageInfo(outcome);
          if (info.appDown || /net::err_|ECONNREFUSED/i.test(outcome.message ?? ""))
            return {
              kind: "blocked",
              reason: "app_down",
              message: outcome.message ?? "The app didn't answer.",
              outcome,
            };
          return {
            kind: "failed",
            error: outcome.message ?? outcome.status,
            post: null,
            notFound: false,
            outcome,
          };
        }
      } else {
        const post = await verify(command, outcome, variables);
        if (post.status !== "mismatch")
          return {
            kind: "ok",
            used: target ? "primary" : "none",
            locator: target ?? null,
            post,
            outcome,
          };
        missReason = "post_state_mismatch";
        // The element was validated before acting: the right one did nothing.
        const info = await pageInfo(outcome);
        const context = missContext({
          missReason,
          refusal: null,
          usedElement: target ? "same" : "unknown",
          fallbacks: { total: fingerprint?.fallbacks.length ?? 0, matched: 0 },
          rank: null,
          page: {
            isError: info.isError,
            appDown: info.appDown,
            serverErrors: info.serverErrors,
            networkFailures: info.networkFailures,
          },
          policy: options.policy,
          budgetLeftUsd: budgetLeft(),
          fixerAvailable: mode !== "replay-only" && options.fixerAvailable,
        });
        const miss = await decideMiss(context, { decisions });
        if (miss.action === "block" && blocks(miss.blockedReason, info.appDown))
          return {
            kind: "blocked",
            reason: miss.blockedReason ?? "app_down",
            message: "The app didn't answer.",
            outcome,
          };
        const unhealthy = info.isError || info.serverErrors > 0;
        return {
          kind: "failed",
          error: unhealthy
            ? `The page is an error page after the action (${info.page.heading || info.page.title || "error"}); expected: ${post.expected}.`
            : `The right element was used, but nothing happened: expected ${post.expected}; saw ${post.observed}.`,
          post,
          notFound: false,
          outcome,
        };
      }
    }

    // ── a miss before acting: the DEC-3 ladder ─────────────────────────────────
    const reason = missReason as Exclude<typeof missReason, null | "post_state_mismatch">;
    // HEAL-5: `strict` never heals (fail on a miss); replay-only never heals (REP-6).
    const noAiHeals = mode !== "replay-only" && options.policy !== "strict";
    let fallback: { locator: Locator; answer: SameElementAnswer; facts: ElementFacts } | undefined;
    let matched = 0;
    if (fingerprint && noAiHeals) {
      for (const locator of fingerprint.fallbacks) {
        const inspected = await session.inspect(locator as never);
        if (inspected.status !== "ok" || !inspected.facts) continue;
        matched++;
        const answer = await sameAs(fingerprint, inspected.facts, "fallback");
        if (answer.same === true) {
          fallback = { locator, answer, facts: inspected.facts };
          break;
        }
      }
    }
    let rank: RankResult | null = null;
    let refs: { ref: string; candidate: LiveCandidate }[] = [];
    if (fingerprint && noAiHeals && !fallback) {
      refs = await liveCandidates(fingerprint);
      rank = await rankCandidates(
        fingerprint,
        refs.map((r) => r.candidate),
        { decisions },
      );
    }
    const info = await pageInfo(outcome);
    const missInput = missContext({
      missReason: reason,
      refusal: null,
      usedElement: null,
      fallbacks: {
        total: fingerprint?.fallbacks.length ?? 0,
        matched,
        best: fallback?.answer ?? null,
      },
      rank,
      page: {
        isError: info.isError,
        appDown: info.appDown,
        serverErrors: info.serverErrors,
        networkFailures: info.networkFailures,
      },
      policy: mode === "replay-only" ? "strict" : options.policy,
      budgetLeftUsd: budgetLeft(),
      fixerAvailable: mode !== "replay-only" && options.fixerAvailable,
    });
    const miss = await decideMiss(missInput, { decisions });
    const what = target ? describeLocator(target) : "the element";
    const notFoundText =
      reason === "fingerprint_mismatch"
        ? `${what} now finds a different element than the recorded one (fingerprint mismatch)`
        : reason === "multiple_matches"
          ? `${what} matches several elements`
          : `Element not found: ${what}`;

    const healWith = async (
      locator: Locator,
      answer: SameElementAnswer,
      facts: ElementFacts,
      how: "fallback" | "refind",
    ): Promise<CommandResult> => {
      const healed = await act(
        retarget(bound.action, locator),
        learnedWait(command, variables, facts.name),
      );
      if (healed.status === "refused") {
        const r = healed.reason ?? "invalid_action";
        return BLOCKING_REASONS.has(r)
          ? { kind: "blocked", reason: r, message: healed.message ?? r, outcome: healed }
          : {
              kind: "failed",
              error: healed.message ?? r,
              post: null,
              notFound: false,
              outcome: healed,
            };
      }
      if (healed.status !== "ok")
        return {
          kind: "failed",
          error: `${notFoundText}; the healed locator failed too: ${healed.message ?? healed.status}`,
          post: null,
          notFound: true,
          outcome: healed,
        };
      const post = await verify(command, healed, variables, facts.name);
      if (post.status === "mismatch")
        return {
          kind: "failed",
          error: `Healed to ${describeLocator(locator)}, but nothing happened: expected ${post.expected}; saw ${post.observed}.`,
          post,
          notFound: false,
          outcome: healed,
        };
      const proposal = healProposal({
        id: options.newId(),
        stepIndex: step.index,
        stepKey: key,
        command: commandIndex,
        before: target as Locator,
        after: locator,
        how,
        answer,
        policy: options.policy,
      });
      const classFacts = {
        before: {
          ...healFacts(fingerprint as Fingerprint),
          locator: describeLocator(target as Locator),
        },
        after: { ...healFacts(facts), locator: describeLocator(locator) },
        attempt,
      };
      const cls = await classifyHeal(proposal, { decisions, ...classFacts });
      proposal.classification = cls.classification;
      const patch: HealPatch = {
        patchVersion: HEAL_PATCH_VERSION,
        healId: proposal.id,
        testId: test.id,
        testPath: options.testPath ?? test.id,
        attempt,
        stepIndex: step.index,
        stepKey: key,
        textKey: step.textKey,
        level: how,
        from: commandIndex,
        before: [command],
        after: [relocatedCommand(command, locator, facts)],
        labels: {
          sameElement: sameElementInputFor(fingerprint as Fingerprint, {
            facts,
            foundBy: how,
            matches: 1,
          }),
          missAction: missInput,
          action: how === "fallback" ? "replay_fallback" : "refind",
          healClass: healInput(proposal, classFacts),
        },
      };
      return { kind: "ok", used: how, locator, post, outcome: healed, heal: proposal, patch };
    };

    switch (miss.action) {
      case "replay_fallback":
        if (fallback)
          return healWith(fallback.locator, fallback.answer, fallback.facts, "fallback");
        break;
      case "refind": {
        const best = rank?.best;
        const entry = best ? refs[best.index] : undefined;
        if (best && entry) {
          const found = await session.candidates(entry.ref);
          const unique = found.candidates.find((c) => c.unique);
          if (unique)
            return healWith(
              unique.locator as Locator,
              best,
              best.candidate.facts as ElementFacts,
              "refind",
            );
        }
        break;
      }
      case "block":
        if (blocks(miss.blockedReason, info.appDown))
          return {
            kind: "blocked",
            reason: miss.blockedReason ?? "app_down",
            message:
              miss.blockedReason === "ai_unavailable"
                ? `${notFoundText}, and no AI model is available to heal it.`
                : miss.blockedReason === "budget_exceeded"
                  ? `${notFoundText}, and the run's AI budget is used up.`
                  : `${notFoundText}: the app didn't answer.`,
          };
        return {
          kind: "failed",
          error: `${notFoundText}; the page is an error page (${info.page.heading || info.page.title || "error"}).`,
          post: null,
          notFound: true,
        };
      case "call_fixer":
        return {
          kind: "failed",
          error: `${notFoundText}: needs an AI heal (no heal without AI was possible).`,
          post: null,
          notFound: true,
          needsAi: true,
          fixer: { reason: notFoundText, miss: missInput },
        };
      default:
        break;
    }
    return {
      kind: "failed",
      error:
        mode === "replay-only"
          ? `${notFoundText} (replay-only: no heals).`
          : options.policy === "strict"
            ? `${notFoundText} (heal policy strict: no heals).`
            : `${notFoundText}; no heal without AI is safe here.`,
      post: null,
      notFound: true,
      ...(miss.action === null ? { needsAi: true } : {}),
    };
  };

  /**
   * HEAL-1 level 2: the fixer model redoes the missed step from the missed
   * command on. Its actions must show the step's recorded effect (VER-5), and
   * the heal is a proposal like any other; later checks still decide.
   */
  const fixStep = async (
    step: ExpandedStep,
    key: string,
    recorded: StepRecording,
    from: number,
    variables: StepVariables,
    missed: { reason: string; miss: MissActionInput },
  ): Promise<
    | {
        kind: "ok";
        heal: HealProposal;
        patch: HealPatch;
        post: PostCheck;
        settled: number;
        calls: ModelCall[];
        locator: Locator | null;
      }
    | { kind: "failed"; error: string; post: PostCheck | null; calls: ModelCall[] }
    | { kind: "blocked"; reason: string; message: string; calls: ModelCall[] }
  > => {
    const models = options.models as NonNullable<typeof options.models>;
    await settlePage();
    const controller = stoppable();
    const timer = setTimeout(
      () => controller.abort(new Error("timeout")),
      Math.max(1, deadline - Date.now()),
    );
    const replaced = recorded.commands.slice(from);
    const recordedEffect = mergedEffect(replaced);
    const missedElement = replaced[0]?.fingerprint;
    const fixed = await runFixer(
      {
        session,
        models,
        budget: options.budget,
        guards: guardContext,
        guardLines: test.guards.map((g) => g.display),
        signal: controller.signal,
        tags: { test: test.id },
        target: targetOfSession(session),
        // Done once the step's recorded effect shows (a toast may be gone after another model call).
        doneWhen: (outcome) =>
          verifyOutcome(
            recordedEffect,
            outcome,
            variables.pageList,
            missedElement ? { role: missedElement.role, name: missedElement.name } : undefined,
          ).status === "verified",
      },
      step,
      variables,
      { recorded, command: from, reason: missed.reason },
    ).finally(() => clearTimeout(timer));
    const calls = fixed.modelCalls;
    for (const call of calls) emitCall(call);
    if (fixed.status !== "recorded") {
      const reason = fixed.reason ?? "step_impossible";
      const message = redact(fixed.message ?? reason);
      if (BLOCKING_REASONS.has(reason) || reason === "timeout")
        return {
          kind: "blocked",
          reason: reason === "timeout" ? "aborted" : reason,
          message: `${missed.reason}, and the AI heal couldn't run: ${message}`,
          calls,
        };
      return {
        kind: "failed",
        error: `${missed.reason}; the fixer model couldn't redo the step (${reason}): ${message}`,
        post: null,
        calls,
      };
    }
    const before = recorded.commands.slice(from);
    const after = fixed.commands;
    // Guarantee 4: the step's recorded effect must show up after the fix.
    const missedFp = before[0]?.fingerprint ?? null;
    const firstNew = after.find((c) => c.fingerprint);
    const expected = mergedEffect(before);
    const seen = mergedEffect(after);
    let post = verifyOutcome(
      expected,
      {
        post: {
          urlBefore: session.url,
          urlAfter: seen.urlChange ?? session.url,
          added: seen.appeared ?? [],
          removed: seen.removed ?? [],
          requests: (seen.requests ?? []).map((r) => ({
            method: r.method,
            url: r.route,
            status: r.status ?? 200,
            resourceType: "fetch",
          })),
          reordered: seen.reordered ?? false,
          changed: true,
        },
      } as unknown as ActionOutcome,
      variables.pageList,
      missedFp
        ? {
            role: missedFp.role,
            name: missedFp.name,
            ...(firstNew?.fingerprint ? { renamedTo: firstNew.fingerprint.name } : {}),
          }
        : undefined,
    );
    if (post.status === "mismatch") {
      const late = lateMatch(expected, session.url, await session.observe(), variables.pageList);
      if (late) post = { ...post, status: "verified", observed: late };
    }
    if (post.status === "mismatch")
      return {
        kind: "failed",
        error: `${missed.reason}; the fixer model redid the step, but its recorded effect didn't show: expected ${post.expected}; saw ${post.observed}.`,
        post,
        calls,
      };
    const answer =
      missedFp && firstNew?.fingerprint
        ? await sameAs(missedFp, factsOfFingerprint(firstNew.fingerprint), "refind")
        : null;
    const proposal = fixerProposal({
      id: options.newId(),
      stepIndex: step.index,
      stepKey: key,
      from,
      before,
      after,
      answer,
      policy: options.policy,
    });
    const newTarget = (firstNew?.action as { target?: Locator } | undefined)?.target;
    const oldTarget = (before[0]?.action as { target?: Locator } | undefined)?.target;
    const classFacts = {
      ...(missedFp
        ? {
            before: {
              ...healFacts(missedFp),
              locator: oldTarget ? describeLocator(oldTarget) : "",
            },
          }
        : {}),
      ...(firstNew?.fingerprint
        ? {
            after: {
              ...healFacts(firstNew.fingerprint),
              locator: newTarget ? describeLocator(newTarget) : "",
            },
          }
        : {}),
      attempt,
    };
    const cls = await classifyHeal(proposal, { decisions, ...classFacts });
    proposal.classification = cls.classification;
    // Guarantee 1 (HEAL-3): a heal that isn't only a locator/action/wait change is refused.
    if (!HealProposalSchema.safeParse(proposal).success)
      return {
        kind: "failed",
        error: `${missed.reason}; the AI heal was refused: a heal may change only how a step is done (locator, action, wait), never what is expected.`,
        post: null,
        calls,
      };
    const patch: HealPatch = {
      patchVersion: HEAL_PATCH_VERSION,
      healId: proposal.id,
      testId: test.id,
      testPath: options.testPath ?? test.id,
      attempt,
      stepIndex: step.index,
      stepKey: key,
      textKey: step.textKey,
      level: "fixer",
      from,
      before,
      after,
      labels: {
        ...(missedFp && firstNew?.fingerprint
          ? {
              sameElement: sameElementInputFor(missedFp, {
                facts: factsOfFingerprint(firstNew.fingerprint),
                foundBy: "refind",
                matches: 1,
              }),
            }
          : {}),
        missAction: missed.miss,
        action: "call_fixer",
        healClass: healInput(proposal, classFacts),
      },
    };
    return {
      kind: "ok",
      heal: proposal,
      patch,
      post,
      settled: after.reduce((sum, c) => sum + c.wait.settledMs, 0),
      calls,
      locator: newTarget ?? null,
    };
  };

  function budgetLeft(): number | null {
    const budget = options.budget;
    if (!budget || budget.capUsd === null) return null;
    return Math.max(0, budget.capUsd - budget.spentUsd);
  }

  // ── the steps ───────────────────────────────────────────────────────────────
  for (const step of test.steps) {
    const exactOp =
      step.kind === "exact" && step.exact?.form === "op"
        ? exactCheck(step.exact.op as ExactOp<BoundText>)
        : undefined;
    const isCheck = step.kind === "expect" || step.kind === "soft" || exactOp !== undefined;
    const kind: StepResult["kind"] =
      step.kind === "soft"
        ? "soft"
        : step.kind === "expect"
          ? "expect"
          : step.kind === "exact"
            ? "exact"
            : "action";
    const route = routeOf(session.url);
    const key = isCheck ? checkKey(step.textKey) : stepKey(step.textKey, route);
    if (stop) {
      push(skipped(step, key, kind));
      continue;
    }
    if (options.signal?.aborted) {
      // The run was stopped (runTests({ signal })): nothing more runs, nothing is judged.
      push(skipped(step, key, kind));
      stop = block("aborted", "The run was stopped before this test finished.", step.index);
      continue;
    }
    if (Date.now() > deadline) {
      const failure: AttemptFailure = {
        decider: { kind: "step", attempt, stepIndex: step.index },
        headline: `${where(step)} "${step.text}": the test's time limit (${Math.round(options.timeoutMs / 1000)}s) was reached.`,
      };
      push({
        ...skipped(step, key, kind),
        status: "failed",
        error: "The test's time limit was reached (timed out).",
      });
      stop = { kind: "failed", failure };
      continue;
    }
    const startedAt = now().toISOString();
    const t0 = Date.now();
    options.emit({ type: "step.started", index: step.index, key, text: step.text, kind });
    const decisionIds: string[] = [];

    // ── Expect / Soft / exact expect: a check (VER-1…VER-3) ─────────────────
    if (isCheck) {
      const soft = step.kind === "soft";
      const variables = stepVariables(test, step);
      let stored = exactOp ? undefined : recordedChecks.get(step.textKey);
      if (stored && stored.text !== step.text) stored = undefined;
      let op: CheckOp;
      let summary: string;
      let evaluation: (CheckEvaluation & { warnOnly?: true }) | undefined;
      let problem: string | null = null;
      const mayCompile = mode !== "replay-only";
      if (exactOp) {
        op = exactOp;
        summary = describeCheck(op);
      } else if (stored && stored.check.type !== "pending") {
        op = stored.check;
        summary = stored.summary ?? describeCheck(op);
        problem = unusableCheck(stored);
      } else if (mayCompile) {
        // Compile the line in place (LOOP-2): rules first, AI only for what rules can't map.
        await settlePage();
        const compiled = await authorCheck(step, undefined, {
          session,
          models: options.plannerAvailable ? options.models : undefined,
          budget: options.budget,
          tags: { test: test.id, step: String(step.number ?? step.index + 1) },
          values: variables.values,
          before,
          timeoutMs: checkTimeoutMs,
        });
        for (const call of compiled.modelCalls) emitCall(call);
        if (compiled.model) authoredModel = compiled.model;
        op = compiled.check.op;
        summary = compiled.check.summary;
        const record: CheckRecording = {
          key: checkKey(step.textKey),
          textKey: step.textKey,
          text: step.text,
          soft,
          check: op,
          generatedBy: compiled.check.generatedBy,
          summary,
          ...(compiled.check.rule ? { rule: compiled.check.rule } : {}),
          ...(compiled.check.sanity ? { sanity: compiled.check.sanity } : {}),
          ...(compiled.check.passed === false
            ? {
                failedAtAuthoring: {
                  expected: compiled.check.expected,
                  actual: compiled.check.actual === null ? null : redact(compiled.check.actual),
                },
              }
            : {}),
          ...(compiled.check.problem ? { problem: redact(compiled.check.problem) } : {}),
          recordedAt: now().toISOString(),
        };
        authoredChecks.push(record);
        problem = unusableCheck(record);
        if (
          !problem &&
          (compiled.check.status === "passed" || compiled.check.status === "failed")
        ) {
          // The compile's own evaluation ran on this page, in this run: it is this run's result.
          evaluation = {
            status: compiled.check.status,
            passed: compiled.check.passed === true,
            expected: compiled.check.expected,
            actual: compiled.check.actual,
            ms: 0,
            attempts: 1,
            seen: "",
          };
        }
      } else {
        op = { type: "pending" };
        summary = describeCheck(op);
        problem = `"${step.text}" has no check yet: replay-only runs never compile one, so it can't prove anything. Run once without --replay-only.`;
      }

      if (!problem && !evaluation) {
        // A check that could hold on the page before the action (or a check that
        // isn't known to fail there) waits for a settled page: an early move-on
        // must never let it pass on a page that hasn't caught up yet.
        if (!discriminates(op, stored)) await settlePage();
        evaluation = await evaluateCheck(session, op, {
          values: variables.values,
          timeoutMs: checkTimeoutMs,
          since: stepMark,
          models: options.plannerAvailable && mode !== "replay-only" ? options.models : undefined,
          budget: options.budget,
          tags: { test: test.id, purpose: "soft-judgment" },
        });
        const record = (evaluation as { record?: Parameters<typeof toModelCall>[0] }).record;
        if (record) emitCall(toModelCall(record));
      }
      const passed = !problem && evaluation?.status === "passed" && evaluation.passed;
      const text = evaluation ? evaluationText(evaluation) : { expected: summary, actual: problem };
      const id = options.newId();
      const result = checkResult({
        id,
        stepIndex: step.index,
        expectation: step.text,
        op,
        soft,
        passed: Boolean(passed),
        expected: text.expected,
        actual: problem ?? (text.actual === null ? null : redact(text.actual)),
        summary,
      });
      checks.push(result);
      options.emit({ type: "check.evaluated", check: result });
      const status: StepResult["status"] = passed ? "passed" : soft ? "warned" : "failed";
      // A failed check shows the page it failed on (EVD-1: the failure's screenshot).
      const failedShot = status === "failed" ? await shoot(step.index, "after", true) : null;
      push({
        index: step.index,
        label: stepLabelOf(step),
        key,
        text: step.text,
        kind,
        status,
        recovery: "none",
        locator: null,
        postState: null,
        startedAt,
        durationMs: Date.now() - t0,
        settledMs: null,
        screenshots: { before: null, after: failedShot },
        error: passed
          ? null
          : (problem ??
            `expected ${quoteText(result.expected)}, found ${quoteText(result.actual)}`),
        checkIds: [id],
        modelCallIds: [],
        decisionIds,
        healIds: [],
      });
      chapters.push({
        index: step.index,
        title: step.text,
        startMs: t0 - started,
        endMs: Date.now() - started,
      });
      if (!passed && !soft) {
        stop = {
          kind: "failed",
          failure: {
            decider: { kind: "check", attempt, checkId: id },
            headline: problem
              ? `${where(step)} "${step.text}": ${problem}`
              : `${where(step)} "${step.text}": expected ${quoteText(result.expected)}, found ${quoteText(result.actual)}.`,
          },
        };
        const info = await pageInfo(lastOutcome);
        observationsAt = info;
      }
      if (!passed && soft)
        options.emit({
          type: "log",
          level: "warn",
          message: `Soft check failed (warning only): ${step.text}`,
        });
      continue;
    }

    // ── a Mock: step (ENV-4): the app's matching requests get its response from here on ──
    if (
      step.kind === "exact" &&
      step.exact?.form === "op" &&
      isMockOp(step.exact.op as ExactOp<BoundText>)
    ) {
      const t0 = Date.now();
      const applied = applyMock(session as MockSession, step.exact.op as MockOp, {
        projectDir: options.projectDir ?? options.hookContext?.projectDir ?? process.cwd(),
        testPath: options.testPath ?? test.path,
        stepIndex: step.index,
      });
      push({
        ...skipped(step, key, kind),
        status: applied.ok ? "passed" : "blocked",
        durationMs: Date.now() - t0,
        error: applied.ok ? null : applied.message,
      });
      if (!applied.ok)
        stop = block("config_error", `${where(step)}: ${applied.message}`, step.index);
      continue;
    }

    // ── an action step ──────────────────────────────────────────────────────
    stepMark = session.requestMark();
    if (needsCopies) {
      await settlePage();
      before = await session.pageCopy();
    }
    const beforeShot = await shoot(step.index, "before");
    const variables = stepVariables(test, step);
    const inbox = readsInbox(step);
    const recorded = recording ? recordedSteps.get(key) : undefined;
    const base = {
      index: step.index,
      label: stepLabelOf(step),
      key,
      text: step.text,
      kind,
      startedAt,
      screenshots: { before: beforeShot, after: null as string | null },
      decisionIds,
      healIds: [] as string[],
      modelCallIds: [] as string[],
      checkIds: [] as string[],
    };
    let result: StepResult;

    if (step.kind === "exact" && step.exact?.form === "code") {
      result = {
        ...base,
        status: "failed",
        recovery: "none",
        locator: null,
        postState: null,
        durationMs: Date.now() - t0,
        settledMs: null,
        error: "A code step runs from the generated Playwright spec, not through the harness.",
      };
      stop = {
        kind: "failed",
        failure: {
          decider: { kind: "step", attempt, stepIndex: step.index },
          headline: `${where(step)}: ${result.error}`,
        },
      };
    } else if (!recorded && inbox && !options.inbox) {
      result = {
        ...base,
        status: "blocked",
        recovery: "none",
        locator: null,
        postState: null,
        durationMs: Date.now() - t0,
        settledMs: null,
        error: `This step reads ${inbox} from a test inbox, and no inbox is configured.`,
      };
      stop = block(
        "inbox_unavailable",
        `${where(step)} "${step.text}" reads ${inbox} from a test inbox, but no inbox is configured (inbox.provider: none).`,
        step.index,
      );
    } else if (!recorded) {
      // REP-4: a new or edited step (or --rerecord). Author just this step.
      const moved = recordedByText.get(step.textKey);
      const why =
        moved && moved.route !== route ? ` (recorded on ${moved.route}, now on ${route})` : "";
      if (mode === "replay-only") {
        result = {
          ...base,
          status: "failed",
          recovery: "none",
          locator: null,
          postState: null,
          durationMs: Date.now() - t0,
          settledMs: null,
          error: `This step has no recording${why}: replay-only runs never record. Run once without --replay-only.`,
        };
        stop = {
          kind: "failed",
          failure: {
            decider: { kind: "step", attempt, stepIndex: step.index },
            headline: `${where(step)} "${step.text}": not recorded yet${why} (replay-only).`,
          },
        };
      } else if (!options.plannerAvailable || !options.models) {
        result = {
          ...base,
          status: "blocked",
          recovery: "none",
          locator: null,
          postState: null,
          durationMs: Date.now() - t0,
          settledMs: null,
          error: `This step has no recording${why} and no AI model is available to record it.`,
        };
        stop = block(
          "ai_unavailable",
          `${where(step)} "${step.text}" has no recording${why}, and no AI model is available to record it.`,
          step.index,
        );
      } else if (options.budget?.exhausted) {
        result = {
          ...base,
          status: "blocked",
          recovery: "none",
          locator: null,
          postState: null,
          durationMs: Date.now() - t0,
          settledMs: null,
          error: "The run's AI budget is used up.",
        };
        stop = block(
          "budget_exceeded",
          `${where(step)} "${step.text}" needs AI to record, but the run's AI budget (${options.budget.setting ?? "run budget"}) is used up.`,
          step.index,
        );
      } else {
        await settlePage();
        const controller = stoppable();
        const timer = setTimeout(
          () => controller.abort(new Error("timeout")),
          Math.max(1, deadline - Date.now()),
        );
        const authored =
          step.kind === "exact" && step.exact?.form === "op"
            ? await runExactOp(session, step, step.exact.op as ExactOp<BoundText>, variables)
            : await runActionStep(
                {
                  session,
                  models: options.models,
                  budget: options.budget,
                  guards: guardContext,
                  limits: DEFAULT_LIMITS,
                  guardLines: test.guards.map((g) => g.display),
                  signal: controller.signal,
                  tags: { test: test.id },
                  inbox: { runtime: options.inbox, test },
                  target: targetOfSession(session),
                },
                step,
                variables,
              ).finally(() => clearTimeout(timer));
        clearTimeout(timer);
        for (const call of authored.modelCalls) emitCall(call);
        base.modelCallIds = authored.modelCalls.map((c) => c.id);
        if (authored.model) authoredModel = authored.model;
        const settled = authored.commands.reduce((sum, c) => sum + c.wait.settledMs, 0);
        if (authored.status === "recorded") {
          const entry: StepRecording = {
            key,
            textKey: step.textKey,
            route,
            text: step.text,
            kind: step.kind === "exact" ? "exact" : "action",
            commands: authored.commands,
            source: step.kind === "exact" ? "exact" : "ai",
            recordedAt: now().toISOString(),
            ...(authored.reasoning ? { reasoning: redact(authored.reasoning) } : {}),
          };
          authoredSteps.push(entry);
          result = {
            ...base,
            status: "passed",
            recovery: "none",
            locator: null,
            postState: {
              status: "verified",
              expected: null,
              observed: "recorded this run (the harness saw the change)",
            },
            durationMs: Date.now() - t0,
            settledMs: settled,
            error: null,
          };
        } else {
          const reason = authored.reason ?? "step_impossible";
          const message = redact(authored.message ?? reason);
          if (BLOCKING_REASONS.has(reason) || reason === "timeout") {
            const blockedReason = reason === "timeout" ? "aborted" : reason;
            result = {
              ...base,
              status: "blocked",
              recovery: "none",
              locator: null,
              postState: null,
              durationMs: Date.now() - t0,
              settledMs: settled,
              error: message,
            };
            stop = block(blockedReason, `${where(step)} "${step.text}": ${message}`, step.index);
          } else {
            result = {
              ...base,
              status: "failed",
              recovery: "none",
              locator: null,
              postState:
                reason === "no_visible_effect"
                  ? {
                      status: "mismatch",
                      expected: "a visible change",
                      observed: "nothing changed on the page",
                    }
                  : null,
              durationMs: Date.now() - t0,
              settledMs: settled,
              error: `${reason}: ${message}`,
            };
            stop = {
              kind: "failed",
              failure: {
                decider: { kind: "step", attempt, stepIndex: step.index },
                headline: `${where(step)} "${step.text}": ${message}`,
              },
            };
          }
        }
      }
    } else {
      // REP-3: replay the recorded commands, no AI.
      let used: StepResult["locator"] = null;
      let recovery: StepResult["recovery"] = "replay";
      const posts: PostCheck[] = [];
      let settled = 0;
      let failed: Extract<CommandResult, { kind: "failed" | "blocked" }> | undefined;
      for (const [commandIndex, command] of recorded.commands.entries()) {
        const r = await replayCommand(step, key, command, commandIndex, variables);
        if (r.kind === "failed" && r.fixer && options.fixerAvailable && options.models) {
          const fixed = await fixStep(step, key, recorded, commandIndex, variables, r.fixer);
          base.modelCallIds.push(...fixed.calls.map((c) => c.id));
          if (fixed.kind === "ok") {
            posts.push(fixed.post);
            settled += fixed.settled;
            heals.push(fixed.heal);
            patches.push(fixed.patch);
            base.healIds.push(fixed.heal.id);
            options.emit({ type: "heal.proposed", heal: fixed.heal });
            healedByFixer++;
            recovery = "fixer";
            if (fixed.locator && !used)
              used = { used: "fallback", value: describeLocator(fixed.locator) };
            // The fixer redid the rest of the step: the remaining recorded commands are replaced.
            break;
          }
          failed =
            fixed.kind === "blocked"
              ? { kind: "blocked", reason: fixed.reason, message: fixed.message }
              : { kind: "failed", error: fixed.error, post: fixed.post, notFound: true };
          if (fixed.kind === "failed") {
            if (fixed.post) posts.push(fixed.post);
            notFoundAtFailure = true;
          }
          break;
        }
        if (r.kind !== "ok") {
          failed = r;
          if (r.kind === "failed" && r.post) posts.push(r.post);
          if (r.kind === "failed" && r.needsAi) needsAi++;
          if (r.kind === "failed") notFoundAtFailure = r.notFound;
          break;
        }
        posts.push(r.post);
        settled += r.outcome.settledMs;
        if (r.heal) {
          heals.push(r.heal);
          if (r.patch) patches.push(r.patch);
          base.healIds.push(r.heal.id);
          options.emit({ type: "heal.proposed", heal: r.heal });
          healedWithoutAi++;
          recovery = "refind";
        }
        if (r.locator && !used)
          used = {
            used: r.used === "primary" ? "primary" : "fallback",
            value: describeLocator(r.locator),
          };
      }
      const postState: PostCheck | null =
        posts.find((p) => p.status === "mismatch") ??
        posts.find((p) => p.status === "verified") ??
        posts[0] ??
        null;
      if (!failed) {
        result = {
          ...base,
          status: "passed",
          recovery,
          locator: used,
          postState,
          durationMs: Date.now() - t0,
          settledMs: settled,
          error: null,
        };
      } else if (failed.kind === "blocked") {
        result = {
          ...base,
          status: "blocked",
          recovery: "none",
          locator: used,
          postState,
          durationMs: Date.now() - t0,
          settledMs: settled,
          error: redact(failed.message),
        };
        stop = block(failed.reason, `${where(step)} "${step.text}": ${failed.message}`, step.index);
      } else {
        result = {
          ...base,
          status: "failed",
          recovery: "none",
          locator: used,
          postState,
          durationMs: Date.now() - t0,
          settledMs: settled,
          error: redact(failed.error),
        };
        stop = {
          kind: "failed",
          failure: {
            decider: { kind: "step", attempt, stepIndex: step.index },
            headline: `${where(step)} "${step.text}": ${redact(failed.error)}`,
          },
        };
      }
    }

    result.screenshots.after = await shoot(
      step.index,
      "after",
      result.status === "failed" || result.status === "blocked",
    );
    push(result);
    if (result.status === "passed") await scanPage();
    chapters.push({
      index: step.index,
      title: step.text,
      startMs: t0 - started,
      endMs: Date.now() - started,
    });
    if (stop) observationsAt = await pageInfo(lastOutcome);
  }

  // Teardown hooks run whatever happened (their failures are only logged).
  for (const hook of test.teardown) {
    const report = await runHook(session, hook, "teardown", options.hookContext);
    if (report.status !== "ok")
      options.emit({
        type: "log",
        level: "warn",
        message: `Teardown ${report.description} ${report.status}${report.message ? `: ${report.message}` : ""}`,
      });
  }

  await Promise.all(pendingShots);

  if (!stop && steps.filter((s) => s !== loginStep).every((s) => s.status === "skipped")) {
    // Nothing of the test ran (an empty test, even one that logs in first): nothing can prove a pass.
    stop = block("config_error", "The test has no steps to run.", null);
  }

  const status = !stop ? "passed" : stop.kind === "blocked" ? "blocked" : "failed";
  const observations = preparedObservations ?? {
    requests: (observationsAt?.requests ?? toObserved(lastOutcome)).slice(0, 30),
    page: observationsAt ? observationsAt.page : null,
    pageIsError: observationsAt?.isError ?? null,
    route: routeOf(session.url),
    notFound: notFoundAtFailure,
    ...(appProblems.length > 0 ? { consoleErrors: appProblems.slice(0, 5) } : {}),
  };
  return {
    attempt,
    status,
    steps,
    checks,
    heals,
    failure: stop?.kind === "failed" ? stop.failure : null,
    blocked: stop?.kind === "blocked" ? stop.block : null,
    modelCalls,
    observations,
    authored: { steps: authoredSteps, checks: authoredChecks, model: authoredModel },
    chapters,
    needsAi,
    healedWithoutAi,
    healedByFixer,
    patches,
    ...(a11y
      ? {
          accessibility: {
            standard: "wcag2aa" as const,
            pages: a11y.pages.size,
            ms: a11y.ms,
            violations: [...a11y.violations.values()],
          },
        }
      : {}),
  };
}

/**
 * The check fails on the page as it was before the preceding action (its sanity
 * test), so it can't pass until the action's result shows: auto-waiting is
 * enough. Absence checks and checks without that proof need a settled page.
 */
function discriminates(op: CheckOp, stored: CheckRecording | undefined): boolean {
  if (!stored || stored.check !== op || isAbsence(op)) return false;
  return stored.sanity?.before.result === "failed";
}

/** The element a command acts on, as recorded (and its new name after a heal). */
function selfOf(command: Command, renamedTo?: string) {
  const fp = command.fingerprint;
  return fp
    ? { role: fp.role, name: fp.name, ...(renamedTo !== undefined ? { renamedTo } : {}) }
    : undefined;
}

/** Every recorded effect of a run of commands, as one (VER-5 for a redone step). */
function mergedEffect(commands: readonly Command[]): Command["expectPost"] {
  const merged: Command["expectPost"] = {};
  for (const { expectPost } of commands) {
    if (expectPost.urlChange) merged.urlChange = expectPost.urlChange;
    if (expectPost.appeared?.length)
      merged.appeared = [...(merged.appeared ?? []), ...expectPost.appeared];
    if (expectPost.removed?.length)
      merged.removed = [...(merged.removed ?? []), ...expectPost.removed];
    if (expectPost.requests?.length)
      merged.requests = [...(merged.requests ?? []), ...expectPost.requests];
    if (expectPost.reordered) merged.reordered = true;
  }
  return merged;
}

/** A fingerprint as live element facts (same_element compares the fixer's element with the recorded one). */
function factsOfFingerprint(fp: Fingerprint): ElementFacts {
  return {
    role: fp.role,
    name: fp.name,
    tag: fp.tag,
    attributes: fp.attributes,
    text: fp.name,
    anchorText: fp.anchorText,
    framePath: fp.framePath as ElementFacts["framePath"],
    box: fp.box,
  };
}

/** A `block` answer really blocks only for "couldn't run" reasons; an error page is a failure. */
function blocks(reason: string | null, appDown: boolean): boolean {
  if (!reason) return false;
  if (BLOCKING_REASONS.has(reason)) return true;
  return reason === "app_down" && appDown;
}
