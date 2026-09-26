// Builds packages/decide/evals/<task>.jsonl: labelled inputs for the after-run
// decisions (LRN-10 foundation). Run after a build:
//   pnpm --filter ./packages/decide build && node packages/decide/scripts/build-evals.ts
// Labels are what a careful human triager would answer, written before looking
// at what the rules say. Sources: the contract fixtures, the shop fixture's
// manifest (expected causes per scenario × variant) and hand-written cases,
// including tricky ones the rules should escalate rather than guess.

import { readFileSync, writeFileSync } from "node:fs";
import {
  failureCauseCase,
  flakyInput,
  healInput,
  signatureFromTestResult,
} from "@testament/decide";

const root = new URL("..", import.meta.url);
const contract = new URL("../contract/fixtures/v1/", root);

type Json = Record<string, unknown>;
interface Case {
  id: string;
  source: "contract-fixture" | "shop-manifest" | "hand-written";
  note: string;
  input: Json;
  expected: string | boolean;
}

const readResult = (path: string) =>
  JSON.parse(readFileSync(new URL(`${path}/result.json`, contract), "utf8"));

// ── failure_cause ────────────────────────────────────────────────────────────

interface FcOptions {
  verdict?: "failed" | "flaky";
  attempts?: number;
  passedOnRetry?: boolean;
  step?: Partial<Json> | null;
  check?: Partial<Json> | null;
  requests?: Json[];
  console?: string[];
  page?: Json | null;
  pageIsError?: boolean | null;
}

const healthyPage = {
  status: 200,
  title: "Acme",
  heading: "Dashboard",
  text: "Welcome back, Ada.",
};

function fc(o: FcOptions): Json {
  const step =
    o.step === null
      ? null
      : {
          attempt: 1,
          index: 2,
          text: "Click 'Save'",
          kind: "action",
          recovery: "none",
          error: null,
          notFound: false,
          postState: null,
          flow: null,
          ...o.step,
        };
  const check =
    o.check === undefined || o.check === null
      ? null
      : {
          attempt: 1,
          id: "c1",
          kind: "text",
          expectation: "",
          expected: null,
          actual: null,
          ...o.check,
        };
  const n = o.passedOnRetry ? 2 : (o.attempts ?? 2);
  const serverErrors = (o.requests ?? []).filter(
    (r) => typeof r.status === "number" && (r.status as number) >= 500 && !r.thirdParty,
  ).length;
  const attempts = Array.from({ length: n }, (_, i) => {
    const passed = o.passedOnRetry && i === n - 1;
    return {
      attempt: i + 1,
      status: passed ? "passed" : "failed",
      failedStep: passed ? null : ((step?.index as number | undefined) ?? null),
      failedCheck: passed ? null : ((check?.id as string | undefined) ?? null),
      serverErrors: passed ? 0 : serverErrors,
      networkFailures: passed ? 0 : (o.requests ?? []).filter((r) => r.status === "failed").length,
      errorPage: passed ? false : (o.pageIsError ?? null),
    };
  });
  const failingAttempt = o.passedOnRetry ? 1 : n;
  if (step) step.attempt = failingAttempt;
  if (check) check.attempt = failingAttempt;
  return {
    verdict: o.passedOnRetry ? "flaky" : (o.verdict ?? "failed"),
    failingAttempt,
    attempts,
    failingStep: step,
    failingCheck: check,
    requests: (o.requests ?? []).map((r) => ({ document: false, thirdParty: false, ...r })),
    consoleErrors: o.console ?? [],
    page: o.page === undefined ? healthyPage : o.page,
    pageIsError: o.pageIsError === undefined ? false : o.pageIsError,
  };
}

const errorPage500 = {
  status: 500,
  title: "Acme",
  heading: "Something went wrong",
  text: "Please try again later.",
};
const errorPageOnOk = {
  status: 200,
  title: "Acme",
  heading: "Something went wrong",
  text: "We hit a snag.",
};

const failureCause: Case[] = [];
const addFc = (id: string, source: Case["source"], note: string, input: Json, expected: string) =>
  failureCause.push({ id, source, note, input, expected });

for (const [path, expected] of [
  ["failed-product-bug/tests/tests__checkout__discount-code", "product_bug"],
  ["flaky/tests/tests__search__search-products", "environment"],
] as const) {
  const c = failureCauseCase(readResult(path));
  if (c.kind !== "decide") throw new Error(`${path}: expected a decide case`);
  addFc(`fixture-${path.split("/")[0]}`, "contract-fixture", path, c.input as Json, expected);
}

