import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type EmitInput, createRunWriter, readRun } from "./node/index.js";
import { runLayout, ulid } from "./index.js";

const SECRET = "hunter2-S3CRET";
const scrub = (text: string) => text.replaceAll(SECRET, "[secret:ADMIN_PASSWORD]");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempRunDir() {
  const root = mkdtempSync(join(tmpdir(), "contract-"));
  dirs.push(root);
  return join(root, ulid());
}
function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? allFiles(path) : [path];
  });
}

const S = SECRET;
const testId = `login-${S}`;

/** A run where the secret is planted in every string field of every event type. */
function plantedRun(dir: string) {
  const writer = createRunWriter(dir, { scrub });
  const emit = (e: EmitInput) => writer.emit(e);
  emit({
    type: "run.started",
    engineVersion: S,
    project: S,
    environment: S,
    target: "web",
    trigger: "ci",
    mode: "normal",
    git: { branch: S, commit: S, pr: null },
  });
  emit({ type: "log", level: "info", message: `password=${S}` });
  emit({
    type: "test.started",
    testId,
    file: S,
    name: S,
    tags: [S],
    matrix: { target: "web", browser: "chromium", device: S },
  });
  emit({ type: "attempt.started", testId, attempt: 1 });
  emit({ type: "step.started", testId, attempt: 1, index: 0, key: S, text: S, kind: "action" });
  emit({
    type: "model.called",
    testId,
    attempt: 1,
    call: {
      id: `m-${S}`,
      role: "fixer",
      provider: S,
      model: S,
      startedAt: "2026-09-26T09:00:00.000Z",
      tokens: { input: 1, output: 1, cached: 0 },
      costUsd: 0.01,
      latencyMs: 5,
      attempts: 1,
      outcome: "ok",
    },
  });
  emit({
    type: "decision.made",
    testId,
    attempt: 1,
    decision: {
      id: `d-${S}`,
      task: S,
      answer: { [S]: [S] },
      confidence: 0.9,
      source: S,
      latencyMs: 1,
      escalated: false,
    },
  });
  const shot = writer.writeArtifact(
    {
      kind: "screenshot",
      path: runLayout.screenshot(testId, 1, 0, "after"),
      contentType: "image/png",
      scrubbed: true,
      testId,
      attempt: 1,
    },
    new Uint8Array([1, 2, 3]),
  );
  writer.writeArtifact(
    {
      kind: "console",
      path: runLayout.attemptFile(testId, 1, "console"),
      contentType: "text/plain",
      scrubbed: true,
      testId,
      attempt: 1,
    },
    `login with ${S}\n`,
  );
  emit({
    type: "check.evaluated",
    testId,
    attempt: 1,
    check: {
      id: `c-${S}`,
      stepIndex: 0,
      expectation: S,
      generated: { description: S, code: S },
      kind: "text",
      soft: false,
      passed: true,
      expected: S,
      actual: S,
    },
  });
  emit({
    type: "heal.proposed",
    testId,
    attempt: 1,
    heal: {
      id: `h-${S}`,
      stepIndex: 0,
      stepKey: S,
      changes: [{ target: "locator", before: S, after: S }],
      diff: S,
      signals: [{ name: "text_match", score: 1, detail: S }],
      confidence: 0.9,
      classification: "cosmetic",
      status: "pending",
      policy: "review",
    },
  });
  emit({
    type: "step.finished",
    testId,
    attempt: 1,
    step: {
      index: 0,
      key: S,
      text: S,
      kind: "action",
      status: "passed",
      recovery: "fixer",
      locator: { used: "primary", value: S },
      postState: { status: "verified", expected: S, observed: S },
      startedAt: "2026-09-26T09:00:00.000Z",
      durationMs: 10,
      settledMs: 5,
      screenshots: { before: null, after: shot.path },
      error: S,
      checkIds: [`c-${S}`],
      modelCallIds: [`m-${S}`],
      decisionIds: [`d-${S}`],
      healIds: [`h-${S}`],
    },
  });
  emit({ type: "attempt.finished", testId, attempt: 1, status: "passed" });
  emit({
    type: "test.finished",
    testId,
    verdict: "healed",
    decidedBy: [{ kind: "check", attempt: 1, checkId: `c-${S}` }],
    headline: S,
    checkedSummary: [S],
  });
  emit({ type: "run.finished", blocked: { reason: "aborted", message: S } });
  return { writer, result: writer.finish() };
}

describe("run writer", () => {
  it("scrubs a planted secret from every field, event, document and text artifact", () => {
    const dir = tempRunDir();
    const { result } = plantedRun(dir);
    for (const file of allFiles(dir)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain(SECRET);
    }
    expect(result.tests[0]?.testId).toBe("login-[secret:ADMIN_PASSWORD]");
    expect(readFileSync(join(dir, "events.ndjson"), "utf8")).toContain("[secret:ADMIN_PASSWORD]");
    const { diagnostics } = readRun(dir, { verifyArtifacts: true });
    expect(diagnostics).toEqual([]);
  });

  it("writes run.json and result files that readRun returns unchanged", () => {
    const dir = tempRunDir();
    const { result, writer } = plantedRun(dir);
    const read = readRun(dir);
    expect(read.run).toEqual(result.run);
    expect(read.tests).toEqual(result.tests);
    expect(read.run?.runId).toBe(writer.runId);
    expect(read.events).toHaveLength(15);
    expect(read.events.map((e) => e.seq)).toEqual([...Array(15).keys()]);
  });

  it("refuses an artifact that is not declared scrubbed", () => {
    const dir = tempRunDir();
    const writer = createRunWriter(dir, { scrub });
    writer.emit({
      type: "run.started",
      engineVersion: "0",
      project: "p",
      environment: null,
      target: "web",
      trigger: "cli",
      mode: "normal",
    });
    const artifact = {
      kind: "video",
      path: "video.webm",
      contentType: "video/webm",
      scrubbed: false,
    } as const;
    expect(() => writer.writeArtifact(artifact, new Uint8Array([1]))).toThrow(/unscrubbed/);
    expect(existsSync(join(dir, "video.webm"))).toBe(false);
  });

  it("refuses artifact paths outside the run folder or over its documents", () => {
    const dir = tempRunDir();
    const writer = createRunWriter(dir, { scrub });
    writer.emit({
      type: "run.started",
      engineVersion: "0",
      project: "p",
      environment: null,
      target: "web",
      trigger: "cli",
      mode: "normal",
    });
    for (const path of ["../escape.txt", "/abs.txt", "run.json", "tests/x/result.json", "a\\b.txt"])
      expect(() =>
        writer.writeArtifact(
          { kind: "other", path, contentType: "text/plain", scrubbed: true },
          "x",
        ),
      ).toThrow(/relative path/);
  });

  it("rejects invalid events and events before run.started, and will not reuse a run folder", () => {
    const dir = tempRunDir();
    const writer = createRunWriter(dir, { scrub });
    expect(() => writer.emit({ type: "log", level: "info", message: "x" })).toThrow(/first event/);
    writer.emit({
      type: "run.started",
      engineVersion: "0",
      project: "p",
      environment: null,
      target: "web",
      trigger: "cli",
      mode: "normal",
    });
    expect(() => writer.emit({ type: "attempt.started", testId: "t", attempt: 0 })).toThrow(
      /invalid attempt.started/,
    );
    expect(() => writer.finish()).toThrow(/no run.finished/);
    expect(() => createRunWriter(dir, { scrub })).toThrow(/already exists/);
  });
});
