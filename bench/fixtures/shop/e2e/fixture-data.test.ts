import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VARIANTS } from "../src/variants.js";
import { CAUSES, expectation, MANIFEST_PATH, readManifest, VERDICTS } from "./manifest.js";
import { readTestFile, TESTS_DIR } from "./test-file.js";
import { mismatch, outcomeOf } from "./verdicts.js";

// Browser-free checks that run in `pnpm check`: the gold manifest is complete
// and well-formed, the .test.md files are consistent with it, and the verdict
// logic used to score the reference suite is right.

const outcome = z.union([
  z.literal("passed"),
  z
    .object({
      verdict: z.enum(VERDICTS),
      step: z.number().int().positive().optional(),
      cause: z.enum(CAUSES).optional(),
      reason: z.string().min(10).optional(),
    })
    .strict()
    .refine((o) => o.verdict === "passed" || (o.step && o.cause && o.reason), {
      message: "a failed, flaky or blocked answer needs step, cause and reason",
    }),
]);

const schema = z
  .object({
    version: z.literal(1),
    fixture: z.string(),
    tests_dir: z.string(),
    harness: z.object({
      retries: z.number().int().nonnegative(),
      before_first_attempt: z.string(),
      before_retry: z.string(),
      secrets: z.record(z.string(), z.string()),
    }),
    variants: z.record(
      z.enum(VARIANTS),
      z
        .object({ also_accept: z.object({ passed: z.array(z.literal("healed")) }).optional() })
        .strict(),
    ),
    tests: z.record(z.string(), z.record(z.enum(VARIANTS), outcome)),
  })
  .strict();

const manifest = readManifest();
const testNames = readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".test.md"))
  .map((f) => f.replace(/\.test\.md$/, ""))
  .sort();

describe("gold manifest", () => {
  it("matches the schema", () => {
    const result = schema.safeParse(manifest);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("answers every test × variant, and nothing else", () => {
    expect(Object.keys(manifest.tests).sort()).toEqual(testNames);
    expect(Object.keys(manifest.variants).sort()).toEqual([...VARIANTS].sort());
    for (const test of testNames) {
      expect(Object.keys(manifest.tests[test] ?? {}).sort(), test).toEqual([...VARIANTS].sort());
    }
  });

  it("allows healed only on cosmetic", () => {
    const withHealed = Object.entries(manifest.variants)
      .filter(([, v]) => v.also_accept)
      .map(([name]) => name);
    expect(withHealed).toEqual(["cosmetic"]);
  });

  it("passes every test on correct and cosmetic, and breaks something on every other variant", () => {
    for (const variant of VARIANTS) {
      const verdicts = testNames.map((t) => expectation(manifest, t, variant).verdict);
      if (variant === "correct" || variant === "cosmetic") {
        expect(new Set(verdicts), variant).toEqual(new Set(["passed"]));
      } else {
        expect(
          verdicts.some((v) => v !== "passed"),
          variant,
        ).toBe(true);
      }
    }
  });

  it("points every failure at a real step; blocked ones at a Use: step", () => {
    for (const test of testNames) {
      const file = readTestFile(test);
      for (const variant of VARIANTS) {
        const answer = expectation(manifest, test, variant);
        if (answer.verdict === "passed") continue;
        const text = file.steps.get(answer.step ?? 0);
        expect(text, `${test} × ${variant} step ${answer.step}`).toBeDefined();
        expect(text?.startsWith("Use:"), `${test} × ${variant}`).toBe(answer.verdict === "blocked");
      }
    }
  });

  it("has at least two false-pass traps that fail on an Expect: after the action", () => {
    const traps = ["broken-silent-click", "broken-not-saved"];
    for (const variant of traps) {
      const failures = testNames
        .map((t) => ({ t, a: expectation(manifest, t, variant) }))
        .filter(({ a }) => a.verdict === "failed");
      expect(failures.length, variant).toBeGreaterThan(0);
      for (const { t, a } of failures) {
        expect(readTestFile(t).steps.get(a.step ?? 0), `${t} × ${variant}`).toMatch(/^Expect:/);
      }
    }
  });

  it("keeps the manifest free of absolute paths", () => {
    expect(readFileSync(MANIFEST_PATH, "utf8")).not.toMatch(/\/Users\/|[A-Z]:\\/);
  });
});

describe("plain-English tests", () => {
  it("have frontmatter, numbered steps and at least one Expect:", () => {
    for (const test of [...testNames, "flows/login"]) {
      const file = readTestFile(test);
      expect(typeof file.frontmatter.name, test).toBe("string");
      expect(file.steps.size, test).toBeGreaterThan(0);
      expect(
        [...file.steps.values()].some((s) => s.startsWith("Expect:")),
        test,
      ).toBe(true);
    }
  });

  it("only Use: flows that exist, and only upload files that exist", () => {
    for (const test of testNames) {
      for (const step of readTestFile(test).steps.values()) {
        const use = /^Use:\s*(\S+)$/.exec(step)?.[1];
        if (use) expect(existsSync(`${TESTS_DIR}${use}`), `${test}: ${use}`).toBe(true);
        const upload = /^Upload (\S+)/.exec(step)?.[1];
        if (upload) expect(existsSync(`${TESTS_DIR}${upload}`), `${test}: ${upload}`).toBe(true);
      }
    }
  });

  it("each have a reference test in the semantic suite", () => {
    const suite = readFileSync(new URL("./semantic.spec.ts", import.meta.url), "utf8");
    for (const test of testNames) {
      expect(suite, test).toContain(`./semantic/${test}.js`);
      const spec = readFileSync(new URL(`./semantic/${test}.ts`, import.meta.url), "utf8");
      expect(spec, test).toContain(`test("${test}"`);
    }
  });
});

describe("reference verdicts", () => {
  const pass = { passed: true, failedStep: null };
  const fail = (failedStep: string) => ({ passed: false, failedStep });

  it("maps attempts to verdicts", () => {
    expect(outcomeOf([pass]).verdict).toBe("passed");
    expect(outcomeOf([fail("6. Expect: x"), pass])).toEqual({
      verdict: "flaky",
      step: 6,
      failedStep: "6. Expect: x",
    });
    expect(outcomeOf([fail("3. Expect: x"), fail("3. Expect: x")]).verdict).toBe("failed");
    expect(
      outcomeOf([fail("1. Use: flows/login.test.md"), fail("1. Use: flows/login.test.md")]),
    ).toMatchObject({ verdict: "blocked", step: 1 });
    expect(outcomeOf([]).verdict).toBe("failed");
  });

  it("requires the same verdict and the same failing step", () => {
    const got = outcomeOf([fail("9. Expect: y"), fail("9. Expect: y")]);
    expect(mismatch({ verdict: "failed", step: 9 }, got)).toBeNull();
    expect(mismatch({ verdict: "failed", step: 7 }, got)).toMatch(/step 7/);
    expect(mismatch({ verdict: "passed" }, got)).toMatch(/expected passed/);
  });
});
