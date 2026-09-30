import { brand } from "@testament/brand";
import type { FixtureMetrics } from "./metrics.js";
import {
  type BaselineComparison,
  type BenchReport,
  type FixtureReport,
  percent,
} from "./report.js";
import type { FixtureId } from "./score.js";

// The BEN-2 table. Every rate shows its counts ("0.0% (0/26)"): the false pass
// rate is never rounded away (guarantee 1).

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

function column(report: FixtureReport | undefined): (string | null)[] {
  const m: FixtureMetrics | undefined = report?.metrics;
  if (!report || !m) return Array(ROWS.length).fill(report?.status === "skipped" ? "skipped" : "-");
  const first = report.firstRun;
  return [
    percent(m.falsePass),
    percent(m.falseFail),
    `${percent(m.flake)} over ${m.flake.reruns} runs`,
    String(m.needsAi),
    String(m.otherMismatches.length),
    percent(m.replay.hitRate),
    String(m.replay.aiCallsOnCorrect),
    m.cosmetic ? percent(m.cosmetic.noAiRate) : "-",
    m.cosmetic ? percent(m.cosmetic.passedWithoutRerecording) : "-",
    m.cosmetic ? String(m.cosmetic.healsWithoutAi) : "-",
    seconds(m.replay.medianMs),
    `${usd(m.ai.costUsd)} (${m.ai.calls} calls)`,
    first
      ? `${seconds(first.durationMs)}, ${first.aiCalls} calls, ${usd(first.costUsd)}${first.subscriptionCalls ? ` (+${first.subscriptionCalls} via subscription)` : ""} [${first.model}]`
      : "not measured (bench --models)",
    m.equivalence
      ? `${m.equivalence.compared - m.equivalence.disagree}/${m.equivalence.compared} agree`
      : "-",
  ];
}

const ROWS = [
  "False pass rate (headline)",
  "False fail rate",
  "Flake rate (correct)",
  "Needs AI (cosmetic, no model)",
  "Other wrong verdicts/causes",
  "Replay hit rate (correct)",
  "AI calls on correct",
  "Cosmetic: steps done without AI",
  "Cosmetic: passed, no re-record",
  "Cosmetic: heals without AI",
  "Replay time (correct, median)",
  "Replay AI cost (every variant)",
  "First run (authoring)",
  "Replay = plain Playwright",
];

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("   ")
        .trimEnd(),
    )
    .join("\n");
}

export function formatBench(report: BenchReport, comparison?: BaselineComparison | null): string {
  const m = report.measured;
  const fixtures = Object.keys(report.fixtures) as FixtureId[];
  const lines = [
    `${brand.productName} Bench · engine ${m.engineVersion}${m.commit ? ` (${m.commit})` : ""} · ${m.os} · node ${m.node} · ${m.date.slice(0, 10)}`,
    `Models: ${m.models} · correct run ${m.reruns} time${m.reruns === 1 ? "" : "s"} · reproduce: ${brand.cliName} ${m.command}`,
    "",
  ];
  const header = ["", ...fixtures, ...(fixtures.length > 1 ? ["total"] : [])];
  const cols = fixtures.map((f) => column(report.fixtures[f]));
  const t = report.total;
  const totalCol = [
    percent(t.falsePass),
    percent(t.falseFail),
    percent(t.flake),
    String(t.needsAi),
    String(t.otherMismatches),
    percent(t.replayHitRate),
    "",
    t.cosmeticNoAiRate ? percent(t.cosmeticNoAiRate) : "-",
    "",
    "",
    "",
    `${usd(t.costUsd)} (${t.aiCalls} calls)`,
    "",
    "",
  ];
  lines.push(
    table([
      header,
      ...ROWS.map((name, i) => [
        name,
        ...cols.map((c) => c[i] ?? "-"),
        ...(fixtures.length > 1 ? [totalCol[i] ?? ""] : []),
      ]),
    ]),
  );
  for (const f of fixtures) {
    const r = report.fixtures[f];
    if (r?.status === "skipped") lines.push("", `${f}: skipped: ${r.reason}`);
    const metrics = r?.metrics;
    if (!metrics) continue;
    const detail = [
      ...metrics.falsePass.cases.map((c) => `  FALSE PASS  ${c}`),
      ...metrics.falseFail.cases.map((c) => `  false fail  ${c}`),
      ...metrics.flake.cases.map((c) => `  flaky       ${c}`),
      ...metrics.otherMismatches.map((c) => `  wrong       ${c}`),
      ...(metrics.equivalence?.cases ?? []).map((c) => `  disagree    ${c}`),
    ];
    if (detail.length) lines.push("", `${f}:`, ...detail);
    const times = Object.entries(r.times)
      .map(([v, ms]) => `${v} ${seconds(ms)}`)
      .join(", ");
    lines.push("", `${f} variants (first run): ${times}`);
  }
  if (comparison !== undefined) {
    lines.push("");
    if (!comparison) lines.push("No baseline to compare with (bench/baseline.json).");
    else if (comparison.deltas.length === 0) lines.push("Against the baseline: no change.");
    else {
      lines.push("Against the baseline:");
      for (const d of comparison.deltas) {
        const isRate = /rate|without AI/.test(d.metric);
        const fmt = (n: number) => (isRate ? `${(n * 100).toFixed(1)}%` : String(n));
        lines.push(
          `  ${d.worse ? "WORSE " : "better"} ${d.fixture} ${d.metric}: ${fmt(d.baseline)} → ${fmt(d.now)}`,
        );
      }
      if (comparison.newFalsePasses.length)
        lines.push(`  NEW FALSE PASSES: ${comparison.newFalsePasses.join(", ")}`);
    }
  }
  return lines.join("\n");
}
