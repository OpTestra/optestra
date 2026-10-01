import type { Attempt, FailureCause, HealProposal, TestResult, Verdict } from "@optestra/contract";
import { createDecisions, type DecisionResult, type Decisions } from "./decide.js";
import type { Evidence } from "./task.js";
import type { FailureSignature } from "./tasks/duplicate-or-new.js";
import type { FailureCauseInput } from "./tasks/failure-cause.js";
import type { FlakyOrRealInput } from "./tasks/flaky-or-real.js";
import { type ElementFacts, factsFromLocator, type HealClassInput } from "./tasks/heal-class.js";
import { normalizeText } from "./tasks/shared.js";

/**
 * Glue the runner (LOOP-4) calls after a test: contract documents in, task
 * inputs and answers out. Pure and browser-safe, so the apps can show "why
 * this label" from the same code.
 */

/** A request the runner saw around a step (LOOP-0's RequestSummary). */
export interface ObservedRequest {
  method: string;
  url: string;
  /** HTTP status, or "failed"/"refused"; "pending" when still running. */
  status: number | "failed" | "refused" | "pending";
  resourceType?: string;
}

/** What the runner observed in one attempt, beyond the contract documents. */
export interface AttemptObservations {
  /** Requests around the failing step. */
  requests?: ObservedRequest[];
  consoleErrors?: string[];
  /** The page at the failure (untrusted text). */
  page?: { status: number | null; title: string; heading: string; text: string } | null;
  /** page_is_error's answer for that page, when decided. */
  pageIsError?: boolean | null;
  /** Page path at the failure, e.g. /login. */
  route?: string | null;
  /** The failing element could not be found (the runner knows this for sure). */
  notFound?: boolean;
}

export interface FailureContext {
  /** Observations per attempt number. */
  attempts?: Record<number, AttemptObservations>;
  /** The flow chain (`Use:` names, outermost first) of each step index (from SPEC's ExpandedStep.flowPath). */
  stepFlows?: Record<number, string[]>;
  /** This test's recent verdicts, most recent first (not this run). */
  history?: { verdict: Verdict; signature: string | null }[];
  /** A cause already decided per attempt, if the runner decided one per attempt. */
  causes?: Record<number, FailureCause | null>;
}

const STEP_REQUEST =
  /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)\s+(?:returned|answered|responded(?: with)?|→|->|gave)\s+(\d{3})\b/gi;

/** Requests named in a step error ("GET /api/search returned 503"), when there were no observations. */
function requestsFromError(error: string | null): ObservedRequest[] {
  if (!error) return [];
  return [...error.matchAll(STEP_REQUEST)].map((m) => ({
    method: (m[1] ?? "GET").toUpperCase(),
    url: m[2] ?? "/",
    status: Number(m[3]),
  }));
}

const pathOf = (url: string) => {
  try {
    const parsed = new URL(url, "http://x");
    return parsed.pathname;
  } catch {
    return url.slice(0, 300);
  }
};