// Shop manifest (bench/fixtures/shop/manifest.yaml), each failing scenario as the runner would see it.
addFc(
  "shop-checkout-trial-broken-signup",
  "shop-manifest",
  "Sign-up returns a 500 page, every time",
  fc({
    step: {
      index: 2,
      text: "Submit the sign-up form",
      error: "Page shows 'Something went wrong'",
      postState: "mismatch",
    },
    requests: [{ method: "POST", path: "/api/signup", status: 500 }],
    page: errorPage500,
    pageIsError: true,
  }),
  "product_bug",
);
addFc(
  "shop-signup-email-code-broken-signup",
  "shop-manifest",
  "Sign-up returns a 500 page instead of asking for the code",
  fc({
    step: { index: 3, text: "Expect: a verification code is requested", kind: "expect" },
    check: {
      expectation: "a verification code is requested",
      kind: "text",
      expected: "Enter the code we sent you",
      actual: "Something went wrong",
    },
    requests: [{ method: "POST", path: "/api/signup", status: 500 }],
    page: errorPage500,
    pageIsError: true,
  }),
  "product_bug",
);
addFc(
  "shop-checkout-trial-broken-total",
  "shop-manifest",
  "Billing shows $29.00 due during a free trial",
  fc({
    step: { index: 9, text: "Expect: nothing is due today", kind: "expect" },
    check: {
      expectation: "nothing is due today",
      expected: "'$0.00 due today'",
      actual: "'$29.00 due today'",
    },
  }),
  "product_bug",
);
addFc(
  "shop-billing-zero-due-broken-total",
  "shop-manifest",
  "Billing shows $29.00 due during a free trial",
  fc({
    step: { index: 3, text: "Expect: $0.00 due today", kind: "expect" },
    check: { expectation: "$0.00 due today", expected: "'$0.00'", actual: "'$29.00'" },
  }),
  "product_bug",
);
addFc(
  "shop-login-broken-login-redirect",
  "shop-manifest",
  "Login lands on an error page instead of the dashboard",
  fc({
    step: { index: 3, text: "Expect: the dashboard is shown", kind: "expect" },
    check: {
      kind: "url",
      expectation: "the dashboard is shown",
      expected: "/dashboard",
      actual: "/error",
    },
    page: errorPageOnOk,
    pageIsError: true,
  }),
  "product_bug",
);
addFc(
  "shop-create-project-broken-silent-click",
  "shop-manifest",
  "'Create project' can be clicked but no dialog opens",
  fc({
    step: {
      index: 2,
      text: "Click 'Create project'",
      postState: "mismatch",
      error: "Nothing happened after the click",
    },
  }),
  "product_bug",
);
addFc(
  "shop-create-project-broken-not-saved",
  "shop-manifest",
  "Project gone after a reload",
  fc({
    step: {
      index: 8,
      text: "Expect: 'Launch plan' is still in the list after a reload",
      kind: "expect",
    },
    check: {
      kind: "element_state",
      expectation: "'Launch plan' is still in the list after a reload",
      expected: "listed",
      actual: "not listed",
    },
  }),
  "product_bug",
);
addFc(
  "shop-create-project-env-flaky",
  "shop-manifest",
  "Projects API answers 503 once; the retry passes",
  fc({
    passedOnRetry: true,
    step: {
      index: 5,
      text: "Click 'Create'",
      error: "Error toast: could not create project",
      postState: "mismatch",
    },
    requests: [{ method: "POST", path: "/api/projects", status: 503 }],
  }),
  "environment",
);
for (const test of [
  "create-project",
  "billing-zero-due",
  "declined-card",
  "settings-profile",
  "avatar-upload",
  "delete-account-guard",
  "sort-orders",
]) {
  addFc(
    `shop-${test}-broken-login-redirect`,
    "shop-manifest",
    "The login flow lands on an error page, so the test can't start",
    fc({
      step: { index: 3, text: "Expect: the dashboard is shown", kind: "expect", flow: "login" },
      check: {
        kind: "url",
        expectation: "the dashboard is shown",
        expected: "/dashboard",
        actual: "/error",
      },
      page: errorPageOnOk,
      pageIsError: true,
    }),
    "product_bug",
  );
}

// Hand-written: environment.
addFc(
  "env-app-refused",
  "hand-written",
  "App not running: connection refused",
  fc({
    step: {
      index: 0,
      text: "Go to the home page",
      error: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/",
    },
    requests: [{ method: "GET", path: "/", status: "failed", document: true }],
    page: null,
    pageIsError: null,
  }),
  "environment",
);
addFc(
  "env-dns",
  "hand-written",
  "Staging host doesn't resolve",
  fc({
    step: {
      index: 0,
      text: "Go to the login page",
      error: "getaddrinfo ENOTFOUND staging.acme.dev",
    },
    page: null,
    pageIsError: null,
  }),
  "environment",
);
addFc(
  "env-502-single",
  "hand-written",
  "Bad gateway from the load balancer, no retry configured",
  fc({
    attempts: 1,
    step: { index: 4, text: "Click 'Pay'", postState: "mismatch" },
    requests: [{ method: "POST", path: "/api/checkout", status: 502 }],
    page: { status: 200, title: "Checkout", heading: "Payment", text: "Processing…" },
  }),
  "environment",
);
addFc(
  "env-504-both",
  "hand-written",
  "Gateway timeout on both attempts",
  fc({
    step: {
      index: 3,
      text: "Search for 'tote'",
      error: "Timed out waiting for results; GET /api/search returned 504",
    },
    requests: [{ method: "GET", path: "/api/search", status: 504 }],
  }),
  "environment",
);
addFc(
  "env-429",
  "hand-written",
  "Rate limited by the API",
  fc({
    step: { index: 6, text: "Click 'Send invite'", postState: "mismatch" },
    requests: [{ method: "POST", path: "/api/invites", status: 429 }],
  }),
  "environment",
);
addFc(
  "env-timeout-retry",
  "hand-written",
  "Request timed out once, passed on retry",
  fc({
    passedOnRetry: true,
    step: {
      index: 2,
      text: "Open the reports page",
      error: "net::ERR_TIMED_OUT while loading /reports",
    },
  }),
  "environment",
);
addFc(
  "env-xhr-failed-retry",
  "hand-written",
  "An XHR failed at the network level, then the retry passed",
  fc({
    passedOnRetry: true,
    step: { index: 5, text: "Click 'Refresh'", postState: "mismatch" },
    requests: [{ method: "GET", path: "/api/feed", status: "failed" }],
  }),
  "environment",
);
addFc(
  "env-tls",
  "hand-written",
  "Expired certificate on the staging host",
  fc({
    step: {
      index: 0,
      text: "Go to the home page",
      error: "net::ERR_CERT_DATE_INVALID: SSL certificate problem",
    },
    page: null,
    pageIsError: null,
  }),
  "environment",
);
addFc(
  "env-503-both",
  "hand-written",
  "Service unavailable on both attempts (maintenance)",
  fc({
    step: { index: 1, text: "Log in", postState: "mismatch" },
    requests: [{ method: "POST", path: "/api/session", status: 503 }],
  }),
  "environment",
);

