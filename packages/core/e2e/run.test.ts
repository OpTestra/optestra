import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import { readRun } from "@testament/contract/node";
import { startShop, type Variant } from "@testament/fixture-shop";
import { afterAll, describe, expect, it } from "vitest";
import { scriptedModels } from "../src/author/test-kit.test-support.js";
import { type RunTestsOptions, runTests } from "../src/run/runner.js";

// runTests on the real shop, in a real browser, from the committed recordings:
// replay with no AI, verdicts, causes and the contract run folder.

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const PASSWORD = "shop-demo-pass";
const projects: string[] = [];

afterAll(() => {
  for (const dir of projects) rmSync(dir, { recursive: true, force: true });
});

/** A private copy of the shop project with its committed recordings. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "run-e2e-"));
  projects.push(dir);
  cpSync(join(SHOP, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(SHOP, "tests"), join(dir, "tests"), {
    recursive: true,
    filter: (source) => !/\.ts$/.test(source),
  });
  return dir;
}

async function run(
  variant: Variant,
  tests: string[],
  options: Partial<RunTestsOptions> & { env?: Record<string, string | undefined> } = {},
) {
  const dir = project();
  const shop = await startShop({ variant, port: 0 });
  const { models, calls } = scriptedModels(() => ({ text: "the replay must not ask a model" }));
  try {
    const result = await runTests({
      projectDir: dir,
      tests: tests.map((t) => join(dir, "tests", `${t}.test.md`)),
      mode: "replay-only",
      retries: 1,
      video: false,
      generateSpecs: false,
      models,
      beforeAttempt: async ({ attempt, session }) => {
        await session.hookRequest({
          method: "POST",
          target: attempt === 1 ? "/__test/reset?environment=1" : "/__test/reset",
        });
      },
      ...options,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [`${ENV_PREFIX}BASE_URL`]: shop.url,
        SHOP_PASSWORD: PASSWORD,
        ...options.env,
      },
    });
    const byFile = (name: string) => {
      const test = result.tests.find((t) => t.file === `tests/${name}.test.md`);
      if (!test) throw new Error(`no result for ${name}`);
      return test;
    };
    return { result, calls, byFile };
  } finally {
    await shop.stop();
  }
}

describe("runTests on the shop (real browser)", () => {
  it("replays the correct shop with ZERO model calls, even in normal mode, and writes a readable run folder", async () => {
    const { result, calls, byFile } = await run(
      "correct",
      ["create-project", "login", "sort-orders"],
      { mode: "normal", video: true },
    );
    expect(calls).toHaveLength(0);
    expect(result.run.cost.aiCalls).toBe(0);
    expect(result.tests.map((t) => t.verdict)).toEqual(["passed", "passed", "passed"]);
    const create = byFile("create-project");
    expect(create.checkedSummary.length).toBeGreaterThan(3);
    expect(create.attempts[0]?.steps.every((s) => s.status === "passed")).toBe(true);
    expect(
      create.attempts[0]?.steps
        .filter((s) => s.kind === "action")
        .every((s) => s.postState?.status !== "mismatch"),
    ).toBe(true);
    // Evidence: screenshots per step, video + chapters, trace, console, network.
    const kinds = new Set(create.attempts[0]?.artifacts.map((a) => a.kind));
    for (const kind of ["screenshot", "video", "trace", "console", "network", "other"])
      expect(kinds, kind).toContain(kind);
    const read = readRun(result.dir, { verifyArtifacts: true });
    expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(read.run?.totals.passed).toBe(3);
    const chapters = create.attempts[0]?.artifacts.find((a) => a.path.endsWith("chapters.vtt"));
    expect(readFileSync(join(result.dir, chapters?.path ?? ""), "utf8")).toMatch(
      /^WEBVTT\nKind: chapters/,
    );
    // Nothing was authored or compiled: the recordings are untouched.
    expect(result.recorded).toEqual([]);
    // The password typed by the login flow is in no text the run wrote (events, results, logs, HAR).
    const texts = readdirSync(result.dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.(json|ndjson|log|har|vtt)$/.test(e.name))
      .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"));
    expect(texts.length).toBeGreaterThan(5);
    for (const text of texts) expect(text).not.toContain(PASSWORD);
  });

  it("heals the cosmetic build without AI: a re-find and a stored fallback, as pending proposals", async () => {
    const { result, calls, byFile } = await run("cosmetic", ["login", "sort-orders"], {
      mode: "normal",
    });
    expect(calls).toHaveLength(0);
    expect(result.tests.map((t) => t.verdict)).toEqual(["healed", "healed"]);
    const heals = result.tests.flatMap((t) => t.attempts.at(-1)?.heals ?? []);
    expect(
      heals.every((h) => h.status === "pending" && h.changes.every((c) => c.target === "locator")),
    ).toBe(true);
    expect(heals.some((h) => h.diff.includes("re-found from the recorded fingerprint"))).toBe(true);
    expect(heals.some((h) => h.diff.includes("a stored fallback locator"))).toBe(true);
    const login = byFile("login").attempts.at(-1)?.heals[0];
    expect(login?.changes[0]).toMatchObject({
      before: "the button 'Log in'",
      after: "the button 'Sign in'",
    });
    expect(login?.signals.length).toBeGreaterThan(2);
    // Heals are proposals only: the recordings are not changed.
    expect(result.recorded).toEqual([]);
  });

  it("fails the silent-click trap on the click itself: the right element, nothing happened (no heal)", async () => {
    const { byFile } = await run("broken-silent-click", ["create-project"]);
    const test = byFile("create-project");
    expect(test.verdict).toBe("failed");
    expect(test.failureCause).toBe("product_bug");
    expect(test.attempts.every((a) => a.heals.length === 0)).toBe(true);
    const failed = test.attempts.at(-1)?.steps.find((s) => s.status === "failed");
    expect(failed?.text).toBe('Click "Create project"');
    expect(failed?.postState?.status).toBe("mismatch");
    expect(failed?.error).toMatch(/right element was used, but nothing happened/);
  });

  it("reports broken-total's expected vs actual in the headline (DIA-3)", async () => {
    const { byFile } = await run("broken-total", ["billing-zero-due"]);
    const test = byFile("billing-zero-due");
    expect(test.verdict).toBe("failed");
    expect(test.failureCause).toBe("product_bug");
    expect(test.headline).toMatch(/\$0\.00 due today/);
    expect(test.headline).toMatch(/\$29\.00/);
    expect(test.decidedBy[0]?.kind).toBe("check");
    expect(test.failureEvidence.some((e) => e.kind === "artifact")).toBe(true);
  });

  it("marks env-flaky as flaky with cause environment (failed, then passed on the retry)", async () => {
    const { byFile } = await run("env-flaky", ["create-project"]);
    const test = byFile("create-project");
    expect(test.verdict).toBe("flaky");
    expect(test.failureCause).toBe("environment");
    expect(test.attempts.map((a) => a.status)).toEqual(["failed", "passed"]);
  });

  it("fails every login-flow test on broken-login-redirect (never blocked) as one group", async () => {
    const { result } = await run("broken-login-redirect", ["avatar-upload", "declined-card"]);
    expect(result.tests.map((t) => [t.verdict, t.failureCause])).toEqual([
      ["failed", "product_bug"],
      ["failed", "product_bug"],
    ]);
    expect(result.tests[0]?.headline).toMatch(/^Step 1 \(Use: (tests\/)?flows\/login\.test\.md\)/);
    expect(result.groups.filter((g) => g.testIds.length === 2)).toHaveLength(1);
  });

  it("fails every test whose auth profile can't log in, at the login, as one group", async () => {
    const { result } = await run("broken-login-redirect", ["billing-zero-due", "settings-profile"]);
    expect(result.tests.map((t) => [t.verdict, t.failureCause])).toEqual([
      ["failed", "product_bug"],
      ["failed", "product_bug"],
    ]);
    expect(result.tests[0]?.headline).toMatch(
      /^auth: ada: logging in with flows\/login\.test\.md failed/,
    );
    expect(result.groups.filter((g) => g.testIds.length === 2)).toHaveLength(1);
  });

  it("blocks on a disallowed domain and on a missing secret", async () => {
    const domain = await run("correct", ["login"], {
      env: { [`${ENV_PREFIX}ALLOWED_DOMAINS`]: "example.com" },
    });
    expect(domain.byFile("login").verdict).toBe("blocked");
    expect(domain.byFile("login").decidedBy[0]).toMatchObject({
      kind: "blocked",
      reason: "disallowed_domain",
    });
    const secret = await run("correct", ["login"], { env: { SHOP_PASSWORD: undefined } });
    expect(secret.byFile("login").verdict).toBe("blocked");
    expect(secret.byFile("login").decidedBy[0]).toMatchObject({
      kind: "blocked",
      reason: "missing_secret",
    });
    expect(existsSync(secret.result.dir)).toBe(true);
  });
});
