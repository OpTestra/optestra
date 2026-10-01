import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestResult } from "@optestra/contract";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, describe, expect, it } from "vitest";
import {
  ARTIFACT_LINK_PREFIX,
  buildModel,
  buildResultsSummary,
  fillArtifactLinks,
  formatTerminal,
  formatTestLine,
  GITHUB_COMMENT_LIMIT,
  type RunData,
  renderHtmlReport,
  renderJsonSummary,
  renderJunit,
  renderMarkdownSummary,
  resultsSummaryJsonSchema,
} from "./index.js";
import {
  latestRunDir,
  loadRunData,
  runsDir,
  shouldUseColor,
  writeHtmlReport,
} from "./node/index.js";

const FIXTURES = fileURLToPath(new URL("../../contract/fixtures/v1/", import.meta.url));
const GOLDEN = fileURLToPath(new URL("../golden/", import.meta.url));
const XSD = fileURLToPath(new URL("../test-support/junit.xsd", import.meta.url));
const ALL = readdirSync(FIXTURES);
// Neutral names keep the golden files free of product-name literals (brand:check).
const NAMES = { productName: "Product", cliName: "product" };

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "report-"));
  dirs.push(dir);
  return dir;
};

function load(dir: string): RunData {
  const loaded = loadRunData(dir);
  if (!loaded.ok) throw new Error(`cannot read ${dir}`);
  return loaded.data;
}

const outputs = (data: RunData) => ({
  html: renderHtmlReport(data, NAMES),
  junit: renderJunit(data),
  json: renderJsonSummary(data),
  markdown: renderMarkdownSummary(data, NAMES),
  terminal: `${formatTerminal(data)}\n`,
});