// Hand-written: test data.
addFc(
  "data-email-exists",
  "hand-written",
  "Sign-up with a fixed email that already exists",
  fc({
    step: { index: 4, text: "Expect: the welcome screen", kind: "expect" },
    check: {
      expectation: "the welcome screen",
      expected: "Welcome, Ada",
      actual: "An account with this email already exists",
    },
    page: {
      status: 200,
      title: "Sign up",
      heading: "Create your account",
      text: "An account with this email already exists.",
    },
  }),
  "test_data",
);
addFc(
  "data-coupon-expired",
  "hand-written",
  "Discount code in the test has expired",
  fc({
    step: { index: 5, text: "Expect: 10% off", kind: "expect" },
    check: { expectation: "10% off", expected: "'-$10.00'", actual: "Coupon code expired" },
  }),
  "test_data",
);
addFc(
  "data-user-not-found",
  "hand-written",
  "Test user was deleted from staging",
  fc({
    step: { index: 3, text: "Expect: the dashboard", kind: "expect" },
    check: { kind: "url", expectation: "the dashboard", expected: "/dashboard", actual: "/login" },
    page: {
      status: 200,
      title: "Log in",
      heading: "Log in",
      text: "No such user: qa-bot@acme.test",
    },
  }),
  "test_data",
);
addFc(
  "data-out-of-stock",
  "hand-written",
  "The product the test buys is out of stock",
  fc({
    step: { index: 2, text: "Click 'Add to cart'", postState: "mismatch" },
    page: {
      status: 200,
      title: "Canvas tote",
      heading: "Canvas tote",
      text: "Out of stock. Notify me when it's back.",
    },
  }),
  "test_data",
);
addFc(
  "data-username-taken",
  "hand-written",
  "Username reused from an earlier run",
  fc({
    step: { index: 3, text: "Expect: profile saved", kind: "expect" },
    check: { expectation: "profile saved", expected: "Saved", actual: "That username is taken" },
  }),
  "test_data",
);
addFc(
  "data-invalid-code",
  "hand-written",
  "The verification code from an old email",
  fc({
    step: { index: 6, text: "Expect: email verified", kind: "expect" },
    check: {
      expectation: "email verified",
      expected: "Verified",
      actual: "Invalid verification code",
    },
  }),
  "test_data",
);
addFc(
  "data-invalid-discount",
  "hand-written",
  "Discount code no longer valid",
  fc({
    step: { index: 5, text: "Expect: discount applied", kind: "expect" },
    check: {
      expectation: "discount applied",
      expected: "SPRING10 applied",
      actual: "Invalid discount code",
    },
  }),
  "test_data",
);

// Hand-written: test drift.
addFc(
  "drift-button-renamed",
  "hand-written",
  "'Checkout' button renamed, page otherwise fine",
  fc({
    step: {
      index: 4,
      text: "Click 'Checkout'",
      recovery: "fixer",
      notFound: true,
      error: "Timed out waiting for getByRole('button', { name: 'Checkout' })",
    },
  }),
  "test_drift",
);
addFc(
  "drift-strict-mode",
  "hand-written",
  "Two 'Save' buttons now: locator ambiguous",
  fc({
    step: {
      index: 3,
      text: "Click 'Save'",
      error: "strict mode violation: getByText('Save') resolved to 2 elements",
    },
  }),
  "test_drift",
);
addFc(
  "drift-single-attempt",
  "hand-written",
  "Element gone after a redesign, no retries configured",
  fc({
    attempts: 1,
    step: {
      index: 7,
      text: "Open the 'Billing' tab",
      recovery: "fixer",
      notFound: true,
      error: "Could not find the 'Billing' tab",
    },
  }),
  "test_drift",
);
addFc(
  "drift-link-moved",
  "hand-written",
  "Pricing link moved into a menu",
  fc({
    step: {
      index: 1,
      text: "Click 'Pricing'",
      notFound: true,
      error: "Element not found: link 'Pricing'",
    },
    console: [
      "Download the React DevTools for a better development experience",
      "GET /favicon.ico 404",
    ],
  }),
  "test_drift",
);

// Hand-written: product bugs.
addFc(
  "bug-url-check",
  "hand-written",
  "Login succeeds but stays on /login",
  fc({
    step: { index: 3, text: "Expect: the dashboard", kind: "expect" },
    check: { kind: "url", expectation: "the dashboard", expected: "/dashboard", actual: "/login" },
    page: { status: 200, title: "Log in", heading: "Log in", text: "Email Password Log in" },
  }),
  "product_bug",
);
addFc(
  "bug-js-crash",
  "hand-written",
  "Uncaught TypeError when the list renders",
  fc({
    step: { index: 4, text: "Expect: 3 orders are listed", kind: "expect" },
    check: { kind: "count", expectation: "3 orders are listed", expected: "3", actual: "0" },
    console: ["Uncaught TypeError: Cannot read properties of undefined (reading 'items')"],
  }),
  "product_bug",
);
addFc(
  "bug-count",
  "hand-written",
  "Search returns nothing for a known product",
  fc({
    step: { index: 2, text: "Expect: at least one result", kind: "expect" },
    check: { kind: "count", expectation: "at least one result", expected: ">= 1", actual: "0" },
  }),
  "product_bug",
);
addFc(
  "bug-500-orders",
  "hand-written",
  "Placing an order returns 500 on every attempt",
  fc({
    step: { index: 8, text: "Click 'Place order'", postState: "mismatch" },
    requests: [{ method: "POST", path: "/api/orders", status: 500 }],
    page: {
      status: 200,
      title: "Checkout",
      heading: "Checkout",
      text: "Something went wrong placing your order.",
    },
  }),
  "product_bug",
);
addFc(
  "bug-settings-500-page",
  "hand-written",
  "Settings page is a 500 page on every attempt",
  fc({
    step: { index: 1, text: "Open Settings", postState: "mismatch" },
    page: errorPage500,
    pageIsError: true,
  }),
  "product_bug",
);
addFc(
  "bug-save-noop",
  "hand-written",
  "Clicking Save does nothing on both attempts",
  fc({
    step: {
      index: 5,
      text: "Click 'Save changes'",
      postState: "mismatch",
      error: "The page didn't change",
    },
  }),
  "product_bug",
);
addFc(
  "bug-total-single",
  "hand-written",
  "Wrong total, a single attempt",
  fc({
    attempts: 1,
    step: { index: 6, text: "Expect: total $110.00", kind: "expect" },
    check: { expectation: "total $110.00", expected: "'$110.00'", actual: "'$100.00'" },
  }),
  "product_bug",
);
addFc(
  "bug-third-party-noise",
  "hand-written",
  "Wrong total; an analytics beacon also returned 503 (another site)",
  fc({
    step: { index: 6, text: "Expect: total $90.00", kind: "expect" },
    check: { expectation: "total $90.00", expected: "'$90.00'", actual: "'$100.00'" },
    requests: [{ method: "POST", path: "/collect", status: 503, thirdParty: true }],
  }),
  "product_bug",
);

