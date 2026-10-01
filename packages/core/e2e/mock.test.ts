import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { ENV_PREFIX } from "@optestra/config";
import { startShop, type Variant } from "@optestra/fixture-shop";
import { afterAll, describe, expect, it } from "vitest";
import { type RunTestsOptions, runTests } from "../src/run/runner.js";

// Network mocking (ENV-4) on the real shop: a Mock: step makes the projects API
// answer 500, and the app shows its own error; reports mark the mocked answer.
// Recorded traffic (--record-network) replays the API's answers later, so a
// build whose API loses the project still sees it: full determinism.

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const MOCKED = `---
name: A server error while saving shows an error
start: /login
setup:
  - request: POST /__test/seed
---

1. Use: flows/login.test.md
2. Mock: POST /api/projects returns 500 files/error.json
3. Click "Create project"
4. Fill "Project name" with Q3 roadmap
5. Click "Create"
6. Expect: a message says "Couldn't create project. Please try again."
`;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "mock-e2e-"));
  dirs.push(dir);
  cpSync(join(SHOP, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(SHOP, "tests"), join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests/save-error.test.md"), MOCKED);
  writeFileSync(join(dir, "tests/files/error.json"), '{ "error": "database is down" }\n');
  // Same steps as create-project: its recording replays them.
  cpSync(
    join(dir, "tests", brand.dataDirName, "tests__create-project.steps.json"),
    join(dir, "tests", brand.dataDirName, "tests__save-error.steps.json"),
  );
  return dir;
}

async function run(
  dir: string,
  variant: Variant,
  tests: string[],
  extra: Partial<RunTestsOptions> = {},
) {
  const shop = await startShop({ variant, port: 0 });
  try {
    return await runTests({
      projectDir: dir,
      tests: tests.map((t) => join(dir, t)),
      mode: "normal",
      models: null,
      retries: 0,
      video: false,
      generateSpecs: false,
      evidence: "full",
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

describe("network mocking on the shop", () => {
  it("a mocked 500 is shown as the app's own error, and the attempt says which answer was mocked", async () => {
    const dir = project();
    const result = await run(dir, "correct", ["tests/save-error.test.md"]);
    const test = result.tests[0];
    expect(test?.verdict, test?.headline ?? "").toBe("passed");
    expect(test?.attempts[0]?.steps.find((s) => s.text.startsWith("Mock:"))).toMatchObject({
      status: "passed",
      text: "Mock: POST /api/projects returns 500 files/error.json",
    });
    expect(test?.attempts[0]?.mocks).toEqual([
      {
        source: "step",
        method: "POST",
        url: "/api/projects",
        status: 500,
        hits: 1,
        stepIndex: 5,
        file: "tests/files/error.json",
      },
    ]);
  });

  it("a mock only applies on the allowed domains", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "tests/save-error.test.md"),
      MOCKED.replace("POST /api/projects", "POST https://elsewhere.example.com/api/projects"),
    );
    const result = await run(dir, "correct", ["tests/save-error.test.md"]);
    expect(result.tests[0]?.verdict).toBe("blocked");
    expect(result.tests[0]?.headline).toMatch(/elsewhere\.example\.com is not an allowed domain/);
  });

  it("recorded traffic replays the API's answers: a build that loses projects still sees them", async () => {
    const dir = project();
    const file = join(dir, "tests", brand.dataDirName, "tests__create-project.network.har");
    // The broken build forgets the project after the reload.
    const live = await run(dir, "broken-not-saved", ["tests/create-project.test.md"]);
    expect(live.tests[0]?.verdict).toBe("failed");
    // Record on the correct build.
    const recorded = await run(dir, "correct", ["tests/create-project.test.md"], {
      network: "record",
    });
    expect(recorded.tests[0]?.verdict).toBe("passed");
    expect(existsSync(file)).toBe(true);
    const har = JSON.parse(readFileSync(file, "utf8")) as {
      log: {
        entries: { request: { method: string; url: string }; response: { headers: unknown[] } }[];
      };
    };
    expect(
      har.log.entries.map((e) => `${e.request.method} ${new URL(e.request.url).pathname}`),
    ).toContain("POST /api/projects");
    // Only the content type is kept: no cookies or tokens in the file.
    for (const entry of har.log.entries)
      expect(entry.response.headers).toEqual([{ name: "content-type", value: expect.any(String) }]);
    // Replayed against the broken build: the API's answers come from the file.
    const replayed = await run(dir, "broken-not-saved", ["tests/create-project.test.md"]);
    expect(replayed.tests[0]?.verdict, replayed.tests[0]?.headline ?? "").toBe("passed");
    expect(
      replayed.tests[0]?.attempts[0]?.mocks?.find((m) => m.source === "recorded"),
    ).toMatchObject({
      hits: expect.any(Number),
      file: `tests/${brand.dataDirName}/tests__create-project.network.har`,
    });
    // --live-network: the app again.
    const liveAgain = await run(dir, "broken-not-saved", ["tests/create-project.test.md"], {
      network: "live",
    });
    expect(liveAgain.tests[0]?.verdict).toBe("failed");
  });
});