describe.each(ALL)("fixture %s", (name) => {
  const data = load(join(FIXTURES, name));
  const out = outputs(data);

  it("matches the golden output in every format", async () => {
    await expect(out.html).toMatchFileSnapshot(`${GOLDEN}${name}/index.html`);
    await expect(out.junit).toMatchFileSnapshot(`${GOLDEN}${name}/junit.xml`);
    await expect(out.json).toMatchFileSnapshot(`${GOLDEN}${name}/summary.json`);
    await expect(out.markdown).toMatchFileSnapshot(`${GOLDEN}${name}/summary.md`);
    await expect(out.terminal).toMatchFileSnapshot(`${GOLDEN}${name}/terminal.txt`);
  });

  it("writes JSON that validates against its schema", () => {
    const validate = new Ajv2020({ strict: false }).compile(resultsSummaryJsonSchema());
    const ok = validate(JSON.parse(out.json));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("writes JUnit with one testcase per test and the right outcome elements", () => {
    const cases = out.junit.match(/<testcase /g) ?? [];
    expect(cases).toHaveLength(data.run.tests.length);
    expect((out.junit.match(/<failure /g) ?? []).length).toBe(data.run.totals.failed);
    expect((out.junit.match(/<skipped /g) ?? []).length).toBe(data.run.totals.blocked);
    expect((out.junit.match(/name="flaky" value="true"/g) ?? []).length).toBe(
      data.run.totals.flaky,
    );
    expect((out.junit.match(/name="healed" value="true"/g) ?? []).length).toBe(
      data.run.totals.healed,
    );
  });

  // xmllint ships with macOS and the Ubuntu runners; skipped where it's missing (Windows).
  const xmllint = spawnSync("xmllint", ["--version"]).status === 0;
  it.runIf(xmllint)("writes JUnit that validates against the JUnit XSD", () => {
    const file = join(tempDir(), "junit.xml");
    writeFileSync(file, out.junit);
    const result = spawnSync("xmllint", ["--noout", "--schema", XSD, file], { encoding: "utf8" });
    expect(result.stderr).toContain("validates");
    expect(result.status).toBe(0);
  });

  it("links and loads nothing outside the run folder", () => {
    const refs = [...out.html.matchAll(/\s(?:src|href|poster|action|data)="([^"]*)"/g)].map(
      (m) => m[1] ?? "",
    );
    for (const ref of refs) {
      expect(ref, ref).not.toMatch(/^[a-z][a-z0-9+.-]*:|^\/\//i);
      expect(ref, ref).not.toMatch(/^\//);
    }
    const style = out.html.slice(out.html.indexOf("<style>"), out.html.indexOf("</style>"));
    expect(style).not.toMatch(/url\(|@import|@font-face/i);
    expect(out.html).not.toMatch(/<link\b|<iframe\b|<object\b|<embed\b|<base\b/i);
    expect(out.html).not.toMatch(/<script\b[^>]*\ssrc=/i);
  });

  it("leads every failure with its headline", () => {
    const model = buildModel(data);
    for (const test of model.tests.filter(
      (t) => t.verdict !== "passed" && t.verdict !== "healed",
    )) {
      expect(test.headline).toBeTruthy();
      expect(out.html).toContain(test.headline?.replace(/'/g, "&#39;"));
    }
  });
});

describe("html report", () => {
  it("shows the failure's headline and screenshot before anything else", () => {
    const html = renderHtmlReport(load(join(FIXTURES, "failed-product-bug")), NAMES);
    const main = html.slice(html.indexOf("<main>"));
    const headline = main.indexOf("Expected order total &#39;$90.00&#39;, found &#39;$100.00&#39;");
    const shot = main.indexOf('src="tests/tests__checkout__discount-code/2/steps/2-after.png"');
    expect(headline).toBeGreaterThan(0);
    expect(shot).toBeGreaterThan(headline);
    expect(shot).toBeLessThan(main.indexOf('id="summary-h"'));
  });

  it("links artifacts by file URL when the run folder has no relative path (another drive)", () => {
    const html = renderHtmlReport(load(join(FIXTURES, "failed-product-bug")), {
      ...NAMES,
      artifactBase: "file:///D:/runs/r%201",
    });
    expect(html).toContain(
      'src="file:///D:/runs/r%201/tests/tests__checkout__discount-code/2/steps/2-after.png"',
    );
  });

  it("keeps soft-check warnings apart from failures", () => {
    const data = load(join(FIXTURES, "all-passed"));
    const test = structuredClone(data.tests[0]) as TestResult;
    const attempt = test.attempts.at(-1);
    attempt?.checks.push({
      id: "soft1",
      stepIndex: null,
      expectation: "The hero image looks sharp",
      generated: { description: "An AI model judged the hero image", code: "" },
      kind: "screen",
      soft: true,
      passed: false,
      expected: "sharp",
      actual: "slightly blurry",
    });
    const model = buildModel({ ...data, tests: [test, ...data.tests.slice(1)] });
    expect(model.softWarnings).toHaveLength(1);
    expect(model.groups).toEqual([]);
    const html = renderHtmlReport({ ...data, tests: [test, ...data.tests.slice(1)] }, NAMES);
    expect(html).toContain("Soft-check warnings");
    expect(html).not.toContain('id="failures"');
  });

  it("groups tests that fail the same way (DIA-4)", () => {
    const data = load(join(FIXTURES, "failed-product-bug"));
    const failed = data.tests.find((t) => t.verdict === "failed") as TestResult;
    const refs = data.run.tests.filter((t) => t.verdict === "failed");
    const copies = [1, 2, 3].map((n) => ({ ...failed, testId: `${failed.testId}-${n}` }));
    const run = {
      ...data.run,
      tests: [
        ...data.run.tests,
        ...copies.map((c, i) => ({
          ...(refs[0] as (typeof refs)[0]),
          testId: c.testId,
          name: `Copy ${i}`,
        })),
      ],
    };
    const model = buildModel({ run, tests: [...data.tests, ...copies] });
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.tests).toHaveLength(4);
    expect(renderHtmlReport({ run, tests: [...data.tests, ...copies] }, NAMES)).toContain(
      "affects 4 tests",
    );
  });

  it("says when AI calls went through the user's subscription", () => {
    const data = load(join(FIXTURES, "healed"));
    const test = structuredClone(data.tests[0]) as TestResult;
    for (const call of test.attempts.flatMap((a) => a.modelCalls)) call.billing = "subscription";
    const html = renderHtmlReport({ ...data, tests: [test] }, NAMES);
    expect(html).toContain("1 call via your subscription");
    expect(renderMarkdownSummary({ ...data, tests: [test] }, NAMES)).toContain(
      "via your subscription",
    );
  });

  it("rewrites artifact links when written outside the run folder", () => {
    const run = join(tempDir(), "run");
    cpSync(join(FIXTURES, "failed-product-bug"), run, { recursive: true });
    const out = join(tempDir(), "out");
    const path = writeHtmlReport(run, load(run), { outDir: out, ...NAMES });
    const html = readFileSync(path, "utf8");
    expect(html).toMatch(
      /src="\.\.\/[^"]*\/run\/tests\/tests__checkout__discount-code\/2\/steps\/2-after\.png"/,
    );
  });

  it("escapes contract text", () => {
    const data = load(join(FIXTURES, "failed-product-bug"));
    const run = structuredClone(data.run);
    run.project = `<script>alert(1)</script>"'`;
    const html = renderHtmlReport({ ...data, run }, NAMES);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;");
  });
});

/** A run with `n` failing tests, each failing a different way. */
function hugeRun(n: number): RunData {
  const data = load(join(FIXTURES, "failed-product-bug"));
  const failed = data.tests.find((t) => t.verdict === "failed") as TestResult;
  const ref = data.run.tests.find((t) => t.verdict === "failed");
  const tests = Array.from({ length: n }, (_, i) => ({
    ...failed,
    testId: `t${i}`,
    name: `Checkout variant ${i} ${"with a long name ".repeat(4)}`,
    headline: `Expected order total '$${i}.00', found '$${i + 1}.00' ${"and more detail ".repeat(6)}`,
  }));
  const refs = tests.map((t) => ({
    ...(ref as NonNullable<typeof ref>),
    testId: t.testId,
    name: t.name,
    headline: t.headline,
  }));
  return {
    run: {
      ...data.run,
      tests: refs,
      totals: { tests: n, passed: 0, healed: 0, failed: n, flaky: 0, blocked: 0 },
    },
    tests,
  };
}

describe("markdown summary", () => {
  it("stays under the GitHub comment limit on a huge run", () => {
    const data = hugeRun(5000);
    const text = renderMarkdownSummary(data, NAMES);
    expect(text.length).toBeLessThanOrEqual(60_000);
    expect(text.length).toBeLessThan(GITHUB_COMMENT_LIMIT);
    expect(text).toContain("| 0 | 0 | 5000 | 0 | 0 |");
    expect(text).toContain("more issues in the full report");
    expect(text).toContain("See the full report");
    expect((text.match(/<details>/g) ?? []).length).toBe((text.match(/<\/details>/g) ?? []).length);
  });

  it("honours a small cap and still names the full report", () => {
    const text = renderMarkdownSummary(hugeRun(50), { ...NAMES, maxLength: 1500 });
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text).toContain("See the full report");
    expect((text.match(/<details>/g) ?? []).length).toBe((text.match(/<\/details>/g) ?? []).length);
  });

  it("uses artifact placeholders the Action can fill in", () => {
    const data = load(join(FIXTURES, "failed-product-bug"));
    const text = renderMarkdownSummary(data, NAMES);
    expect(text).toContain(
      `[screenshot](${ARTIFACT_LINK_PREFIX}tests/tests__checkout__discount-code/2/steps/2-after.png)`,
    );
    const filled = fillArtifactLinks(text, (path) => `https://example.test/a/${path}`);
    expect(filled).toContain(
      "[screenshot](https://example.test/a/tests/tests__checkout__discount-code/2/steps/2-after.png)",
    );
    expect(
      renderMarkdownSummary(data, { ...NAMES, reportUrl: "https://example.test/r" }),
    ).toContain("[See the full report](https://example.test/r)");
  });

  it("cannot be turned into HTML, links or mentions by contract text", () => {
    const data = load(join(FIXTURES, "failed-product-bug"));
    const tests = structuredClone(data.tests) as TestResult[];
    const failed = tests.find((t) => t.verdict === "failed") as TestResult;
    failed.headline = "<img src=x onerror=alert(1)> [click](https://evil.test) @octocat | x";
    const text = renderMarkdownSummary({ ...data, tests }, NAMES);
    expect(text).not.toContain("<img");
    expect(text).not.toContain("[click](");
    expect(text).not.toMatch(/@octocat/);
  });
});

describe("json summary", () => {
  it("gives agents the failing check, file and step", () => {
    const summary = buildResultsSummary(load(join(FIXTURES, "failed-product-bug")));
    const failed = summary.tests.find((t) => t.verdict === "failed");
    expect(summary.exitCode).toBe(1);
    expect(failed).toMatchObject({
      file: "tests/checkout/discount-code.md",
      cause: "product_bug",
      failingCheck: { checkId: "c1", expected: "'$90.00'", actual: "'$100.00'", attempt: 2 },
      failingStep: { index: 2, text: "The order total is $90.00" },
    });
  });

  it("carries heal proposals with their signals", () => {
    const summary = buildResultsSummary(load(join(FIXTURES, "healed")));
    expect(summary.tests[0]?.heals[0]).toMatchObject({
      confidence: 0.82,
      classification: "cosmetic",
    });
    expect(summary.tests[0]?.heals[0]?.signals.map((s) => s.name)).toContain("role_match");
  });
});

describe("terminal output", () => {
  it("prints one plain line per test", () => {
    const line = formatTestLine({
      name: "Checkout",
      verdict: "failed",
      durationMs: 1234,
      aiCalls: 2,
      costUsd: 0.5,
      headline: "Boom",
    });
    expect(line).toMatch(/^ {2}FAILED\s+1\.2s\s+2 AI\s+\$0\.5000 {2}Checkout\n\s+Boom$/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for ANSI codes
    expect(line).not.toMatch(/\u001b\[/);
  });

  it("colours only when asked and strips control characters from contract text", () => {
    const line = formatTestLine(
      { name: "A\u001b[2Jb", verdict: "passed", durationMs: 1, aiCalls: 0, costUsd: 0 },
      { color: true },
    );
    expect(line).toContain("\u001b[32m");
    expect(line).toContain("A[2Jb");
  });

  it("decides colour from the stream and env", () => {
    expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(shouldUseColor({ isTTY: true }, { TERM: "dumb" })).toBe(false);
    expect(shouldUseColor({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
  });
});

describe("latest run folder", () => {
  it("picks the newest finished run", () => {
    const project = tempDir();
    expect(latestRunDir(project)).toBeUndefined();
    const older = "01M3EFN0J0FQBKEWDYW4JQ19PW";
    const newer = "01M3EGSME0Y0HFX5XMJ3B771ER";
    const unfinished = "01M3EGSME0Y0HFX5XMJ3B771ZZ";
    cpSync(join(FIXTURES, "healed"), join(runsDir(project), older), { recursive: true });
    cpSync(join(FIXTURES, "flaky"), join(runsDir(project), newer), { recursive: true });
    mkdirSync(join(runsDir(project), unfinished), { recursive: true });
    mkdirSync(join(runsDir(project), "not-a-run"), { recursive: true });
    expect(latestRunDir(project)).toBe(join(runsDir(project), newer));
  });
});

describe("no new leaks (guarantee 4)", () => {
  const SECRET = "sk_PLANTED_7f3a9c";

  it("renders only document data: secrets in logs, traces, events and env never appear", () => {
    for (const name of ALL) {
      const original = load(join(FIXTURES, name));
      const dir = join(tempDir(), name);
      cpSync(join(FIXTURES, name), dir, { recursive: true });
      // Plant the secret in every non-document file, keeping sizes so the run still reads cleanly.
      const plant = (path: string) => {
        const size = statSync(path).size;
        writeFileSync(path, SECRET.repeat(Math.ceil(size / SECRET.length) + 1).slice(0, size));
      };
      const walk = (d: string): void => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const path = join(d, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (!entry.name.endsWith(".json") && entry.name !== "events.ndjson") plant(path);
        }
      };
      walk(dir);
      const events = join(dir, "events.ndjson");
      writeFileSync(
        events,
        `${readFileSync(events, "utf8").trimEnd()}\n${JSON.stringify({ seq: 9999, ts: original.run.finishedAt, runId: original.run.runId, type: "log", level: "info", message: `token ${SECRET}` })}\n`,
      );
      process.env.PLANTED_SECRET = SECRET;
      try {
        const planted = load(dir);
        const before = outputs(original);
        const after = outputs(planted);
        for (const [format, text] of Object.entries(after)) {
          expect(text, `${name} ${format}`).not.toContain(SECRET);
          expect(text, `${name} ${format}`).toBe(before[format as keyof typeof before]);
        }
      } finally {
        delete process.env.PLANTED_SECRET;
      }
    }
  });
});