// Tricky: the rules should escalate, not guess.
addFc(
  "tricky-500-once-no-retry",
  "hand-written",
  "One 500, no retry: can't tell a bug from a blip",
  fc({
    attempts: 1,
    step: { index: 3, text: "Click 'Save'", postState: "mismatch" },
    requests: [{ method: "PUT", path: "/api/profile", status: 500 }],
  }),
  "product_bug",
);
addFc(
  "tricky-404-old-url",
  "hand-written",
  "Test goes straight to /old-pricing, which was removed on purpose",
  fc({
    step: { index: 0, text: "Go to /old-pricing", postState: null },
    page: {
      status: 404,
      title: "Not found",
      heading: "Page not found",
      text: "The page you're looking for doesn't exist.",
    },
    pageIsError: true,
  }),
  "test_drift",
);
addFc(
  "tricky-check-flaky",
  "hand-written",
  "Text check failed once then passed: timing",
  fc({
    passedOnRetry: true,
    step: { index: 4, text: "Expect: 'Saved' toast", kind: "expect" },
    check: { expectation: "'Saved' toast", expected: "Saved", actual: "" },
  }),
  "environment",
);
addFc(
  "tricky-spinner",
  "hand-written",
  "Element not found while the page still shows 'Loading…'",
  fc({
    attempts: 1,
    step: {
      index: 3,
      text: "Click 'Export'",
      notFound: true,
      error: "Could not find button 'Export'",
    },
    page: { status: 200, title: "Reports", heading: "Reports", text: "Loading your reports…" },
  }),
  "environment",
);
addFc(
  "tricky-timeout-no-network",
  "hand-written",
  "Timed out waiting for results, no network info, one attempt",
  fc({
    attempts: 1,
    step: {
      index: 1,
      text: "Search for 'tote'",
      postState: "mismatch",
      error: "Timed out after 10s waiting for results",
    },
  }),
  "environment",
);

// ── flaky_or_real ────────────────────────────────────────────────────────────

const sig = (s: string) => s;
const att = (list: [string, string | null, string | null][]) =>
  list.map(([status, cause, signature], i) => ({ attempt: i + 1, status, cause, signature }));
const hist = (list: [string, string | null][]) =>
  list.map(([verdict, signature]) => ({ verdict, signature }));
const flaky: Case[] = [];
const addFl = (id: string, source: Case["source"], note: string, input: Json, expected: boolean) =>
  flaky.push({ id, source, note, input, expected });

{
  const r = readResult("flaky/tests/tests__search__search-products");
  addFl(
    "fixture-flaky",
    "contract-fixture",
    "Failed with a 503, passed on retry",
    flakyInput(r) as unknown as Json,
    true,
  );
  const b = readResult("failed-product-bug/tests/tests__checkout__discount-code");
  addFl(
    "fixture-product-bug",
    "contract-fixture",
    "Same wrong total on both attempts",
    flakyInput(b) as unknown as Json,
    false,
  );
}
const TOTAL = sig("check:c1|expected <money> found <money>");
const SAVE = sig("step:5|the page didn t change");
const T503 = sig("step:3|timed out waiting for results get /api/search returned <n>");
addFl(
  "shop-env-flaky",
  "shop-manifest",
  "503 once, retry passes",
  {
    attempts: att([
      ["failed", "environment", T503],
      ["passed", null, null],
    ]),
    history: [],
  },
  true,
);
addFl(
  "shop-broken-total",
  "shop-manifest",
  "Wrong total every attempt",
  {
    attempts: att([
      ["failed", "product_bug", TOTAL],
      ["failed", "product_bug", TOTAL],
    ]),
    history: [],
  },
  false,
);
addFl(
  "shop-silent-click",
  "shop-manifest",
  "Click does nothing every attempt",
  {
    attempts: att([
      ["failed", "product_bug", SAVE],
      ["failed", "product_bug", SAVE],
    ]),
    history: [],
  },
  false,
);
for (let i = 0; i < 4; i++)
  addFl(
    `retry-pass-${i}`,
    "hand-written",
    "Failed, then passed on retry",
    {
      attempts: att([
        ["failed", i % 2 ? "environment" : null, `step:${i}|timed out`],
        ["passed", null, null],
      ]),
      history: hist([
        ["passed", null],
        ["passed", null],
      ]),
    },
    true,
  );
for (let i = 0; i < 4; i++)
  addFl(
    `real-history-${i}`,
    "hand-written",
    "Same failure every attempt and in the last runs",
    {
      attempts: att([
        ["failed", "product_bug", TOTAL],
        ["failed", "product_bug", TOTAL],
      ]),
      history: hist(Array.from({ length: 2 + i }, () => ["failed", TOTAL] as [string, string])),
    },
    false,
  );
for (let i = 0; i < 4; i++)
  addFl(
    `newly-broken-${i}`,
    "hand-written",
    "Passed for weeks, now fails the same way every attempt",
    {
      attempts: att([
        ["failed", "product_bug", SAVE],
        ["failed", "product_bug", SAVE],
      ]),
      history: hist(Array.from({ length: 3 + i }, () => ["passed", null] as [string, null])),
    },
    false,
  );
for (let i = 0; i < 4; i++)
  addFl(
    `different-each-${i}`,
    "hand-written",
    "Each attempt failed somewhere else",
    {
      attempts: att([
        ["failed", null, `step:${i}|element not found`],
        ["failed", null, `check:c${i + 2}|expected <value> found <value>`],
      ]),
      history: [],
    },
    true,
  );
