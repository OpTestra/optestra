import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { exitCodeFor } from "@optestra/contract";
import { ENV_PREFIX } from "@optestra/config";
import { startShop, type Variant } from "@optestra/fixture-shop";
import { afterAll, describe, expect, it } from "vitest";
import { type RunTestsOptions, runTests } from "../src/run/runner.js";

// Accessibility warnings (EVD-6) on the real shop: with `accessibility: warn`
// every page a test visits is checked with axe-core, once per page. The
// cosmetic build's settings page has a low-contrast hint (a known WCAG AA
// violation): a warning on the attempt, never a failure.

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// The settings-profile test's first step (and its recording), which the
// cosmetic build doesn't reword: it passes without AI.
const OPEN = `---
name: The settings page opens
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

1. Go to the settings page
`;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "a11y-e2e-"));
  dirs.push(dir);
  cpSync(join(SHOP, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(SHOP, "tests"), join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests/settings-open.test.md"), OPEN);
  const data = join(dir, "tests", brand.dataDirName);
  const recording = JSON.parse(
    readFileSync(join(data, "tests__settings-profile.steps.json"), "utf8"),
  ) as { steps: unknown[] };
  writeFileSync(
    join(data, "tests__settings-open.steps.json"),
    JSON.stringify({
      ...recording,
      testId: "tests__settings-open",
      testPath: "tests/settings-open.test.md",
      steps: recording.steps.slice(0, 1),
      checks: [],
    }),
  );
  return dir;
}

async function run(
  dir: string,
  variant: Variant,
  test: string,
  extra: Partial<RunTestsOptions> = {},
) {
  const shop = await startShop({ variant, port: 0 });
  try {
    return await runTests({
      projectDir: dir,
      tests: [join(dir, test)],
      mode: "normal",
      models: null,
      retries: 0,
      video: false,
      generateSpecs: false,
      evidence: "failures",
      ...extra,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [`${ENV_PREFIX}BASE_URL`]: shop.url,
        SHOP_PASSWORD: "shop-demo-pass",
      },
    });
  } finally {
    await shop.stop();
  }
}

describe("accessibility warnings on the shop", () => {
  it("off by default: nothing is checked", async () => {
    const result = await run(project(), "correct", "tests/settings-profile.test.md");
    expect(result.tests[0]?.verdict).toBe("passed");
    expect(result.tests[0]?.attempts[0]?.accessibility).toBeUndefined();
  });

  it("a known violation is a warning on its page, and the test still passes", async () => {
    const result = await run(project(), "cosmetic", "tests/settings-open.test.md", {
      accessibility: "warn",
    });
    const test = result.tests[0];
    const report = test?.attempts.at(-1)?.accessibility;
    console.log(`a11y: ${report?.pages} pages in ${report?.ms} ms`);
    // The cosmetic build moved the link: healed without AI, a pass either way.
    expect(["passed", "healed"], test?.headline ?? "").toContain(test?.verdict);
    expect(report?.standard).toBe("wcag2aa");
    expect(report?.pages).toBeGreaterThanOrEqual(1);
    const contrast = report?.violations.filter((v) => v.rule === "color-contrast") ?? [];
    expect(contrast).toEqual([
      expect.objectContaining({ page: "/settings", impact: "serious", nodes: expect.any(Number) }),
    ]);
    expect(exitCodeFor(result.run, { healedCountsAsPass: true })).toBe(0);
  });
});
