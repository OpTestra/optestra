import { z } from "zod";
import { defineTask, type Evidence, untrusted } from "../task.js";
import { anyOf, clip, findMatch, SIGNALS } from "./shared.js";

/**
 * failure_cause (DIA-1): why did this test fail? One of the contract's
 * FailureCause classes except `blocked`, which follows deterministically from a
 * blocked reason and is set by `failureCauseCase` without a decision (a decision
 * may not output a verdict word, and "blocked" is never a judgment call).
 */

const words = SIGNALS.failure_cause;
const DATA = anyOf(words.testDataPhrases);
const ENV_TEXT = anyOf(words.environmentErrors);
const UNREACHABLE =
  /econnrefused|enotfound|eai_again|net::err_(connection|name|address)|dns|name resolution|connection refused/i;
const NOT_FOUND = anyOf(words.notFoundErrors);
const CRASH = anyOf(words.crashConsole);
const IGNORED_CONSOLE = anyOf(words.ignoredConsole);
const LOADING = anyOf(words.stillLoading);

export const FAILURE_CAUSE_OPTIONS = [
  "product_bug",
  "test_drift",
  "environment",
  "test_data",
] as const;

const refStep = z.object({ attempt: z.number().int().min(1), index: z.number().int().min(0) });

export const failureCauseInput = z.object({
  /** failed, or flaky (failed, then passed on retry: the failing attempt is analysed). */
  verdict: z.enum(["failed", "flaky"]),
  /** The attempt analysed (the last failed one). */
  failingAttempt: z.number().int().min(1),
  /** Every attempt: whether it failed, where, and what the network looked like. */
  attempts: z
    .array(
      z.object({
        attempt: z.number().int().min(1),
        status: z.enum(["passed", "failed", "blocked"]),
        /** Index of the step that failed, when one did. */
        failedStep: z.number().int().min(0).nullable(),
        /** The failing check's id, when a check failed. */
        failedCheck: z.string().nullable(),
        serverErrors: z.number().int().min(0),
        networkFailures: z.number().int().min(0),
        errorPage: z.boolean().nullable(),
      }),
    )
    .min(1)
    .max(10),
  failingStep: refStep
    .extend({
      text: z.string().max(500),
      kind: z.enum(["action", "expect", "soft", "guard", "exact", "flow"]),
      recovery: z.enum(["replay", "refind", "fixer", "none"]),
      error: z.string().max(1000).nullable(),
      /** The element could not be found. */
      notFound: z.boolean(),
      /** VER-5: did the page reflect the action? */
      postState: z.enum(["verified", "mismatch", "not_checkable"]).nullable(),
      /** The flow (`Use:`) the step came from, when it did. */
      flow: z.string().max(200).nullable(),
    })
    .nullable(),
  failingCheck: z
    .object({
      attempt: z.number().int().min(1),
      id: z.string().min(1),
      kind: z.string().max(40),
      expectation: z.string().max(500),
      expected: z.string().max(500).nullable(),
      actual: z.string().max(500).nullable(),
    })
    .nullable(),
  /** Requests around the failure (method, path, status or failed). */
  requests: z
    .array(
      z.object({
        method: z.string().max(10),
        path: z.string().max(300),
        status: z.union([z.number().int(), z.literal("failed"), z.literal("refused")]),
        document: z.boolean(),
        /** Another site's request (analytics, fonts, ads): never evidence about the app. */
        thirdParty: z.boolean(),
      }),
    )
    .max(30),
  consoleErrors: z.array(z.string().max(500)).max(20),
  /** The page at the failure (untrusted). */
  page: z
    .object({
      status: z.number().int().nullable(),
      title: z.string().max(500),
      heading: z.string().max(500),
      text: z.string().max(2000),
    })
    .nullable(),
  /** page_is_error's answer for that page, when it was decided. */
  pageIsError: z.boolean().nullable(),
});
export type FailureCauseInput = z.infer<typeof failureCauseInput>;

type Cause = (typeof FAILURE_CAUSE_OPTIONS)[number];