for (let i = 0; i < 3; i++)
  addFl(
    `env-single-${i}`,
    "hand-written",
    "One attempt, environment cause",
    {
      attempts: att([["failed", "environment", `step:${i}|gateway time out`]]),
      history: hist([["passed", null]]),
    },
    true,
  );
for (let i = 0; i < 4; i++)
  addFl(
    `history-flips-${i}`,
    "hand-written",
    "Keeps flipping between pass and fail",
    {
      attempts: att([["failed", null, SAVE]]),
      history: hist([
        ["passed", null],
        ["failed", SAVE],
        ["passed", null],
        ["failed", SAVE],
        ["passed", null],
        ...(i ? ([["failed", SAVE]] as [string, string][]) : []),
      ]),
    },
    true,
  );
for (let i = 0; i < 3; i++)
  addFl(
    `history-flaky-${i}`,
    "hand-written",
    "Marked flaky several times recently",
    {
      attempts: att([["failed", null, TOTAL]]),
      history: hist([
        ["flaky", null],
        ["passed", null],
        ["flaky", null],
        ...(i ? ([["passed", null]] as [string, null][]) : []),
      ]),
    },
    true,
  );
for (let i = 0; i < 4; i++)
  addFl(
    `same-no-history-${i}`,
    "hand-written",
    "Same failure on every attempt, no history",
    {
      attempts: att(
        Array.from(
          { length: 2 + (i % 2) },
          () => ["failed", "product_bug", TOTAL] as [string, string, string],
        ),
      ),
      history: [],
    },
    false,
  );
addFl(
  "stable-other-failures",
  "hand-written",
  "Same failure every attempt; history failed for another reason",
  {
    attempts: att([
      ["failed", "product_bug", SAVE],
      ["failed", "product_bug", SAVE],
    ]),
    history: hist([
      ["failed", TOTAL],
      ["failed", TOTAL],
    ]),
  },
  false,
);
addFl(
  "retry-pass-third",
  "hand-written",
  "Failed twice, passed on the third attempt",
  {
    attempts: att([
      ["failed", null, SAVE],
      ["failed", null, SAVE],
      ["passed", null, null],
    ]),
    history: [],
  },
  true,
);
addFl(
  "real-three-attempts",
  "hand-written",
  "Three attempts, same failure, same in history",
  {
    attempts: att([
      ["failed", "product_bug", TOTAL],
      ["failed", "product_bug", TOTAL],
      ["failed", "product_bug", TOTAL],
    ]),
    history: hist([
      ["failed", TOTAL],
      ["failed", TOTAL],
      ["failed", TOTAL],
    ]),
  },
  false,
);
// Tricky.
addFl(
  "single-history-same",
  "hand-written",
  "One attempt; it failed the same way in the last runs",
  {
    attempts: att([["failed", "product_bug", TOTAL]]),
    history: hist([
      ["failed", TOTAL],
      ["failed", TOTAL],
    ]),
  },
  false,
);
addFl(
  "tricky-single-no-history",
  "hand-written",
  "A single failed attempt, no history: nothing to go on",
  {
    attempts: att([["failed", "product_bug", TOTAL]]),
    history: [],
  },
  false,
);
addFl(
  "tricky-known-flaky-same",
  "hand-written",
  "Same failure both attempts, but the test flips a lot in history",
  {
    attempts: att([
      ["failed", null, SAVE],
      ["failed", null, SAVE],
    ]),
    history: hist([
      ["flaky", null],
      ["passed", null],
      ["flaky", null],
      ["failed", SAVE],
      ["passed", null],
    ]),
  },
  true,
);
addFl(
  "tricky-outage-both",
  "hand-written",
  "503 on both attempts during an outage",
  {
    attempts: att([
      ["failed", "environment", T503],
      ["failed", "environment", T503],
    ]),
    history: hist([
      ["passed", null],
      ["passed", null],
    ]),
  },
  true,
);

// ── duplicate_or_new ─────────────────────────────────────────────────────────

const fs = (o: Partial<Json>): Json => ({
  testId: "tests__x",
  headline: "",
  stepText: "",
  flowChain: [],
  route: null,
  cause: null,
  ...o,
});
const group = (id: string, o: Partial<Json>, size = 1): Json => ({ ...fs(o), id, size });
const dup: Case[] = [];
const addDup = (
  id: string,
  source: Case["source"],
  note: string,
  failure: Json,
  groups: Json[],
  expected: string,
) => dup.push({ id, source, note, input: { failure, groups }, expected });

const LOGIN = {
  headline: "Expected the dashboard, landed on /error",
  stepText: "Expect: the dashboard is shown",
  flowChain: ["login"],
  route: "/error",
  cause: "product_bug",
};
const loginGroup = group("g1", { ...LOGIN, testId: "tests__login" }, 2);
const signupGroup = group("g2", {
  testId: "tests__checkout-trial",
  headline: "Sign-up shows 'Something went wrong'",
  stepText: "Submit the sign-up form",
  route: "/signup",
  cause: "product_bug",
});
const totalGroup = group("g3", {
  testId: "tests__billing-zero-due",
  headline: "Expected '$0.00 due today', found '$29.00 due today'",
  stepText: "Expect: nothing is due today",
  route: "/billing",
  cause: "product_bug",
});

{
  const bugSig = signatureFromTestResult(
    readResult("failed-product-bug/tests/tests__checkout__discount-code"),
  ) as unknown as Json;
  const flakySig = signatureFromTestResult(
    readResult("flaky/tests/tests__search__search-products"),
  ) as unknown as Json;
  addDup("fixture-first", "contract-fixture", "The first failure of a run", bugSig, [], "new");
  addDup(
    "fixture-unrelated",
    "contract-fixture",
    "A search 503 vs a wrong discount total",
    flakySig,
    [{ ...bugSig, id: "g1", size: 1 }],
    "new",
  );
}
addDup(
  "first-failure",
  "hand-written",
  "No groups yet",
  fs({ ...LOGIN, testId: "tests__login" }),
  [],
  "new",
);
addDup(
  "first-failure-2",
  "hand-written",
  "No groups yet",
  fs({ testId: "tests__a", headline: "Button missing", stepText: "Click 'Go'" }),
  [],
  "new",
);
addDup(
  "first-failure-3",
  "hand-written",
  "No groups yet",
  fs({ testId: "tests__b", headline: "503 from /api", stepText: "Search" }),
  [],
  "new",
);
for (const test of [
  "create-project",
  "billing-zero-due",
  "declined-card",
  "settings-profile",
  "avatar-upload",
  "sort-orders",
])
  addDup(
    `shop-${test}-login-flow`,
    "shop-manifest",
    "The login flow broke: same group as the login test",
    fs({ ...LOGIN, testId: `tests__${test}` }),
    [loginGroup, signupGroup],
    "g1",
  );
