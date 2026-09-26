// Writes the golden run folders in fixtures/v1 through the real run writer.
// Fixtures are frozen once committed: existing folders are skipped so old
// fixtures keep testing that old documents still parse. Pass --force to
// rewrite them (only while the contract version is unreleased).
// Run: pnpm --filter ./packages/contract build && pnpm --filter ./packages/contract gen:fixtures
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runLayout, testIdFromPath, ulid } from "../dist/index.js";
import { createRunWriter } from "../dist/node/index.js";

type Writer = ReturnType<typeof createRunWriter>;
type Json = Record<string, unknown>;

const ROOT = fileURLToPath(new URL("../fixtures/v1/", import.meta.url));
const force = process.argv.includes("--force");

// ── placeholder artifacts ───────────────────────────────────────────────────
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
const WEBM = Buffer.from("placeholder video\n");

/** Deterministic "random" bytes so fixture run ids never change. */
function seeded(name: string) {
  let state = 0x9e3779b9;
  for (const char of name) state = Math.imul(state ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      bytes[i] = state & 0xff;
    }
    return bytes;
  };
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9{}]+/g, "-")
    .replace(/^-|-$/g, "");

// ── fixture builder ─────────────────────────────────────────────────────────
class Fixture {
  readonly writer: Writer;
  #time: number;

