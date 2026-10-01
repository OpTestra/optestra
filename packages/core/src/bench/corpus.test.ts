import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeCorpus,
  descriptionOf,
  estimateCorpus,
  frontMatterOf,
  loadCorpus,
  loadStyles,
} from "./corpus.js";

// The real-developer corpus (COST-0), statically: coverage, the gold front
// matter, the assertions that catch each variant's bug, and what lint and the
// phrase rules make of every style. No browser, no model. The run itself is
// e2e/bench.test.ts (the tidy control through the scripted path).

const benchDir = fileURLToPath(new URL("../../../../bench/", import.meta.url));
const entries = loadCorpus(benchDir);
const styles = loadStyles(benchDir);
const golds = (fixture: string) =>
  readdirSync(`${benchDir}fixtures/${fixture}/tests`)
    .filter((f) => f.endsWith(".test.md"))
    .map((f) => f.replace(/\.test\.md$/, ""))
    .sort();
const of = (fixture: string, style: string) =>
  entries
    .filter((e) => e.fixture === fixture && e.style === style)
    .map((e) => e.gold)
    .sort();

/**
 * What each gold test asserts that a broken variant violates (the manifest's
 * failing steps): every re-phrasing must still say it, or its verdict changes.
 */
const MUST_SAY: Record<string, RegExp[]> = {
  "shop/checkout-trial": [
    /check your email/i,
    /(\$0\.00|zero dollars) due today/i,
    /welcome to pro/i,
  ],
  "shop/signup-email-code": [/check your email/i],
  "shop/login": [/dashboard/i],
  "shop/create-project": [/new project/i, /q3 roadmap|q three roadmap/i, /reload|refresh/i],
  "shop/billing-zero-due": [/(\$0\.00|zero dollars) due today/i],
  "android/sign-in": [/projects/i],
  "android/create-project": [/project created/i, /q3 roadmap|q three roadmap/i, /refresh|reload/i],
  "android/sign-out": [/sign out of acme shop/i],
};

describe("the corpus", () => {
  it("covers every shop gold test in styles 2–7 and at least 4 Android tests in terse, spoken and sloppy", () => {
    for (const style of ["terse", "verbose", "acceptance", "gherkin", "spoken", "sloppy", "mixed"])
      expect(of("shop", style), style).toEqual(golds("shop"));
    for (const style of ["terse", "spoken", "sloppy"])
      expect(of("android", style).length, style).toBeGreaterThanOrEqual(4);
    expect(of("shop", "tidy")).toEqual(golds("shop"));
    expect(of("android", "tidy")).toEqual(of("android", "terse"));
  });

  it("lists every style folder in styles.yaml, with the routes it takes", () => {
    const ids = styles.map((s) => s.id).sort();
    expect(ids).toEqual([
      "acceptance",
      "gherkin",
      "mixed",
      "sloppy",
      "spoken",
      "terse",
      "tidy",
      "verbose",
    ]);
    for (const e of entries) expect(ids, e.path).toContain(e.style);
    for (const s of styles) expect(s.routes.length, s.id).toBeGreaterThan(0);
  });

  it("keeps each gold test's front matter and names the gold test", () => {
    const gold = new Map(
      entries.filter((e) => e.style === "tidy").map((e) => [`${e.fixture}/${e.gold}`, e.text]),
    );
    for (const e of entries.filter((x) => x.style !== "tidy")) {
      expect(frontMatterOf(e.text), e.path).toBe(
        frontMatterOf(gold.get(`${e.fixture}/${e.gold}`) ?? ""),
      );
      expect(e.text, e.path).toContain(
        `<!-- corpus: ${e.style} re-phrasing of tests/${e.gold}.test.md -->`,
      );
    }
  });

  it("still says what catches each broken variant", () => {
    for (const e of entries)
      for (const pattern of MUST_SAY[`${e.fixture}/${e.gold}`] ?? [])
        expect(descriptionOf(e.text), `${e.path} must say ${pattern}`).toMatch(pattern);
  });

  it("turns an entry into what a developer would type into Describe it", () => {
    const e = entries.find((x) => x.style === "terse" && x.gold === "billing-zero-due");
    expect(descriptionOf(e?.text ?? "")).toBe(
      'open billing\nexpect: pro plan shown\nexpect: page shows "$0.00 due today"',
    );
  });
});

describe("the static pass (lint and phrase rules)", () => {
  it("gives the numbers in bench/corpus/README.md", async () => {
    const summary = await analyzeCorpus(benchDir, entries);
    const row = (fixture: string, style: string) => {
      const s = summary.find((x) => x.fixture === fixture && x.style === style);
      return (
        s && {
          lint: [s.lint.clean, s.lint.warnings, s.lint.rejected],
          rules: `${s.phrases.byRules}/${s.phrases.expects}`,
        }
      );
    };
    expect(row("shop", "tidy")).toEqual({ lint: [11, 0, 0], rules: "32/32" });
    expect(row("shop", "terse")).toEqual({ lint: [10, 1, 0], rules: "15/32" });
    expect(row("shop", "sloppy")).toEqual({ lint: [11, 0, 0], rules: "31/32" });
    expect(row("shop", "mixed")).toEqual({ lint: [11, 0, 0], rules: "32/32" });
    for (const style of ["verbose", "gherkin", "spoken"])
      expect(row("shop", style)).toEqual({ lint: [0, 0, 11], rules: "0/0" });
    expect(row("shop", "acceptance")?.lint).toEqual([0, 0, 11]);
    expect(row("android", "tidy")).toEqual({ lint: [4, 0, 0], rules: "8/8" });
    expect(row("android", "terse")).toEqual({ lint: [3, 1, 0], rules: "4/8" });
    expect(row("android", "sloppy")).toEqual({ lint: [4, 0, 0], rules: "8/8" });
  });
});

describe("the estimate asked before a real run", () => {
  it("leaves out test files lint rejects and prices drafts for descriptions", async () => {
    const estimate = await estimateCorpus(benchDir, {
      fixtures: ["shop"],
      styles: ["tidy", "spoken"],
      model: "claude-sonnet-5-5",
    });
    expect(estimate.basis.file).toMatch(/model-comparison\.json$/);
    const spokenFile = estimate.rows.find((r) => r.style === "spoken" && r.route === "file");
    const spokenDescription = estimate.rows.find(
      (r) => r.style === "spoken" && r.route === "description",
    );
    const tidy = estimate.rows.find((r) => r.style === "tidy");
    expect(spokenFile).toMatchObject({ tests: 0, rejected: 11, calls: 0, usd: 0 });
    expect(spokenDescription?.tests).toBe(11);
    expect(spokenDescription?.calls).toBeGreaterThan(tidy?.calls ?? 0);
    expect(estimate.total.calls).toBe((tidy?.calls ?? 0) + (spokenDescription?.calls ?? 0));
  });
});
