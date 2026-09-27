import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { apkPath, FIXTURE_DIR, gradleFlavor, VARIANTS } from "./index.js";

// Device-free checks that run in `pnpm check`: the gold manifest answers every
// test × variant and agrees with the .test.md files, and the Gradle build and
// the app's code agree with the variant list.

const CAUSES = ["product_bug", "test_drift", "environment", "test_data", "blocked"] as const;
const VERDICTS = ["passed", "failed", "flaky", "blocked"] as const;
const read = (...parts: string[]) => readFileSync(join(FIXTURE_DIR, ...parts), "utf8");

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
    fixture: z.literal("android"),
    tests_dir: z.literal("tests"),
    harness: z.object({
      retries: z.number().int().nonnegative(),
      before_first_attempt: z.string(),
      before_retry: z.string(),
      secrets: z.record(z.string(), z.string()),
      app: z.string(),
      shop: z.object({ variant: z.string(), port: z.number().int() }),
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

const manifest = parse(read("manifest.yaml")) as z.infer<typeof schema>;
const testNames = readdirSync(join(FIXTURE_DIR, "tests"))
  .filter((f) => f.endsWith(".test.md"))
  .map((f) => f.replace(/\.test\.md$/, ""))
  .sort();

describe("gold manifest", () => {
  it("matches the schema", () => {
    const result = schema.safeParse(manifest);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("answers every test × variant", () => {
    expect(Object.keys(manifest.tests).sort()).toEqual(testNames);
    expect(Object.keys(manifest.variants)).toEqual([...VARIANTS]);
    for (const [test, answers] of Object.entries(manifest.tests)) {
      expect(Object.keys(answers).sort(), test).toEqual([...VARIANTS].sort());
    }
  });

  it("points every failure at a numbered step that exists, with a real cause", () => {
    for (const [test, answers] of Object.entries(manifest.tests)) {
      const steps = read("tests", `${test}.test.md`)
        .split("\n")
        .map((line) => /^(\d+)\. (.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null);
      for (const [variant, answer] of Object.entries(answers)) {
        if (answer === "passed") continue;
        const step = steps.find((m) => Number(m[1]) === answer.step);
        expect(step, `${test} × ${variant}: step ${answer.step}`).toBeDefined();
      }
    }
  });

  it("has a failing answer for every broken variant, including both false-pass traps", () => {
    for (const variant of VARIANTS.filter((v) => v.startsWith("broken-"))) {
      const failing = Object.values(manifest.tests).filter(
        (answers) => answers[variant] !== "passed",
      );
      expect(failing.length, variant).toBeGreaterThan(0);
    }
    expect(manifest.tests["create-project"]?.["broken-silent-tap"]).toMatchObject({ step: 4 });
    expect(manifest.tests["create-project"]?.["broken-not-saved"]).toMatchObject({ step: 8 });
  });
});

describe("the app's build", () => {
  const gradle = read("app", "build.gradle.kts");
  const code = readdirSync(join(FIXTURE_DIR, "app/src/main/kotlin/com/acme/shop"))
    .map((file) => read("app/src/main/kotlin/com/acme/shop", file))
    .join("\n");

  it("builds one flavor per variant, and the code switches on exactly those", () => {
    const flavors = [...gradle.matchAll(/create\("(\w+)"\)/g)].map((m) => m[1]);
    expect(flavors).toEqual(VARIANTS.map(gradleFlavor));
    for (const variant of VARIANTS.filter((v) => v !== "correct")) {
      expect(code, variant).toContain(`"${gradleFlavor(variant)}"`);
    }
    expect(apkPath("broken-silent-tap").replaceAll("\\", "/")).toMatch(
      /brokenSilentTap\/debug\/acme-shop-android-brokenSilentTap-debug\.apk$/,
    );
  });

  it("declares every view id the app uses", () => {
    const declared = new Set(
      [...read("app/src/main/res/values/ids.xml").matchAll(/name="(\w+)"/g)].map((m) => m[1]),
    );
    const used = [...code.matchAll(/R\.id\.(\w+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(30);
    for (const id of used) expect(declared.has(id), id).toBe(true);
  });

  it("talks only to the shop through the host alias, and to one address the harness must refuse", () => {
    const urls = [...code.matchAll(/https?:\/\/[^"\s]+/g)].map((m) => m[0]);
    expect(urls).toEqual(["https://203.0.113.7/acme-shop/latest.json"]);
    expect(gradle).toContain('val shopUrl = "http://10.0.2.2:4180"');
  });
});