addDup(
  "shop-signup-email-code",
  "shop-manifest",
  "Same sign-up 500 on the same page",
  fs({
    testId: "tests__signup-email-code",
    headline: "Sign-up shows 'Something went wrong'",
    stepText: "Submit the form",
    route: "/signup",
    cause: "product_bug",
  }),
  [loginGroup, signupGroup],
  "g2",
);
addDup(
  "shop-billing-total",
  "shop-manifest",
  "Same wrong amount on the billing page",
  fs({
    testId: "tests__checkout-trial",
    headline: "Expected '$0.00 due today', found '$29.00 due today'",
    stepText: "Expect: $0.00 due today",
    route: "/billing",
    cause: "product_bug",
  }),
  [loginGroup, signupGroup, totalGroup],
  "g3",
);
for (let i = 0; i < 5; i++)
  addDup(
    `same-headline-route-${i}`,
    "hand-written",
    "Same headline (numbers differ) on the same page",
    fs({
      testId: `tests__cart-${i}`,
      headline: `Expected total '$${90 + i}.00', found '$${100 + i}.00'`,
      stepText: `Expect: total $${90 + i}`,
      route: "/cart",
      cause: "product_bug",
    }),
    [
      group("g1", {
        testId: "tests__cart",
        headline: "Expected total '$45.00', found '$50.00'",
        stepText: "Expect: total $45",
        route: "/cart",
        cause: "product_bug",
      }),
      signupGroup,
    ],
    "g1",
  );
for (let i = 0; i < 4; i++)
  addDup(
    `same-headline-step-${i}`,
    "hand-written",
    "Same headline and step text, page unknown",
    fs({
      testId: `tests__profile-${i}`,
      headline: "Save did nothing",
      stepText: "Click 'Save changes'",
      route: null,
    }),
    [
      group("g1", {
        testId: "tests__profile",
        headline: "Save did nothing",
        stepText: "Click 'Save changes'",
      }),
      totalGroup,
    ],
    "g1",
  );
const unrelated: [string, Json][] = [
  [
    "search",
    fs({
      testId: "tests__search",
      headline: "Search returned no results",
      stepText: "Expect: at least one result",
      route: "/search",
    }),
  ],
  [
    "avatar",
    fs({
      testId: "tests__avatar",
      headline: "Avatar upload rejected the PNG",
      stepText: "Upload 'avatar.png'",
      route: "/settings/profile",
    }),
  ],
  [
    "export",
    fs({
      testId: "tests__export",
      headline: "CSV export button missing",
      stepText: "Click 'Export CSV'",
      route: "/reports",
    }),
  ],
  [
    "invite",
    fs({
      testId: "tests__invite",
      headline: "Invite email never arrived",
      stepText: "Expect: an invite email",
      route: "/team",
    }),
  ],
  [
    "sort",
    fs({
      testId: "tests__sort",
      headline: "Orders not sorted by date",
      stepText: "Expect: newest order first",
      route: "/orders",
    }),
  ],
  [
    "delete",
    fs({
      testId: "tests__delete",
      headline: "Delete account dialog lacks a confirmation",
      stepText: "Expect: a confirmation is asked",
      route: "/settings/account",
    }),
  ],
  [
    "language",
    fs({
      testId: "tests__lang",
      headline: "Language switch kept English",
      stepText: "Choose 'Deutsch'",
      route: "/settings/language",
    }),
  ],
  [
    "2fa",
    fs({
      testId: "tests__2fa",
      headline: "QR code for 2FA not shown",
      stepText: "Expect: a QR code",
      route: "/security",
    }),
  ],
];
for (const [name, failure] of unrelated)
  addDup(
    `unrelated-${name}`,
    "hand-written",
    "A different problem on another page",
    failure,
    [loginGroup, signupGroup, totalGroup],
    "new",
  );