/** The facts the rules (and a model) work from, each with its evidence. */
export function failureSignals(input: FailureCauseInput) {
  const step = input.failingStep;
  const check = input.failingCheck;
  const failed = input.attempts.filter((a) => a.status === "failed");
  const passedLater =
    input.verdict === "flaky" ||
    input.attempts.some(
      (a, i) => a.status === "passed" && i > 0 && input.attempts[i - 1]?.status === "failed",
    );
  const sameEachTime =
    failed.length >= 2 &&
    failed.length === input.attempts.length &&
    failed.every(
      (a) => a.failedStep === failed[0]?.failedStep && a.failedCheck === failed[0]?.failedCheck,
    );
  const own = input.requests.filter((r) => !r.thirdParty);
  const server = own.filter((r) => typeof r.status === "number" && r.status >= 500);
  const gateway = server.filter((r) => r.status === 502 || r.status === 503 || r.status === 504);
  const netFailed = own.filter((r) => r.status === "failed");
  const docDown = own.some((r) => r.document && r.status === "failed");
  const rateLimited = own.some((r) => r.status === 429);
  const envText = findMatch(ENV_TEXT, [["step error", step?.error]]);
  const unreachable = docDown || (step?.error ? UNREACHABLE.test(step.error) : false);
  // A 404/410 page is often a URL the test itself goes to (drift), not a server bug.
  const missingPage = input.page?.status === 404 || input.page?.status === 410;
  const errorPage =
    !missingPage && (input.pageIsError === true || (input.page?.status ?? 0) >= 500);
  const stillLoading = findMatch(LOADING, [
    ["page heading", input.page?.heading],
    ["page text", input.page?.text],
    ["post-state", step?.postState === "mismatch" ? step.error : null],
  ]);
  const data = findMatch(DATA, [
    ["check actual", check?.actual],
    ["page heading", input.page?.heading],
    ["page text", input.page?.text],
    ["step error", step?.error],
  ]);
  const notFound = step
    ? step.notFound || (step.error ? NOT_FOUND.test(step.error) : false)
    : false;
  const crash = input.consoleErrors.find((e) => CRASH.test(e) && !IGNORED_CONSOLE.test(e));
  const mismatch = step?.postState === "mismatch";
  const hardCheck = check !== null;
  const infra = server.length > 0 || netFailed.length > 0 || rateLimited || envText !== undefined;
  const healthy = !errorPage && !infra;

  const stepRef: Evidence["ref"] = step
    ? { kind: "step", attempt: step.attempt, stepIndex: step.index }
    : undefined;
  const checkRef: Evidence["ref"] = check
    ? { kind: "check", attempt: check.attempt, checkId: check.id }
    : undefined;
  const at = <T extends object>(ref: Evidence["ref"], e: T) => (ref ? { ...e, ref } : e);
  const ev = {
    server: () =>
      at(stepRef, {
        signal: gateway.length ? "http_gateway_error" : "http_5xx",
        detail: server
          .slice(0, 3)
          .map((r) => `${r.method} ${r.path} → ${r.status}`)
          .join("; "),
      }),
    network: () =>
      at(stepRef, {
        signal: docDown ? "app_unreachable" : "network_failure",
        detail:
          netFailed
            .slice(0, 3)
            .map((r) => `${r.method} ${r.path} failed`)
            .join("; ") || envText?.match,
      }),
    envText: () => at(stepRef, { signal: "environment_error", detail: envText?.match }),
    rateLimit: () => at(stepRef, { signal: "rate_limited", detail: "HTTP 429" }),
    errorPage: () =>
      at(stepRef, {
        signal: "error_page",
        detail: input.page
          ? `${input.page.status ?? "?"} "${clip(input.page.heading || input.page.title, 80)}"`
          : "page_is_error",
      }),
    passedLater: (): Evidence => ({ signal: "passed_on_retry", detail: "a later attempt passed" }),
    sameEachTime: (): Evidence => ({
      signal: "same_failure_every_attempt",
      detail: `${failed.length} attempts failed at the same place`,
    }),
    data: () =>
      at(checkRef ?? stepRef, {
        signal: "test_data_phrase",
        detail: `"${data?.match}" in ${data?.where}`,
      }),
    notFound: () =>
      at(stepRef, { signal: "element_not_found", detail: clip(step?.error, 120) || undefined }),
    crash: () => at(stepRef, { signal: "console_error", detail: clip(crash, 120) }),
    mismatch: () =>
      at(stepRef, { signal: "post_state_mismatch", detail: "the page didn't reflect the action" }),
    check: () =>
      at(checkRef, {
        signal: "check_failed",
        detail: check
          ? `expected ${check.expected ?? "?"}, found ${check.actual ?? "?"}`
          : undefined,
      }),
    healthy: (): Evidence => ({
      signal: "page_healthy",
      detail: "no error page, 5xx or network failure",
    }),
  };
  return {
    step,
    passedLater,
    sameEachTime,
    singleAttempt: input.attempts.length === 1,
    server,
    gateway,
    netFailed,
    rateLimited,
    envText,
    unreachable,
    errorPage,
    data,
    notFound,
    crash,
    mismatch,
    missingPage,
    stillLoading,
    hardCheck,
    infra,
    healthy,
    ev,
  };
}

