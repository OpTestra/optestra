import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  billableSeconds,
  type CostMeasurement,
  formatBaseline,
  loadCloudPrices,
  meterReport,
  shapeRate,
  withCloudFacts,
} from "./cost.js";

// The cost meter on a committed local rehearsal (bench/cloud/testdata): six
// tasks of bench/cloud/entry.ts on this repository's shop, scripted, no AI.
// The prices are the committed bench/cloud/prices.yaml, so a price change shows
// up here as a reviewed diff.

const cloud = new URL("../../../../bench/cloud/", import.meta.url);
const prices = loadCloudPrices(fileURLToPath(new URL("prices.yaml", cloud)));
const resultsDir = new URL("testdata/rehearsal-local/results/", cloud);
const measurements = readdirSync(resultsDir)
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, resultsDir), "utf8")) as CostMeasurement);
const context = {
  costRun: "rehearsal-local",
  date: "2026-10-01T00:00:00.000Z",
  command: "bench --meter bench/cloud/testdata/rehearsal-local",
  engineVersion: "0.1.0",
  commit: null,
  buildMinutes: 9,
  imageGiB: 1.6,
  secretVersions: 1,
};

describe("cost meter", () => {
  it("reads the committed price file", () => {
    expect(prices.checked).toBe("2026-10-01");
    expect(prices.region).toBe("us-east4");
    expect(prices.cloudRun.jobs).toMatchObject({ vcpuSecond: 0.000018, gibSecond: 0.000002 });
  });

  it("bills Cloud Run jobs on allocation, per 100 ms, at least a minute", () => {
    expect(billableSeconds(5_000, prices.cloudRun.jobs)).toBe(60);
    expect(billableSeconds(60_000, prices.cloudRun.jobs)).toBe(60);
    expect(billableSeconds(60_040, prices.cloudRun.jobs)).toBeCloseTo(60.1, 6);
    expect(billableSeconds(61_000, prices.cloudRun.jobs)).toBeCloseTo(61, 6);
    // 2 vCPU × $0.000018 + 4 GiB × $0.000002
    expect(shapeRate({ vcpu: 2, memoryGiB: 4, parallel: 1 }, prices.cloudRun.jobs)).toBeCloseTo(
      0.000044,
      12,
    );
  });

  const report = meterReport(measurements, prices, context);

  it("turns the rehearsal into the full report", () => {
    expect(report).toMatchObject({
      kind: "cloud-baseline",
      costRun: "rehearsal-local",
      where: ["local"],
      measurements: { tasks: 6, tests: 101 },
    });
    expect(report.shapes.map((s) => s.shape)).toEqual(["2 vCPU / 4 GiB × 1", "2 vCPU / 4 GiB × 4"]);
    // An empty run still pays the 1-minute minimum: 60 s × $0.000044.
    expect(report.fixedPerRunOverhead).toBeCloseTo(0.00264, 10);
    // Replay, failures mode, 4 lanes: the task time one more test adds, × the rate, + its evidence.
    const four = report.shapes.find((s) => s.parallel === 4);
    const replay = four?.phases.find((p) => p.phase === "replay");
    const task = measurements.find((m) => m.shape.parallel === 4) as CostMeasurement;
    const seconds = task.timing.testsWallMs / 1000 / task.tests.length;
    expect(replay?.marginalSecondsPerTest).toBeCloseTo(seconds, 2);
    expect(replay?.compute).toBeCloseTo(seconds * 0.000044, 8);
    const bytes = task.tests.reduce((n, t) => n + t.evidenceBytes, 0) / task.tests.length;
    const files = task.tests.reduce((n, t) => n + t.evidenceFiles, 0) / task.tests.length;
    const storage = (bytes / 1024 ** 3) * 0.023 * (30 / (730 / 24));
    expect(replay?.storage).toBeCloseTo(storage, 8);
    expect(replay?.operations).toBeCloseTo((files / 1000) * 0.005, 8);
    // The cheapest web replay is that shape's.
    expect(report.perWebTest.replay).toBe(replay?.total);
    // Each evidence mode is priced on its own; the headline is the default (failures).
    const one = report.shapes.find((s) => s.parallel === 1);
    expect(
      one?.phases
        .filter((p) => p.phase === "replay")
        .map((p) => p.evidence)
        .sort(),
    ).toEqual(["failures", "full", "minimal"]);
    // No AI in a scripted rehearsal, no Android VM in it.
    expect(report.ai.listUsd).toBe(0);
    expect(report.perAndroidTest.replay).toBeNull();
  });

  it("prices the one-off build and the idle month", () => {
    expect(report.oneOff.build).toBeCloseTo(9 * 0.006, 8);
    // (1.6 − 0.5 free) GiB × $0.10; one secret version is inside the 6 free.
    expect(report.idleMonthly.total).toBeCloseTo(0.11, 6);
    expect(report.idleMonthly.items.map((i) => i.item)).toContain("Cloud Run Job");
  });

  it("adds the 1-minute minimum per task to the run's compute", () => {
    const expected = measurements.reduce(
      (n, m) =>
        n +
        billableSeconds(m.timing.processStartMs + m.timing.taskWallMs, prices.cloudRun.jobs) *
          shapeRate(m.shape, prices.cloudRun.jobs),
      0,
    );
    expect(report.totals.compute).toBeCloseTo(expected, 6);
    expect(report.totals.all).toBeCloseTo(
      report.totals.compute + report.totals.storage + report.totals.ai + report.totals.build,
      6,
    );
  });

  it("prices the Android VM per test from its hours and disk", () => {
    const vm: CostMeasurement = {
      ...(measurements[0] as CostMeasurement),
      where: "android-vm",
      shape: { vcpu: 4, memoryGiB: 16, parallel: 1, machine: "n2-standard-4" },
      slice: {
        fixture: "android",
        phase: "replay",
        variants: ["correct"],
        evidence: "failures",
        reruns: 1,
      },
      timing: {
        ...(measurements[0] as CostMeasurement).timing,
        testsWallMs: 3_600_000,
        taskWallMs: 3_600_000,
      },
      tests: Array.from({ length: 100 }, (_, i) => ({
        fixture: "android" as const,
        variant: "correct",
        test: `t${i}`,
        verdict: "passed",
        durationMs: 36_000,
        aiCalls: 0,
        tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 },
        listUsd: 0,
        evidenceBytes: 0,
        evidenceFiles: 0,
      })),
      vm: { createMs: 30_000, sshReadyMs: 30_000, setupMs: 0, diskGiB: 30, hourlyUsd: null },
    };
    const withVm = meterReport([vm], prices, context);
    // One hour of n2-standard-4 spot + 30 GiB pd-balanced for an hour, over 100 tests.
    const perHour = 0.0576 + (30 * 0.11) / 730;
    expect(withVm.perAndroidTest.vmHour).toBeCloseTo(perHour, 6);
    expect(withVm.perAndroidTest.replay).toBeCloseTo(perHour / 100, 8);
    // Create + ssh ready + setup, and the slice's own setup before the first test.
    const fixedMs = 60_000 + vm.timing.setupMs;
    expect(withVm.perAndroidTest.fixedPerVm).toBeCloseTo((fixedMs / 3_600_000) * perHour, 8);
  });

  it("takes each Cloud Run task's container start from gcloud's task times", () => {
    const m = {
      ...(measurements[0] as CostMeasurement),
      where: "cloud-run" as const,
      task: { index: 0, count: 1, execution: "job-abc", region: "us-east4" },
      timing: {
        ...(measurements[0] as CostMeasurement).timing,
        startedAt: "2026-10-02T10:00:10.000Z",
        processStartMs: 400,
      },
    };
    const [filled] = withCloudFacts([m], {
      tasks: [
        { execution: "job-abc", index: 0, createTime: "2026-10-02T10:00:02.600Z", startTime: null },
      ],
    });
    // Entry at 10:00:10.000 minus 400 ms of Node start = process start 10:00:09.600; created 7 s before.
    expect(filled?.timing.containerStartMs).toBe(7000);
  });

  it("writes the markdown summary the growth team reads", async () => {
    await expect(formatBaseline(report)).toMatchFileSnapshot(
      fileURLToPath(new URL("testdata/rehearsal-local/cloud-baseline.md", cloud)),
    );
  });
});