addDup(
  "shop-delete-account-guard-login-flow",
  "shop-manifest",
  "The login flow broke",
  fs({ ...LOGIN, testId: "tests__delete-account-guard" }),
  [signupGroup, totalGroup, loginGroup],
  "g1",
);
addDup(
  "nested-flow",
  "hand-written",
  "Same step inside the same nested flow (checkout > pay)",
  fs({
    testId: "tests__gift",
    headline: "Card form rejected a valid card",
    stepText: "Click 'Pay now'",
    flowChain: ["checkout", "pay"],
    route: "/pay",
  }),
  [
    group("g4", {
      testId: "tests__order",
      headline: "Card form rejected a valid card",
      stepText: "Click 'Pay now'",
      flowChain: ["checkout", "pay"],
      route: "/pay",
    }),
    loginGroup,
  ],
  "g4",
);
addDup(
  "match-second-of-three",
  "hand-written",
  "Matches the second of three groups",
  fs({
    testId: "tests__signup-b",
    headline: "Sign-up shows 'Something went wrong'",
    stepText: "Submit the sign-up form",
    route: "/signup",
  }),
  [loginGroup, signupGroup, totalGroup],
  "g2",
);
addDup(
  "match-with-query",
  "hand-written",
  "Same headline, route differs only by query string",
  fs({
    testId: "tests__search-b",
    headline: "Search returned no results",
    stepText: "Expect: results",
    route: "/search?q=bag",
  }),
  [
    group("g1", {
      testId: "tests__search-a",
      headline: "Search returned no results",
      stepText: "Expect: results",
      route: "/search?q=tote",
    }),
  ],
  "g1",
);
addDup(
  "match-with-id-route",
  "hand-written",
  "Same headline, routes differ only by record id",
  fs({
    testId: "tests__order-9",
    headline: "Order page shows the wrong status",
    stepText: "Expect: status 'Shipped'",
    route: "/orders/9912",
  }),
  [
    group("g1", {
      testId: "tests__order-1",
      headline: "Order page shows the wrong status",
      stepText: "Expect: status 'Delivered'",
      route: "/orders/1204",
    }),
  ],
  "g1",
);
addDup(
  "unrelated-notifications",
  "hand-written",
  "Different problem",
  fs({
    testId: "tests__notif",
    headline: "Notification bell count stuck at 0",
    stepText: "Expect: 1 unread notification",
    route: "/inbox",
  }),
  [loginGroup, totalGroup],
  "new",
);
addDup(
  "unrelated-darkmode",
  "hand-written",
  "Different problem",
  fs({
    testId: "tests__theme",
    headline: "Dark mode toggle has no effect",
    stepText: "Turn on 'Dark mode'",
    route: "/settings/appearance",
  }),
  [signupGroup, totalGroup],
  "new",
);
addDup(
  "unrelated-map",
  "hand-written",
  "Different problem",
  fs({
    testId: "tests__map",
    headline: "Store locator map never loads",
    stepText: "Expect: a map with store pins",
    route: "/stores",
  }),
  [loginGroup, signupGroup],
  "new",
);
// Tricky.
addDup(
  "tricky-generic-headline",
  "hand-written",
  "'Element not found' on a different page and step",
  fs({
    testId: "tests__team",
    headline: "Element not found",
    stepText: "Click 'Invite'",
    route: "/team",
  }),
  [
    group("g1", {
      testId: "tests__cart",
      headline: "Element not found",
      stepText: "Click 'Checkout'",
      route: "/cart",
    }),
  ],
  "new",
);
addDup(
  "tricky-generic-headline-2",
  "hand-written",
  "'Timed out' on another page",
  fs({
    testId: "tests__reports",
    headline: "Timed out after 10s",
    stepText: "Open 'Reports'",
    route: "/reports",
  }),
  [
    group("g1", {
      testId: "tests__search",
      headline: "Timed out after 10s",
      stepText: "Search for 'tote'",
      route: "/search",
    }),
  ],
  "new",
);
addDup(
  "tricky-same-page-new-words",
  "hand-written",
  "Same broken checkout page, worded differently",
  fs({
    testId: "tests__guest",
    headline: "Checkout page shows a blank screen",
    stepText: "Click 'Pay'",
    route: "/checkout",
    cause: "product_bug",
  }),
  [
    group("g1", {
      testId: "tests__member",
      headline: "Payment form missing on checkout",
      stepText: "Enter card details",
      route: "/checkout",
      cause: "product_bug",
    }),
  ],
  "g1",
);
addDup(
  "tricky-same-step-other-page",
  "hand-written",
  "'Click Save' failing on two unrelated pages",
  fs({
    testId: "tests__billing",
    headline: "Billing address not saved",
    stepText: "Click 'Save'",
    route: "/billing",
  }),
  [
    group("g1", {
      testId: "tests__profile",
      headline: "Profile name not saved",
      stepText: "Click 'Save'",
      route: "/profile",
    }),
  ],
  "new",
);
addDup(
  "tricky-quoted-only",
  "hand-written",
  "Headlines differ only in quoted values",
  fs({
    testId: "tests__p2",
    headline: "Expected 'Launch plan' in the list",
    stepText: "Expect: 'Launch plan' is listed",
    route: "/projects",
  }),
  [
    group("g1", {
      testId: "tests__p1",
      headline: "Expected 'Q3 roadmap' in the list",
      stepText: "Expect: 'Q3 roadmap' is listed",
      route: "/projects",
    }),
  ],
  "g1",
);

// ── heal_class ───────────────────────────────────────────────────────────────

const heal: Case[] = [];
const loc = (role: string, name: string) => `getByRole('${role}', { name: '${name}' })`;
const proposal = (before: string, after: string, extra: Json[] = [], signals: Json[] = []) => ({
  id: "h1",
  stepIndex: 1,
  stepKey: "action:x",
  changes: [{ target: "locator", before, after }, ...extra],
  diff: "",
  signals,
  confidence: 0.8,
  classification: "unknown",
  status: "pending",
  policy: "review",
});
const addHeal = (
  id: string,
  source: Case["source"],
  note: string,
  p: Json,
  expected: string,
  facts: Json = {},
) =>
  heal.push({
    id,
    source,
    note,
    input: healInput(p as never, { attempt: 1, ...facts }) as unknown as Json,
    expected,
  });

{
  const h = readResult("healed/tests/tests__cart__add-to-cart").attempts[0].heals[0];
  heal.push({
    id: "fixture-add-to-bag",
    source: "contract-fixture",
    note: "'Add to cart' → 'Add to bag'",
    input: healInput(h, { attempt: 1 }) as unknown as Json,
    expected: "cosmetic",
  });
}
addHeal(
  "shop-cosmetic-variant",
  "shop-manifest",
  "Cosmetic variant: same button, new class and test id",
  proposal("locator('.btn-primary.create')", "locator('.button--main')"),
  "cosmetic",
  {
    before: { role: "button", name: "Create project", tag: "button" },
    after: { role: "button", name: "Create project", tag: "button" },
  },
);
for (const [i, [b, a]] of [
  ["locator('#save')", "locator('[data-testid=save-btn]')"],
  ["getByTestId('checkout')", "getByTestId('checkout-button')"],
  ["locator('form > button.primary')", "locator('button.submit')"],
  ["locator('nav a:nth-child(3)')", "locator('nav a:nth-child(4)')"],
].entries())
  addHeal(
    `same-name-css-${i}`,
    "hand-written",
    "Same role and name, only CSS / test id changed",
    proposal(b ?? "", a ?? ""),
    "cosmetic",
    {
      before: {
        role: i === 3 ? "link" : "button",
        name: ["Save", "Checkout", "Submit", "Pricing"][i],
      },
      after: {
        role: i === 3 ? "link" : "button",
        name: ["Save", "Checkout", "Submit", "Pricing"][i],
      },
    },
  );