const answer = (cause: Cause, confidence: number, evidence: Evidence[]) => ({
  answers: { cause },
  confidence,
  evidence: evidence.map(
    (e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as Evidence,
  ),
});

export const failureCause = defineTask({
  name: "failure_cause",
  version: 1,
  description: "Why did this test fail: product bug, test drift, environment or test data?",
  phase: "after",
  input: failureCauseInput,
  questions: {
    cause: {
      kind: "choice",
      instructions:
        "Which is the most likely cause of this failure? product_bug: the app misbehaves (a server error that repeats, wrong content, an action that does nothing). test_drift: the app changed on purpose and the test no longer matches it (a renamed or moved element on an otherwise healthy page). environment: infrastructure or timing (unreachable app, gateway errors, timeouts, rate limits, a failure that passed on retry). test_data: the data the test relied on was wrong or already used (duplicate account, expired code, missing record).",
      options: FAILURE_CAUSE_OPTIONS,
    },
  },
  rules(input) {
    const s = failureSignals(input);
    const { ev } = s;
    // Environment: the app or network was unreachable or unstable.
    if (s.unreachable) return answer("environment", 0.95, [ev.network()]);
    if (s.infra && s.passedLater)
      return answer("environment", 0.93, [
        s.server.length
          ? ev.server()
          : s.netFailed.length
            ? ev.network()
            : s.rateLimited
              ? ev.rateLimit()
              : ev.envText(),
        ev.passedLater(),
      ]);
    if (s.rateLimited) return answer("environment", 0.9, [ev.rateLimit()]);
    if (s.netFailed.length > 0 || (s.envText && s.server.length === 0))
      return s.sameEachTime || s.passedLater
        ? answer("environment", 0.88, [s.netFailed.length ? ev.network() : ev.envText()])
        : answer("environment", 0.7, [s.netFailed.length ? ev.network() : ev.envText()]);
    if (s.gateway.length > 0 && s.gateway.length === s.server.length)
      return answer("environment", s.sameEachTime ? 0.86 : 0.8, [ev.server()]);
    // Test data: the app said the data was wrong or used up, on an otherwise working page.
    if (s.data && !s.errorPage && s.server.length === 0)
      return answer("test_data", 0.88, [ev.data()]);
    // A server error or error page: a bug if it repeats, the environment if it went away.
    if (s.errorPage || s.server.length > 0) {
      const why = [s.server.length ? ev.server() : ev.errorPage()];
      if (s.passedLater) return answer("environment", 0.88, [...why, ev.passedLater()]);
      if (s.sameEachTime) return answer("product_bug", 0.88, [...why, ev.sameEachTime()]);
      return answer("product_bug", 0.6, why);
    }
    if (s.missingPage)
      // A missing page: a broken link (bug) or a URL the test shouldn't use any more (drift).
      return answer("test_drift", 0.6, [
        { signal: "page_missing", detail: `HTTP ${input.page?.status}` },
      ]);
    if (s.passedLater)
      // Healthy page, failed once, then passed: timing or flakiness; let a model (or a human) look.
      return answer("environment", 0.6, [ev.passedLater()]);
    // Healthy page from here on.
    if (s.crash && (s.hardCheck || s.mismatch || s.step))
      return answer("product_bug", s.sameEachTime ? 0.88 : 0.82, [
        ev.crash(),
        ...(s.hardCheck ? [ev.check()] : []),
      ]);
    if (s.notFound && s.stillLoading)
      // Not found while the page still says it is loading: slow app or drift; don't guess.
      return answer("environment", 0.6, [
        ev.notFound(),
        { signal: "still_loading", detail: s.stillLoading.match },
      ]);
    if (s.notFound)
      return answer("test_drift", s.sameEachTime ? 0.88 : 0.85, [ev.notFound(), ev.healthy()]);
    if (s.mismatch)
      return answer("product_bug", s.sameEachTime ? 0.86 : 0.7, [ev.mismatch(), ev.healthy()]);
    if (s.hardCheck)
      return answer("product_bug", s.sameEachTime ? 0.92 : 0.88, [
        ev.check(),
        ev.healthy(),
        ...(s.sameEachTime ? [ev.sameEachTime()] : []),
      ]);
    return null;
  },
  state(input) {
    const step = input.failingStep;
    const check = input.failingCheck;
    const lines = [
      `Verdict: ${input.verdict} (attempt ${input.failingAttempt} analysed)`,
      `Attempts: ${input.attempts
        .map(
          (a) =>
            `#${a.attempt} ${a.status}${a.failedStep !== null ? ` at step ${a.failedStep + 1}` : ""}${a.serverErrors ? `, ${a.serverErrors}×5xx` : ""}${a.networkFailures ? `, ${a.networkFailures} network failures` : ""}${a.errorPage ? ", error page" : ""}`,
        )
        .join("; ")}`,
    ];
    if (step) {
      lines.push(
        `Failing step ${step.index + 1} (${step.kind}${step.flow ? `, in flow ${step.flow}` : ""}): recovery ${step.recovery}, element ${step.notFound ? "NOT found" : "found"}, post-state ${step.postState ?? "n/a"}`,
        untrusted("step-text", step.text),
      );
      if (step.error) lines.push(untrusted("step-error", clip(step.error)));
    }
    if (check) {
      lines.push(
        `Failing check (${check.kind}):`,
        untrusted("check-expectation", check.expectation),
      );
      lines.push(
        untrusted("check-expected", check.expected ?? ""),
        untrusted("check-actual", check.actual ?? ""),
      );
    }
    if (input.requests.length)
      lines.push(
        untrusted(
          "requests",
          input.requests
            .map((r) => `${r.method} ${r.path} → ${r.status}${r.document ? " (page)" : ""}`)
            .join("\n"),
        ),
      );
    if (input.consoleErrors.length)
      lines.push(
        untrusted("console-errors", input.consoleErrors.map((e) => clip(e, 200)).join("\n")),
      );
    if (input.page) {
      lines.push(
        `Page HTTP status: ${input.page.status ?? "unknown"}; looks like an error page: ${input.pageIsError ?? "unknown"}`,
      );
      lines.push(
        untrusted("page-title", input.page.title),
        untrusted("page-heading", input.page.heading),
        untrusted("page-text", clip(input.page.text, 800)),
      );
    }
    return lines.join("\n");
  },
  evidence(input) {
    const s = failureSignals(input);
    const out: Evidence[] = [];
    if (s.server.length) out.push(s.ev.server());
    if (s.netFailed.length || s.unreachable) out.push(s.ev.network());
    if (s.errorPage) out.push(s.ev.errorPage());
    if (s.data) out.push(s.ev.data());
    if (s.notFound) out.push(s.ev.notFound());
    if (s.crash) out.push(s.ev.crash());
    if (s.mismatch) out.push(s.ev.mismatch());
    if (s.hardCheck) out.push(s.ev.check());
    if (s.passedLater) out.push(s.ev.passedLater());
    if (s.sameEachTime) out.push(s.ev.sameEachTime());
    return answer("product_bug", 0, out).evidence;
  },
  onEscalate: "fixer",
});