  constructor(dir: string, start: string, name: string) {
    this.#time = Date.parse(start);
    this.writer = createRunWriter(dir, {
      scrub: (text) => text,
      runId: ulid(this.#time, seeded(name)),
      now: () => new Date(this.#time),
    });
  }

  /** Advances the clock and returns the new time. */
  tick(ms: number): string {
    this.#time += ms;
    return new Date(this.#time).toISOString();
  }

  emit(event: Json, afterMs = 0) {
    return this.writer.emit({ ...event, ts: this.tick(afterMs) } as Parameters<Writer["emit"]>[0]);
  }

  artifact(
    kind: string,
    path: string,
    contentType: string,
    content: Uint8Array | string,
    ctx: Ctx,
  ) {
    return this.writer.writeArtifact(
      {
        kind,
        path,
        contentType,
        scrubbed: true,
        testId: ctx.testId,
        attempt: ctx.attempt,
      } as never,
      content,
    );
  }
}

interface Ctx {
  f: Fixture;
  testId: string;
  attempt: number;
}

interface CheckSpec {
  expectation: string;
  description: string;
  code: string;
  kind: string;
  soft?: boolean;
  passed: boolean;
  expected: string | null;
  actual: string | null;
}

interface StepSpec {
  index: number;
  text: string;
  kind?: string;
  status?: string;
  recovery?: string;
  locator?: { used: "primary" | "fallback"; value: string } | null;
  postState?: { status: string; expected: string | null; observed: string | null } | null;
  durationMs: number;
  settledMs?: number | null;
  error?: string | null;
  checks?: CheckSpec[];
  modelCalls?: Json[];
  decisions?: Json[];
  heals?: Json[];
  screenshots?: boolean;
}

const counters = new WeakMap<object, Record<string, number>>();
function nextId(ctx: Ctx, prefix: string): string {
  const key = ctx.f.writer as object;
  const all = counters.get(key) ?? {};
  counters.set(key, all);
  const scoped = `${ctx.testId}/${ctx.attempt}/${prefix}`;
  all[scoped] = (all[scoped] ?? 0) + 1;
  return `${prefix}${all[scoped]}`;
}

function modelCall(ctx: Ctx, call: Json): Json {
  return {
    id: nextId(ctx, "m"),
    startedAt: new Date(0).toISOString(),
    tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 },
    attempts: 1,
    outcome: "ok",
    ...call,
  };
}

/** Emits step.started, calls, decisions, screenshots, checks, heals and step.finished. */
function step(ctx: Ctx, spec: StepSpec) {
  const { f, testId, attempt } = ctx;
  const kind = spec.kind ?? "action";
  const startedAt = f.emit(
    {
      type: "step.started",
      testId,
      attempt,
      index: spec.index,
      key: `${kind}:${slug(spec.text)}`,
      text: spec.text,
      kind,
    },
    40,
  ).ts;
  const shots = spec.screenshots ?? true;
  if (shots)
    f.artifact(
      "screenshot",
      runLayout.screenshot(testId, attempt, spec.index, "before"),
      "image/png",
      PNG,
      ctx,
    );
  const modelCallIds: string[] = [];
  for (const call of spec.modelCalls ?? []) {
    f.tick(Number(call.latencyMs ?? 0));
    const full = modelCall(ctx, {
      ...call,
      startedAt: new Date(Date.parse(startedAt) + 5).toISOString(),
    });
    modelCallIds.push(String(full.id));
    f.emit({ type: "model.called", testId, attempt, call: full });
  }
  const decisionIds: string[] = [];
  for (const decision of spec.decisions ?? []) {
    const full = { id: nextId(ctx, "d"), escalated: false, ...decision };
    decisionIds.push(full.id);
    f.emit(
      { type: "decision.made", testId, attempt, decision: full },
      Number(decision.latencyMs ?? 0),
    );
  }
  f.tick(spec.durationMs);
  if (shots)
    f.artifact(
      "screenshot",
      runLayout.screenshot(testId, attempt, spec.index, "after"),
      "image/png",
      PNG,
      ctx,
    );
  const checkIds: string[] = [];
  for (const check of spec.checks ?? []) {
    const id = nextId(ctx, "c");
    checkIds.push(id);
    f.emit(
      {
        type: "check.evaluated",
        testId,
        attempt,
        check: {
          id,
          stepIndex: spec.index,
          expectation: check.expectation,
          generated: { description: check.description, code: check.code },
          kind: check.kind,
          soft: check.soft ?? false,
          passed: check.passed,
          expected: check.expected,
          actual: check.actual,
        },
      },
      15,
    );
  }
  const healIds: string[] = [];
  for (const heal of spec.heals ?? []) {
    const id = nextId(ctx, "h");
    healIds.push(id);
    f.emit({
      type: "heal.proposed",
      testId,
      attempt,
      heal: { id, stepIndex: spec.index, stepKey: `${kind}:${slug(spec.text)}`, ...heal },
    });
  }
  f.emit({
    type: "step.finished",
    testId,
    attempt,
    step: {
      index: spec.index,
      key: `${kind}:${slug(spec.text)}`,
      text: spec.text,
      kind,
      status: spec.status ?? "passed",
      recovery: spec.recovery ?? (kind === "action" ? "replay" : "none"),
      locator: spec.locator ?? null,
      postState: spec.postState ?? null,
      startedAt,
      durationMs: Date.parse(f.tick(0)) - Date.parse(startedAt),
      settledMs: spec.settledMs ?? null,
      screenshots: shots
        ? {
            before: runLayout.screenshot(testId, attempt, spec.index, "before"),
            after: runLayout.screenshot(testId, attempt, spec.index, "after"),
          }
        : { before: null, after: null },
      error: spec.error ?? null,
      checkIds,
      modelCallIds,
      decisionIds,
      healIds,
    },
  });
  return { checkIds, decisionIds };
}

function webArtifacts(ctx: Ctx, notes: { console?: string; network?: Json[] } = {}) {
  const { f, testId, attempt } = ctx;
  f.artifact("video", runLayout.attemptFile(testId, attempt, "video"), "video/webm", WEBM, ctx);
  f.artifact(
    "trace",
    runLayout.attemptFile(testId, attempt, "trace"),
    "application/zip",
    EMPTY_ZIP,
    ctx,
  );
  f.artifact(
    "console",
    runLayout.attemptFile(testId, attempt, "console"),
    "text/plain",
    notes.console ?? "[info] app booted\n",
    ctx,
  );
  const har = {
    log: {
      version: "1.2",
      creator: { name: "fixture", version: "1" },
      entries: notes.network ?? [],
    },
  };
  f.artifact(
    "network",
    runLayout.attemptFile(testId, attempt, "network"),
    "application/json",
    `${JSON.stringify(har, null, 2)}\n`,
    ctx,
  );
}

function startTest(
  f: Fixture,
  file: string,
  name: string,
  tags: string[],
  matrix: Json,
  afterMs = 30,
) {
  const testId = testIdFromPath(file);
  f.emit({ type: "test.started", testId, file, name, tags, matrix }, afterMs);
  return testId;
}

function attempt(
  f: Fixture,
  testId: string,
  n: number,
  body: (ctx: Ctx) => "passed" | "failed" | "blocked",
) {
  const ctx = { f, testId, attempt: n };
  f.emit({ type: "attempt.started", testId, attempt: n }, 20);
  const status = body(ctx);
  f.emit({ type: "attempt.finished", testId, attempt: n, status }, 30);
  return ctx;
}

const CHROMIUM = { target: "web", browser: "chromium", device: null };
const GIT_MAIN = { branch: "main", commit: "4f1c2e9a7b3d5f60812c4e9d0a1b2c3d4e5f6071", pr: null };

function runStarted(f: Fixture, overrides: Json) {
  f.emit({
    type: "run.started",
    engineVersion: "0.1.0",
    project: "demo-shop",
    environment: "staging",
    target: "web",
    trigger: "ci",
    mode: "normal",
    git: GIT_MAIN,
    ...overrides,
  });
}

// ── reusable tests ──────────────────────────────────────────────────────────
function guestCheckout(f: Fixture) {
  const testId = startTest(
    f,
    "tests/checkout/guest-checkout.md",
    "Guest checkout",
    ["checkout", "smoke"],
    CHROMIUM,
  );
  const ctx = attempt(f, testId, 1, (ctx) => {
    step(ctx, {
      index: 0,
      text: "Open the home page",
      postState: { status: "verified", expected: "URL is /", observed: "/" },
      durationMs: 820,
      settledMs: 640,
    });
    step(ctx, {
      index: 1,
      text: "Add 'Canvas Tote' to the cart",
      locator: { used: "primary", value: "getByRole('button', { name: 'Add to cart' })" },
      postState: { status: "verified", expected: "cart badge shows 1", observed: "1" },
      durationMs: 410,
      settledMs: 180,
    });
    step(ctx, {
      index: 2,
      text: "Check out as a guest with email {email}",
      locator: { used: "primary", value: "getByRole('link', { name: 'Checkout' })" },
      postState: { status: "verified", expected: "URL is /checkout", observed: "/checkout" },
      durationMs: 1650,
      settledMs: 900,
    });
    step(ctx, {
      index: 3,
      kind: "expect",
      text: "The page says 'Thanks for your order'",
      durationMs: 120,
      checks: [
        {
          expectation: "The page says 'Thanks for your order'",
          description: "The page shows the heading 'Thanks for your order'",
          code: "await expect(page.getByRole('heading', { name: 'Thanks for your order' })).toBeVisible();",
          kind: "text",
          passed: true,
          expected: "heading 'Thanks for your order'",
          actual: "heading 'Thanks for your order'",
        },
        {
          expectation: "The page says 'Thanks for your order'",
          description: "The URL ends with /order/confirmed",
          code: "await expect(page).toHaveURL(/\\/order\\/confirmed$/);",
          kind: "url",
          passed: true,
          expected: "/order/confirmed",
          actual: "/order/confirmed",
        },
      ],
    });
    webArtifacts(ctx);
    return "passed";
  });
  f.emit(
    {
      type: "test.finished",
      testId,
      verdict: "passed",
      decidedBy: [
        { kind: "check", attempt: 1, checkId: "c1" },
        { kind: "check", attempt: 1, checkId: "c2" },
      ],
      checkedSummary: [
        "The page showed the heading 'Thanks for your order'.",
        "The URL ended with /order/confirmed.",
      ],
      recentAi: { runs: 20, calls: 0 },
    },
    10,
  );
  return ctx;
}

function searchProducts(f: Fixture, flakyFirst = false) {
  const file = "tests/search/search-products.md";
  const testId = startTest(f, file, "Search finds products", ["search"], CHROMIUM);
  const open = (ctx: Ctx) =>
    step(ctx, {
      index: 0,
      text: "Open the home page",
      postState: { status: "verified", expected: "URL is /", observed: "/" },
      durationMs: 760,
      settledMs: 590,
    });
  const search = (ctx: Ctx, ok: boolean) =>
    step(ctx, {
      index: 1,
      text: "Search for 'tote'",
      status: ok ? "passed" : "failed",
      locator: { used: "primary", value: "getByRole('searchbox', { name: 'Search' })" },
      postState: ok
        ? {
            status: "verified",
            expected: "results list appears",
            observed: "results list with 3 items",
          }
        : {
            status: "mismatch",
            expected: "results list appears",
            observed: "loading spinner still visible",
          },
      durationMs: ok ? 540 : 10_000,
      settledMs: ok ? 420 : null,
      error: ok ? null : "Timed out after 10s waiting for results; GET /api/search returned 503",
    });
  const expectResults = (ctx: Ctx) =>
    step(ctx, {
      index: 2,
      kind: "expect",
      text: "At least one product called 'Canvas Tote' is listed",
      durationMs: 90,
      checks: [
        {
          expectation: "At least one product called 'Canvas Tote' is listed",
          description: "At least 1 result card contains 'Canvas Tote'",
          code: "expect(await page.getByRole('article').filter({ hasText: 'Canvas Tote' }).count()).toBeGreaterThanOrEqual(1);",
          kind: "count",
          passed: true,
          expected: ">= 1",
          actual: "2",
        },
      ],
    });

  let first: Ctx | undefined;
  if (flakyFirst) {
    first = attempt(f, testId, 1, (ctx) => {
      open(ctx);
      search(ctx, false);
      webArtifacts(ctx, {
        console: "[error] Failed to load resource: the server responded with a status of 503 ()\n",
        network: [
          {
            request: { method: "GET", url: "https://staging.demo-shop.test/api/search?q=tote" },
            response: { status: 503 },
          },
        ],
      });
      return "failed";
    });
  }
  const last = attempt(f, testId, flakyFirst ? 2 : 1, (ctx) => {
    open(ctx);
    search(ctx, true);
    expectResults(ctx);
    webArtifacts(ctx);
    return "passed";
  });
  const summary = ["At least 1 result card contained 'Canvas Tote' (found 2)."];
  if (!flakyFirst) {
    f.emit(
      {
        type: "test.finished",
        testId,
        verdict: "passed",
        decidedBy: [{ kind: "check", attempt: 1, checkId: "c1" }],
        checkedSummary: summary,
        recentAi: { runs: 20, calls: 0 },
      },
      10,
    );
    return;
  }
  const ctx = first as Ctx;
  const flaky = {
    id: nextId(last, "d"),
    task: "flaky_or_real",
    answer: "flaky",
    confidence: 0.88,
    source: "rules",
    latencyMs: 2,
    escalated: false,
  };
  const cause = {
    id: nextId(last, "d"),
    task: "failure_cause",
    answer: "environment",
    confidence: 0.91,
    source: "rules",
    latencyMs: 1,
    escalated: false,
  };
  f.emit({ type: "decision.made", testId, attempt: 2, decision: flaky }, 5);
  f.emit({ type: "decision.made", testId, attempt: 2, decision: cause }, 5);
  f.emit(
    {
      type: "test.finished",
      testId,
      verdict: "flaky",
      decidedBy: [
        { kind: "step", attempt: 1, stepIndex: 1 },
        { kind: "check", attempt: 2, checkId: "c1" },
      ],
      failureCause: "environment",
      failureEvidence: [
        { kind: "step", attempt: 1, stepIndex: 1 },
        { kind: "artifact", path: runLayout.attemptFile(ctx.testId, 1, "network") },
        { kind: "decision", attempt: 2, decisionId: cause.id },
      ],
      headline: "Failed, then passed on retry: GET /api/search returned 503 on the first attempt",
      checkedSummary: summary,
      recentAi: { runs: 20, calls: 0 },
    },
    10,
  );
}

// ── the fixtures ────────────────────────────────────────────────────────────
const fixtures: Record<string, (f: Fixture) => void> = {
  "all-passed"(f) {
    runStarted(f, {});
    guestCheckout(f);
    searchProducts(f);
    f.emit({ type: "run.finished" }, 50);
  },

  healed(f) {
    runStarted(f, { environment: "local", trigger: "desktop", git: null });
    const testId = startTest(
      f,
      "tests/cart/add-to-cart.md",
      "Add a product to the cart",
      ["cart"],
      CHROMIUM,
    );
    attempt(f, testId, 1, (ctx) => {
      step(ctx, {
        index: 0,
        text: "Open the page for 'Canvas Tote'",
        postState: {
          status: "verified",
          expected: "URL is /products/canvas-tote",
          observed: "/products/canvas-tote",
        },
        durationMs: 700,
        settledMs: 520,
      });
      step(ctx, {
        index: 1,
        text: "Click 'Add to cart'",
        recovery: "fixer",
        locator: { used: "primary", value: "getByRole('button', { name: 'Add to bag' })" },
        postState: { status: "verified", expected: "cart badge shows 1", observed: "1" },
        durationMs: 3200,
        settledMs: 210,
        decisions: [
          {
            task: "same_element",
            answer: { same: false, candidate: "getByRole('button', { name: 'Add to bag' })" },
            confidence: 0.41,
            source: "rules",
            latencyMs: 3,
            escalated: true,
          },
        ],
        modelCalls: [
          {
            role: "fixer",
            provider: "anthropic",
            model: "claude-sonnet-5",
            tokens: { input: 5820, output: 212, cached: 4096, cacheWrite: 0 },
            costUsd: 0.0184,
            latencyMs: 2140,
          },
        ],
        heals: [
          {
            changes: [
              {
                target: "locator",
                before: "getByRole('button', { name: 'Add to cart' })",
                after: "getByRole('button', { name: 'Add to bag' })",
              },
            ],
            diff: "@@ step 2: Click 'Add to cart' @@\n- await page.getByRole('button', { name: 'Add to cart' }).click();\n+ await page.getByRole('button', { name: 'Add to bag' }).click();\n",
            signals: [
              { name: "role_match", score: 1, detail: "Both are buttons" },
              { name: "position", score: 0.9, detail: "Same place in the product card, 4px lower" },
              { name: "text_match", score: 0.55, detail: "'Add to cart' vs 'Add to bag'" },
            ],
            confidence: 0.82,
            classification: "cosmetic",
            status: "pending",
            policy: "review",
          },
        ],
      });
      step(ctx, {
        index: 2,
        kind: "expect",
        text: "The cart shows 1 item",
        durationMs: 80,
        checks: [
          {
            expectation: "The cart shows 1 item",
            description: "The cart badge shows '1'",
            code: "await expect(page.getByTestId('cart-count')).toHaveText('1');",
            kind: "element_state",
            passed: true,
            expected: "'1'",
            actual: "'1'",
          },
        ],
      });
      webArtifacts(ctx);
      f.emit(
        {
          type: "decision.made",
          testId,
          attempt: 1,
          decision: {
            id: nextId(ctx, "d"),
            task: "heal_class",
            answer: "cosmetic",
            confidence: 0.8,
            source: "rules",
            latencyMs: 1,
            escalated: false,
          },
        },
        5,
      );
      return "passed";
    });
    f.emit(
      {
        type: "test.finished",
        testId,
        verdict: "healed",
        decidedBy: [{ kind: "check", attempt: 1, checkId: "c1" }],
        headline:
          "Step 2 was repaired: the 'Add to cart' button is now 'Add to bag'. Review the fix.",
        checkedSummary: ["The cart badge showed '1'."],
        recentAi: { runs: 10, calls: 1 },
      },
      10,
    );
    f.emit({ type: "run.finished" }, 50);
  },

  "failed-product-bug"(f) {
    runStarted(f, {
      git: {
        branch: "feature/discounts",
        commit: "9b8a7c6d5e4f30211203f4e5d6c7b8a9e0f1a2b3",
        pr: 42,
      },
    });
    const testId = startTest(
      f,
      "tests/checkout/discount-code.md",
      "Discount code takes 10% off",
      ["checkout"],
      CHROMIUM,
    );
    const failing = (ctx: Ctx) => {
      step(ctx, {
        index: 0,
        text: "Open the cart with 'Canvas Tote' in it",
        postState: { status: "verified", expected: "URL is /cart", observed: "/cart" },
        durationMs: 690,
        settledMs: 510,
      });
      step(ctx, {
        index: 1,
        text: "Apply the discount code 'SAVE10'",
        locator: { used: "primary", value: "getByLabel('Discount code')" },
        postState: {
          status: "verified",
          expected: "discount row appears",
          observed: "discount row 'SAVE10'",
        },
        durationMs: 480,
        settledMs: 300,
      });
      step(ctx, {
        index: 2,
        kind: "expect",
        text: "The order total is $90.00",
        status: "failed",
        durationMs: 5000,
        error: "Expected order total '$90.00', found '$100.00'",
        checks: [
          {
            expectation: "The order total is $90.00",
            description: "The order total shows '$90.00'",
            code: "await expect(page.getByTestId('order-total')).toHaveText('$90.00');",
            kind: "text",
            passed: false,
            expected: "'$90.00'",
            actual: "'$100.00'",
          },
        ],
      });
      webArtifacts(ctx, { console: "[warn] discount SAVE10 applied: 0%\n" });
      return "failed" as const;
    };
    attempt(f, testId, 1, failing);
    const last = attempt(f, testId, 2, failing);
    const cause = {
      id: nextId(last, "d"),
      task: "failure_cause",
      answer: "product_bug",
      confidence: 0.97,
      source: "rules",
      latencyMs: 1,
      escalated: false,
    };
    f.emit({ type: "decision.made", testId, attempt: 2, decision: cause }, 5);
    f.emit(
      {
        type: "test.finished",
        testId,
        verdict: "failed",
        decidedBy: [
          { kind: "check", attempt: 1, checkId: "c1" },
          { kind: "check", attempt: 2, checkId: "c1" },
        ],
        failureCause: "product_bug",
        failureEvidence: [
          { kind: "check", attempt: 2, checkId: "c1" },
          { kind: "artifact", path: runLayout.screenshot(testId, 2, 2, "after") },
          { kind: "decision", attempt: 2, decisionId: cause.id },
        ],
        headline: "Expected order total '$90.00', found '$100.00'",
        checkedSummary: ["The order total did not show '$90.00' (it showed '$100.00')."],
        recentAi: { runs: 20, calls: 0 },
      },
      10,
    );
    guestCheckout(f);
    f.emit({ type: "run.finished" }, 50);
  },

  flaky(f) {
    runStarted(f, { trigger: "schedule" });
    searchProducts(f, true);
    f.emit({ type: "run.finished" }, 50);
  },

  "blocked-missing-secret"(f) {
    runStarted(f, {});
    const testId = startTest(
      f,
      "tests/admin/refund-order.md",
      "Admin can refund an order",
      ["admin"],
      CHROMIUM,
    );
    f.emit(
      {
        type: "test.finished",
        testId,
        verdict: "blocked",
        decidedBy: [
          {
            kind: "blocked",
            reason: "missing_secret",
            message:
              "Secret ADMIN_PASSWORD is not set for environment 'staging'. Add ADMIN_PASSWORD=<value> to .env.staging.",
          },
        ],
        failureCause: "blocked",
        headline: "Blocked: secret ADMIN_PASSWORD is not set for staging",
      },
      5,
    );
    searchProducts(f);
    f.emit({ type: "run.finished" }, 50);
  },

  "blocked-budget-exceeded"(f) {
    runStarted(f, { environment: "local", trigger: "cli", mode: "rerecord", git: null });
    const testId = startTest(
      f,
      "tests/account/sign-up.md",
      "Sign up for a new account",
      ["account"],
      CHROMIUM,
    );
    const planner = (tokens: [number, number], costUsd: number, latencyMs: number) => ({
      role: "planner",
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: { input: tokens[0], output: tokens[1], cached: 0, cacheWrite: 0 },
      costUsd,
      latencyMs,
    });
    attempt(f, testId, 1, (ctx) => {
      step(ctx, {
        index: 0,
        text: "Open the sign-up page",
        recovery: "none",
        postState: { status: "verified", expected: "URL is /signup", observed: "/signup" },
        durationMs: 900,
        settledMs: 610,
        modelCalls: [planner([98_000, 1_400], 0.41, 3900), planner([91_000, 1_200], 0.38, 3500)],
      });
      step(ctx, {
        index: 1,
        text: "Fill the form with a new user {email}",
        recovery: "none",
        locator: { used: "primary", value: "getByLabel('Email')" },
        postState: { status: "verified", expected: "email field has a value", observed: "filled" },
        durationMs: 1200,
        settledMs: 150,
        modelCalls: [planner([70_000, 900], 0.29, 3100)],
      });
      step(ctx, {
        index: 2,
        text: "Submit the form",
        status: "blocked",
        recovery: "none",
        durationMs: 5,
        error: "Run budget of $1.00 reached ($1.08 spent)",
        modelCalls: [
          {
            role: "planner",
            provider: null,
            model: null,
            costUsd: 0,
            attempts: 0,
            latencyMs: 0,
            outcome: "budget_exceeded",
          },
        ],
      });
      webArtifacts(ctx);
      return "blocked";
    });
    f.emit(
      {
        type: "test.finished",
        testId,
        verdict: "blocked",
        decidedBy: [
          {
            kind: "blocked",
            reason: "budget_exceeded",
            message:
              "The run budget of $1.00 was reached ($1.08 spent). Raise run.budget.maxPerRunUsd or run in replay mode.",
          },
        ],
        failureCause: "blocked",
        headline: "Blocked: the run budget of $1.00 was reached at step 3",
      },
      10,
    );
    f.emit({ type: "run.finished" }, 50);
  },

  android(f) {
    runStarted(f, { target: "android", trigger: "cloud", git: null });
    const matrix = { target: "android", androidVersion: "14", device: "Pixel 7" };
    const testId = startTest(
      f,
      "tests/android/login.md",
      "Log in and see the home feed",
      ["android", "smoke"],
      matrix,
    );
    attempt(f, testId, 1, (ctx) => {
      step(ctx, {
        index: 0,
        text: "Launch the app",
        postState: {
          status: "verified",
          expected: "screen MainActivity",
          observed: "MainActivity",
        },
        durationMs: 2400,
        settledMs: 1800,
      });
      step(ctx, {
        index: 1,
        text: "Enter {email} as the email",
        locator: { used: "primary", value: "resource-id=com.demoshop:id/email" },
        postState: { status: "verified", expected: "field has text", observed: "field has text" },
        durationMs: 640,
        settledMs: 120,
      });
      step(ctx, {
        index: 2,
        text: "Enter {password} as the password",
        locator: { used: "fallback", value: "text=Password" },
        postState: { status: "verified", expected: "field has text", observed: "field has text" },
        durationMs: 610,
        settledMs: 110,
      });
      step(ctx, {
        index: 3,
        text: "Tap 'Log in'",
        locator: { used: "primary", value: "content-desc=Log in" },
        postState: { status: "verified", expected: "screen changes", observed: "HomeActivity" },
        durationMs: 1900,
        settledMs: 1400,
      });
      step(ctx, {
        index: 4,
        kind: "expect",
        text: "The home feed is shown",
        durationMs: 300,
        checks: [
          {
            expectation: "The home feed is shown",
            description: "The screen shows the 'Home' title and the product feed",
            code: "- assertVisible:\n    id: com.demoshop:id/home_feed\n- assertVisible: Home",
            kind: "screen",
            passed: true,
            expected: "HomeActivity with home_feed visible",
            actual: "HomeActivity with home_feed visible",
          },
        ],
      });
      f.artifact("video", runLayout.attemptFile(testId, 1, "video"), "video/webm", WEBM, ctx);
      f.artifact(
        "logcat",
        runLayout.attemptFile(testId, 1, "logcat"),
        "text/plain",
        "09-26 10:02:11.204  4120  4120 I ActivityManager: Displayed com.demoshop/.HomeActivity\n",
        ctx,
      );
      return "passed";
    });
    f.emit(
      {
        type: "test.finished",
        testId,
        verdict: "passed",
        decidedBy: [{ kind: "check", attempt: 1, checkId: "c1" }],
        checkedSummary: ["The screen showed the 'Home' title and the product feed."],
        recentAi: { runs: 12, calls: 0 },
      },
      10,
    );
    f.emit({ type: "run.finished" }, 50);
  },
};

const STARTS: Record<string, string> = {
  "all-passed": "2026-09-26T09:00:00.000Z",
  healed: "2026-09-26T09:10:00.000Z",
  "failed-product-bug": "2026-09-26T09:20:00.000Z",
  flaky: "2026-09-26T09:30:00.000Z",
  "blocked-missing-secret": "2026-09-26T09:40:00.000Z",
  "blocked-budget-exceeded": "2026-09-26T09:50:00.000Z",
  android: "2026-09-26T10:00:00.000Z",
};

for (const [name, build] of Object.entries(fixtures)) {
  const dir = `${ROOT}${name}`;
  if (existsSync(dir)) {
    if (!force) {
      console.log(`skip ${name} (exists)`);
      continue;
    }
    rmSync(dir, { recursive: true });
  }
  const f = new Fixture(dir, STARTS[name] as string, name);
  build(f);
  f.writer.finish();
  console.log(`wrote ${name}`);
}

// A run from a future minor version: extra fields everywhere and an unknown
// event type. Readers of 1.0 must still parse it.
const future = `${ROOT}_future-minor`;
if (!existsSync(future) || force) {
  rmSync(future, { recursive: true, force: true });
  const source = `${ROOT}all-passed`;
  const copy = (rel: string, edit: (text: string) => string) => {
    const target = `${future}/${rel}`;
    rmSync(target, { force: true });
    const text = readFileSync(`${source}/${rel}`, "utf8");
    writeFileSync(target, edit(text));
  };
  const { cpSync } = await import("node:fs");
  cpSync(source, future, { recursive: true });
  const bump = (doc: Json) => ({
    ...doc,
    contractVersion: "1.9",
    newTopLevelField: { anything: true },
  });
  copy(
    "run.json",
    (text) => `${JSON.stringify({ ...bump(JSON.parse(text)), region: "eu-west" }, null, 2)}\n`,
  );
  const run = JSON.parse(readFileSync(`${source}/run.json`, "utf8")) as {
    tests: { result: string }[];
  };
  for (const { result } of run.tests) {
    copy(result, (text) => {
      const doc = bump(JSON.parse(text)) as Json & { attempts: Json[] };
      const attempts = doc.attempts.map((a) => ({
        ...a,
        steps: (a.steps as Json[]).map((s) => ({ ...s, accessibilityWarnings: 0 })),
      }));
      return `${JSON.stringify({ ...doc, attempts }, null, 2)}\n`;
    });
  }
  copy("events.ndjson", (text) => {
    const lines = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Json);
    const first = { ...(lines[0] as Json), contractVersion: "1.9", region: "eu-west" };
    const note = {
      seq: 1,
      ts: (lines[0] as Json).ts,
      runId: (lines[0] as Json).runId,
      type: "note.added",
      text: "from a newer engine",
    };
    const rest = lines.slice(1).map((e) => ({ ...e, seq: Number(e.seq) + 1 }));
    return `${[first, note, ...rest].map((e) => JSON.stringify(e)).join("\n")}\n`;
  });
  console.log("wrote _future-minor");
}