for (const [i, [b, a]] of [
  ["Sign in", "Sign In"],
  ["Save", "Save."],
  ["Add to cart", "ADD TO CART"],
  ["Log in", "Log in →"],
].entries())
  addHeal(
    `case-punct-${i}`,
    "hand-written",
    "Only case or punctuation changed",
    proposal(loc("button", b ?? ""), loc("button", a ?? "")),
    "cosmetic",
  );
addHeal(
  "wait-only",
  "hand-written",
  "Only the wait changed",
  {
    ...proposal("x", "x"),
    changes: [{ target: "wait", before: "networkidle", after: "domcontentloaded" }],
  },
  "cosmetic",
);
addHeal(
  "wait-only-2",
  "hand-written",
  "Only the timeout changed",
  { ...proposal("x", "x"), changes: [{ target: "wait", before: "5s", after: "10s" }] },
  "cosmetic",
);
for (const [i, [rb, ra, n]] of [
  ["button", "link", "Upgrade"],
  ["link", "button", "Docs"],
  ["checkbox", "switch", "Email me"],
  ["button", "menuitem", "Delete"],
].entries())
  addHeal(
    `role-changed-${i}`,
    "hand-written",
    "Role changed",
    proposal(loc(rb ?? "", n ?? ""), loc(ra ?? "", n ?? "")),
    "behavior_change",
  );
addHeal(
  "action-changed",
  "hand-written",
  "Click became a select",
  {
    ...proposal(loc("combobox", "Plan"), loc("combobox", "Plan")),
    changes: [
      { target: "locator", before: loc("button", "Plan"), after: loc("combobox", "Plan") },
      { target: "action", before: "click", after: "select 'Pro'" },
    ],
  },
  "behavior_change",
);
addHeal(
  "action-changed-2",
  "hand-written",
  "Click became a fill",
  {
    ...proposal(loc("textbox", "Search"), loc("textbox", "Search")),
    changes: [{ target: "action", before: "click", after: "fill 'tote'" }],
  },
  "behavior_change",
);
for (const [i, [b, a]] of [
  ["Save", "Cancel"],
  ["Accept", "Decline"],
  ["Subscribe", "Unsubscribe"],
  ["Enable notifications", "Disable notifications"],
  ["Log in", "Log out"],
  ["Add to cart", "Remove from cart"],
].entries())
  addHeal(
    `opposite-${i}`,
    "hand-written",
    "The opposite action",
    proposal(loc("button", b ?? ""), loc("button", a ?? "")),
    "behavior_change",
  );
for (const [i, [b, a]] of [
  ["Continue", "Next"],
  ["Log in", "Sign in"],
  ["Delete", "Remove"],
  ["Settings", "Preferences"],
  ["Submit", "Send"],
].entries())
  addHeal(
    `synonym-${i}`,
    "hand-written",
    "Same meaning, different word",
    proposal(loc(i === 3 ? "link" : "button", b ?? ""), loc(i === 3 ? "link" : "button", a ?? "")),
    "cosmetic",
  );
for (const [i, [b, a]] of [
  ["Delete", "Archive"],
  ["Buy now", "Add to cart"],
  ["Share", "Download"],
  ["Upload", "Download"],
  ["Publish", "Save"],
].entries())
  addHeal(
    `different-verb-${i}`,
    "hand-written",
    "A different action verb",
    proposal(loc("button", b ?? ""), loc("button", a ?? "")),
    "behavior_change",
  );
for (const [i, [b, a]] of [
  ["Save", "Save now"],
  ["Continue", "Continue for free"],
  ["Try again", "Try it again"],
].entries())
  addHeal(
    `reworded-${i}`,
    "hand-written",
    "Same words plus filler",
    proposal(loc("button", b ?? ""), loc("button", a ?? "")),
    "cosmetic",
  );
// Tricky: rules should escalate.
addHeal(
  "tricky-pricing-plans",
  "hand-written",
  "'Pricing' → 'Plans' nav link",
  proposal(loc("link", "Pricing"), loc("link", "Plans")),
  "cosmetic",
);
addHeal(
  "tricky-blog-docs",
  "hand-written",
  "'Blog' → 'Docs' nav link: a different page",
  proposal(loc("link", "Blog"), loc("link", "Docs")),
  "behavior_change",
);
addHeal(
  "tricky-wishlist",
  "hand-written",
  "'Add to cart' → 'Add to wishlist'",
  proposal(loc("button", "Add to cart"), loc("button", "Add to wishlist")),
  "behavior_change",
);
addHeal(
  "tricky-delete-account",
  "hand-written",
  "'Delete' → 'Delete account'",
  proposal(loc("button", "Delete"), loc("button", "Delete account")),
  "behavior_change",
);
addHeal(
  "tricky-get-started",
  "hand-written",
  "'Get started' → 'Start free trial'",
  proposal(loc("button", "Get started"), loc("button", "Start free trial")),
  "cosmetic",
);
addHeal(
  "tricky-testid-only",
  "hand-written",
  "Test id changed, no role or name known",
  proposal("getByTestId('nav-cart')", "getByTestId('header-cart')"),
  "cosmetic",
);

// ── write ────────────────────────────────────────────────────────────────────

const sets: Record<string, Case[]> = {
  failure_cause: failureCause,
  flaky_or_real: flaky,
  duplicate_or_new: dup,
  heal_class: heal,
};
for (const [task, cases] of Object.entries(sets)) {
  const ids = new Set(cases.map((c) => c.id));
  if (ids.size !== cases.length) throw new Error(`${task}: duplicate case ids`);
  if (cases.length < 40) throw new Error(`${task}: only ${cases.length} cases (need 40)`);
  writeFileSync(
    new URL(`evals/${task}.jsonl`, root),
    `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
  );
  console.log(`${task}: ${cases.length} cases`);
}