/** The app's host: the page document's, else the most common absolute host. */
function appHost(requests: readonly ObservedRequest[], _page: unknown): string | null {
  const hostOf = (url: string) => {
    try {
      return /^https?:/i.test(url) ? new URL(url).host : null;
    } catch {
      return null;
    }
  };
  const doc = requests.find((r) => r.resourceType === "document");
  const fromDoc = doc ? hostOf(doc.url) : null;
  if (fromDoc) return fromDoc;
  const counts = new Map<string, number>();
  for (const r of requests) {
    const h = hostOf(r.url);
    if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** An absolute URL on another host than the app's (relative URLs are the app's). */
function thirdParty(url: string, app: string | null): boolean {
  if (!app || !/^https?:/i.test(url)) return false;
  try {
    const host = new URL(url).host;
    return host !== app && !host.endsWith(`.${app.replace(/^www\./, "")}`);
  } catch {
    return false;
  }
}

const failingStepOf = (attempt: Attempt | undefined) =>
  attempt?.steps.find((s) => s.status === "failed" || s.status === "blocked");

function failingCheckOf(result: TestResult, attempt: Attempt | undefined) {
  if (!attempt) return undefined;
  const decider = result.decidedBy.find((d) => d.kind === "check" && d.attempt === attempt.attempt);
  const byDecider =
    decider?.kind === "check"
      ? attempt.checks.find((c) => c.id === decider.checkId && !c.passed)
      : undefined;
  return byDecider ?? attempt.checks.find((c) => !c.passed && !c.soft);
}

/** "check:c1|expected <money>, found <money>" or "step:2|timed out …": how an attempt failed. */
export function attemptSignature(result: TestResult, attempt: Attempt): string | null {
  if (attempt.status === "passed") return null;
  const check = failingCheckOf(result, attempt);
  if (check)
    return `check:${check.id}|${normalizeText(`expected ${check.expected ?? ""} found ${check.actual ?? ""}`)}`;
  const step = failingStepOf(attempt);
  if (step) return `step:${step.index}|${normalizeText(step.error ?? step.status)}`;
  return `attempt:${attempt.status}`;
}

export type FailureCauseCase =
  /** Nothing to classify: the test passed or healed. */
  | { kind: "none" }
  /** A blocked reason: the cause is `blocked`, deterministically, no decision needed. */
  | { kind: "blocked"; cause: "blocked"; evidence: Evidence[] }
  /** Decide with failure_cause. */
  | { kind: "decide"; input: FailureCauseInput };

/** failure_cause's input for a failed or flaky test, or the deterministic `blocked` cause. */
export function failureCauseCase(
  result: TestResult,
  context: FailureContext = {},
): FailureCauseCase {
  if (result.verdict === "passed" || result.verdict === "healed") return { kind: "none" };
  const blocked = result.decidedBy.find((d) => d.kind === "blocked");
  const lastBlocked = [...result.attempts].reverse().find((a) => a.status === "blocked");
  if (result.verdict === "blocked" || blocked) {
    const step = failingStepOf(lastBlocked);
    const evidence: Evidence[] = [
      {
        signal: "blocked_reason",
        detail: blocked?.kind === "blocked" ? `${blocked.reason}: ${blocked.message}` : "blocked",
      },
    ];
    if (step && lastBlocked)
      evidence.push({
        signal: "blocked_step",
        detail: step.text,
        ref: { kind: "step", attempt: lastBlocked.attempt, stepIndex: step.index },
      });
    return { kind: "blocked", cause: "blocked", evidence };
  }
  const failed = [...result.attempts].reverse().find((a) => a.status === "failed");
  if (!failed) return { kind: "none" };
  const obs = (n: number) => context.attempts?.[n] ?? {};
  const step = failingStepOf(failed);
  const check = failingCheckOf(result, failed);
  const here = obs(failed.attempt);
  const requests = (here.requests ?? requestsFromError(step?.error ?? null)).slice(0, 30);
  const summarize = (attempt: Attempt) => {
    const o = obs(attempt.attempt);
    const s = failingStepOf(attempt);
    const reqs = o.requests ?? requestsFromError(s?.error ?? null);
    return {
      attempt: attempt.attempt,
      status: attempt.status,
      failedStep: s?.index ?? null,
      failedCheck:
        attempt.status === "passed" ? null : (failingCheckOf(result, attempt)?.id ?? null),
      serverErrors: reqs.filter((r) => typeof r.status === "number" && r.status >= 500).length,
      networkFailures: reqs.filter((r) => r.status === "failed").length,
      errorPage: o.pageIsError ?? null,
    };
  };
  return {
    kind: "decide",
    input: {
      verdict: result.verdict === "flaky" ? "flaky" : "failed",
      failingAttempt: failed.attempt,
      attempts: result.attempts.slice(-10).map(summarize),
      failingStep: step
        ? {
            attempt: failed.attempt,
            index: step.index,
            text: step.text.slice(0, 500),
            kind: step.kind,
            recovery: step.recovery,
            error: step.error?.slice(0, 1000) ?? null,
            notFound: here.notFound ?? false,
            postState: step.postState?.status ?? null,
            flow: context.stepFlows?.[step.index]?.at(-1) ?? null,
          }
        : null,
      failingCheck: check
        ? {
            attempt: failed.attempt,
            id: check.id,
            kind: check.kind,
            expectation: check.expectation.slice(0, 500),
            expected: check.expected?.slice(0, 500) ?? null,
            actual: check.actual?.slice(0, 500) ?? null,
          }
        : null,
      requests: requests.map((r) => ({
        method: r.method.slice(0, 10),
        path: pathOf(r.url),
        status: r.status,
        document: r.resourceType === "document",
        thirdParty: thirdParty(r.url, appHost(requests, here.page)),
      })),
      consoleErrors: (here.consoleErrors ?? []).slice(0, 20).map((e) => e.slice(0, 500)),
      page: here.page
        ? {
            status: here.page.status,
            title: here.page.title.slice(0, 500),
            heading: here.page.heading.slice(0, 500),
            text: here.page.text.slice(0, 2000),
          }
        : null,
      pageIsError: here.pageIsError ?? null,
    },
  };
}

/** flaky_or_real's input for a test with a failed attempt; null when nothing failed. */
export function flakyInput(
  result: TestResult,
  context: FailureContext = {},
): FlakyOrRealInput | null {
  if (!result.attempts.some((a) => a.status === "failed")) return null;
  const last = result.attempts.at(-1);
  return {
    attempts: result.attempts.slice(-10).map((a) => ({
      attempt: a.attempt,
      status: a.status,
      cause:
        context.causes?.[a.attempt] ??
        (a.status === "passed"
          ? null
          : a === last || result.verdict === "flaky"
            ? result.failureCause
            : null),
      signature: attemptSignature(result, a)?.slice(0, 500) ?? null,
    })),
    history: (context.history ?? []).slice(0, 50).map((h) => ({
      verdict: h.verdict,
      signature: h.signature?.slice(0, 500) ?? null,
    })),
  };
}

/** Both after-run inputs for one test result (brief: `inputFromTestResult`). */
export function inputFromTestResult(result: TestResult, context: FailureContext = {}) {
  return {
    failureCause: failureCauseCase(result, context),
    flakyOrReal: flakyInput(result, context),
  };
}

export interface CauseAnswer {
  cause: FailureCause | null;
  /** False when nothing reached the threshold (cause is then null). */
  decided: boolean;
  source: string;
  confidence: number;
  evidence: Evidence[];
  result?: DecisionResult;
}

/** failure_cause for a result, including the deterministic `blocked` case. */
export async function classifyFailure(
  result: TestResult,
  options: { decisions?: Decisions; context?: FailureContext } = {},
): Promise<CauseAnswer> {
  const c = failureCauseCase(result, options.context);
  if (c.kind === "none")
    return { cause: null, decided: false, source: "none", confidence: 0, evidence: [] };
  if (c.kind === "blocked")
    return {
      cause: "blocked",
      decided: true,
      source: "rules",
      confidence: 1,
      evidence: c.evidence,
    };
  const decisions = options.decisions ?? createDecisions();
  const decision = await decisions.decide("failure_cause", c.input, { testId: result.testId });
  return decision.status === "decided"
    ? {
        cause: decision.answers.cause,
        decided: true,
        source: decision.source,
        confidence: decision.confidence,
        evidence: decision.evidence,
        result: decision,
      }
    : {
        cause: null,
        decided: false,
        source: decision.best?.source ?? "none",
        confidence: decision.best?.confidence ?? 0,
        evidence: decision.best?.evidence ?? [],
        result: decision,
      };
}

/** duplicate_or_new's view of one failed/blocked test. */
export function signatureFromTestResult(
  result: TestResult,
  context: FailureContext = {},
): FailureSignature {
  const attempt =
    [...result.attempts].reverse().find((a) => a.status !== "passed") ?? result.attempts.at(-1);
  const step = failingStepOf(attempt);
  return {
    testId: result.testId.slice(0, 300),
    headline: (result.headline ?? step?.error ?? "").slice(0, 500),
    stepText: (step?.text ?? "").slice(0, 500),
    flowChain: step ? (context.stepFlows?.[step.index] ?? []).slice(0, 10) : [],
    route: (attempt ? context.attempts?.[attempt.attempt]?.route : null) ?? null,
    cause: result.failureCause,
  };
}

export interface FailureGroup {
  /** g1, g2, … in order of first appearance. */
  id: string;
  /** The first failure: what the group is compared by. */
  signature: FailureSignature;
  testIds: string[];
  /** Why each test (after the first) joined the group. */
  why: Record<string, Evidence[]>;
  /** Some member joined, or the group was opened, without a confident decision. */
  uncertain: boolean;
}

/**
 * Groups a run's failed and blocked tests (DIA-4: one broken login breaks 20
 * tests), deciding each with duplicate_or_new against the groups so far. With
 * no `decisions` it uses rules only; an escalated failure opens a new group
 * marked `uncertain`.
 */
export async function groupFailures(
  results: readonly TestResult[],
  options: { decisions?: Decisions; context?: (result: TestResult) => FailureContext } = {},
): Promise<FailureGroup[]> {
  const decisions = options.decisions ?? createDecisions();
  const groups: FailureGroup[] = [];
  for (const result of results) {
    if (result.verdict !== "failed" && result.verdict !== "blocked" && result.verdict !== "flaky")
      continue;
    const failure = signatureFromTestResult(result, options.context?.(result));
    const decision = await decisions.decide(
      "duplicate_or_new",
      {
        failure,
        groups: groups
          .slice(0, 50)
          .map((g) => ({ ...g.signature, id: g.id, size: g.testIds.length })),
      },
      { testId: result.testId },
    );
    const answer = decision.status === "decided" ? decision.answers.group : "new";
    const joined = groups.find((g) => g.id === answer);
    if (joined) {
      joined.testIds.push(result.testId);
      joined.why[result.testId] = decision.status === "decided" ? decision.evidence : [];
    } else {
      groups.push({
        id: `g${groups.length + 1}`,
        signature: failure,
        testIds: [result.testId],
        why: {},
        uncertain: decision.status !== "decided",
      });
    }
  }
  return groups;
}

export interface HealClassAnswer {
  classification: HealProposal["classification"];
  decided: boolean;
  source: string;
  confidence: number;
  evidence: Evidence[];
  result: DecisionResult;
}

/** heal_class's input for a proposal; element facts come from the locators unless given. */
export function healInput(
  proposal: HealProposal,
  options: {
    before?: Partial<ElementFacts>;
    after?: Partial<ElementFacts>;
    attempt?: number | null;
  } = {},
): HealClassInput {
  const locator = proposal.changes.find((c) => c.target === "locator");
  const before = { ...factsFromLocator(locator?.before ?? ""), ...options.before };
  const after = { ...factsFromLocator(locator?.after ?? ""), ...options.after };
  const cut = (f: ElementFacts): ElementFacts => ({
    ...f,
    locator: f.locator.slice(0, 500),
    name: f.name?.slice(0, 300) ?? null,
    text: f.text?.slice(0, 300) ?? null,
  });
  return {
    before: cut(before),
    after: cut(after),
    changes: proposal.changes.slice(0, 10).map((c) => ({
      target: c.target,
      before: c.before.slice(0, 500),
      after: c.after.slice(0, 500),
    })),
    signals: proposal.signals
      .slice(0, 20)
      .map((s) => ({ name: s.name.slice(0, 40), score: s.score })),
    attempt: options.attempt ?? null,
    stepIndex: proposal.stepIndex,
  };
}

/** heal_class for a proposal (HEAL-6). Nothing confident → `unknown`. */
export async function classifyHeal(
  proposal: HealProposal,
  options: {
    decisions?: Decisions;
    before?: Partial<ElementFacts>;
    after?: Partial<ElementFacts>;
    attempt?: number | null;
  } = {},
): Promise<HealClassAnswer> {
  const decisions = options.decisions ?? createDecisions();
  const result = await decisions.decide("heal_class", healInput(proposal, options));
  // A model saying `unknown` is abstaining: recorded as unknown, not as a decision.
  if (result.status === "decided" && result.answers.classification !== "unknown")
    return {
      classification: result.answers.classification,
      decided: true,
      source: result.source,
      confidence: result.confidence,
      evidence: result.evidence,
      result,
    };
  const best = result.status === "decided" ? result : result.best;
  return {
    classification: "unknown",
    decided: false,
    source: best?.source ?? "none",
    confidence: best?.confidence ?? 0,
    evidence: best?.evidence ?? [],
    result,
  };
}
