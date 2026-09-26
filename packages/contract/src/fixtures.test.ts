import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EventSchema, EVENT_TYPES, foldEvents, serializeDocument, VERDICTS } from "./index.js";
import { contractJsonSchemas } from "./json-schema.js";
import { readRun } from "./node/index.js";
import { ALL, fixture, GOLDEN } from "./fixtures.test-support.js";

describe("golden fixtures", () => {
  it.each(ALL)("%s parses with no errors and every artifact matches its sha256", (name) => {
    const { run, tests, diagnostics } = readRun(fixture(name), { verifyArtifacts: true });
    expect(diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    expect(run).not.toBeNull();
    expect(tests).toHaveLength(run?.tests.length ?? -1);
  });

  it.each(GOLDEN)("%s: folding events.ndjson gives byte-identical documents", (name) => {
    const dir = fixture(name);
    const lines = readFileSync(join(dir, "events.ndjson"), "utf8").trimEnd().split("\n");
    const { run, tests } = foldEvents(lines.map((line) => EventSchema.parse(JSON.parse(line))));
    expect(serializeDocument(run)).toBe(readFileSync(join(dir, "run.json"), "utf8"));
    for (const test of tests) {
      const ref = run.tests.find((t) => t.testId === test.testId);
      expect(serializeDocument(test)).toBe(readFileSync(join(dir, ref?.result ?? ""), "utf8"));
    }
  });

  it("cover every verdict, a pending heal, an Android run and both blocked reasons", () => {
    const runs = GOLDEN.map((name) => readRun(fixture(name)));
    const verdicts = new Set(runs.flatMap((r) => r.tests.map((t) => t.verdict)));
    expect([...verdicts].sort()).toEqual([...VERDICTS].sort());
    const tests = runs.flatMap((r) => r.tests);
    expect(
      tests.some((t) => t.attempts.some((a) => a.heals.some((h) => h.status === "pending"))),
    ).toBe(true);
    expect(runs.some((r) => r.run?.target === "android")).toBe(true);
    const reasons = tests.flatMap((t) =>
      t.decidedBy.flatMap((d) => (d.kind === "blocked" ? [d.reason] : [])),
    );
    expect(reasons.sort()).toEqual(["budget_exceeded", "missing_secret"]);
  });

  it("emit every event type except log", () => {
    const seen = new Set(
      GOLDEN.flatMap((name) => readRun(fixture(name)).events.map((e) => e.type)),
    );
    expect(EVENT_TYPES.filter((type) => !seen.has(type))).toEqual(["log"]);
  });
});

describe("a run from a newer minor version", () => {
  const result = readRun(fixture("_future-minor"));

  it("parses: unknown fields are dropped and unknown events skipped", () => {
    expect(result.run?.contractVersion).toBe("1.9");
    expect(result.run).not.toHaveProperty("newTopLevelField");
    expect(result.tests[0]?.attempts[0]?.steps[0]).not.toHaveProperty("accessibilityWarnings");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "info",
        line: 2,
        message: expect.stringContaining("note.added"),
      }),
    ]);
  });

  it("still folds from its known events", () => {
    const { run } = foldEvents(result.events);
    expect(run.totals.passed).toBe(2);
  });
});

describe("JSON Schema", () => {
  const validator = (schema: Record<string, unknown>) =>
    z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  const runSchema = validator(contractJsonSchemas.run());
  const testSchema = validator(contractJsonSchemas.testResult());
  const eventSchema = validator(contractJsonSchemas.event());

  it.each(ALL)("validates every document and event of %s", (name) => {
    const dir = fixture(name);
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    expect(runSchema.safeParse(run).error?.issues).toBeUndefined();
    for (const ref of run.tests) {
      const test = JSON.parse(readFileSync(join(dir, ref.result), "utf8"));
      expect(testSchema.safeParse(test).error?.issues).toBeUndefined();
    }
    for (const line of readFileSync(join(dir, "events.ndjson"), "utf8").trimEnd().split("\n")) {
      const event = JSON.parse(line);
      if (!(EVENT_TYPES as readonly string[]).includes(event.type)) continue;
      expect(eventSchema.safeParse(event).error?.issues).toBeUndefined();
    }
  });

  it("rejects a document with a wrong verdict value", () => {
    const run = JSON.parse(readFileSync(join(fixture("all-passed"), "run.json"), "utf8"));
    run.tests[0].verdict = "mostly_passed";
    expect(runSchema.safeParse(run).success).toBe(false);
  });
});
