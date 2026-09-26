import { resolve } from "node:path";
import { hasErrors } from "@testament/config";
import { defaultRedactor, findProject, loadProject } from "@testament/config/node";
import type { DecisionRecord } from "@testament/contract";
import { readRun } from "@testament/contract/node";
import {
  createDecisions,
  type DecisionMetrics,
  type DecisionsSettings,
  metricsFromRecords,
} from "@testament/decide";
import type { CommandIo } from "./config.js";

export interface DecisionsCommandOptions {
  env?: string;
  dir?: string;
  json?: boolean;
  /** A run folder to read decision records from. */
  stats?: string;
}

function table(rows: string[][], indent = "  "): string {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows
    .map(
      (row) =>
        indent +
        row
          .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
          .join("  "),
    )
    .join("\n");
}

function duration(seconds: number): string {
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, unit] of units) {
    if (seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} s`;
}

/** Decision records of a run: from the live events, or from the documents if there are none. */
function runDecisions(runDir: string): { records: DecisionRecord[]; error?: string } {
  const read = readRun(runDir);
  const fromEvents = read.events.flatMap((e) => (e.type === "decision.made" ? [e.decision] : []));
  if (fromEvents.length > 0 || read.events.length > 0) return { records: fromEvents };
  if (!read.run) {
    const problem = read.diagnostics.find((d) => d.severity === "error");
    return { records: [], error: problem ? `${problem.file}: ${problem.message}` : "no run found" };
  }
  return {
    records: [
      ...read.run.decisions,
      ...read.tests.flatMap((t) => t.attempts.flatMap((a) => a.decisions)),
    ],
  };
}

function statsText(metrics: DecisionMetrics): string {
  const rows = Object.entries(metrics).map(([task, m]) => [
    task,
    String(m.total),
    `${m.rulesPct}%`,
    `${m.modelPct}%`,
    `${m.escalatedPct}%`,
    `${m.p50Ms} ms`,
    `${m.p95Ms} ms`,
  ]);
  return rows.length
    ? table([["TASK", "TOTAL", "RULES", "MODEL", "ESCALATED", "P50", "P95"], ...rows])
    : "  No decisions in this run.";
}

/**
 * `decisions`: the configured decision backend, thresholds and registered tasks;
 * `--stats <runDir>` prints per-task metrics from a run folder's decision records.
 * Exit 2 on config errors or an unreadable run folder.
 */
export function runDecisionsCommand(options: DecisionsCommandOptions, io: CommandIo): number {
  if (options.stats) {
    const runDir = resolve(io.cwd, options.stats);
    const { records, error } = runDecisions(runDir);
    if (error) {
      io.stdout(
        options.json
          ? `${JSON.stringify({ error: "unreadable run", message: error }, null, 2)}\n`
          : `Cannot read the run in ${options.stats}: ${error}\n`,
      );
      return 2;
    }
    const metrics = metricsFromRecords(records);
    io.stdout(
      defaultRedactor.redact(
        options.json
          ? `${JSON.stringify({ runDir, decisions: records.length, tasks: metrics }, null, 2)}\n`
          : `Decisions in ${options.stats}\n${statsText(metrics)}\n`,
      ),
    );
    return 0;
  }

  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  const projectFound = !loaded.diagnostics.some((d) => d.code === "PROJECT_NOT_FOUND");
  // Outside a project the built-in defaults are all there is; config diagnostics would only be noise.
  const diagnostics = projectFound ? loaded.diagnostics : [];
  const settings = loaded.config.decisions as DecisionsSettings;
  const decisions = createDecisions({ config: { decisions: settings } });
  const tasks = [...decisions.tasks.values()].map((task) => {
    const effective = decisions.settingsFor(task);
    return {
      name: task.name,
      version: task.version,
      phase: task.phase,
      description: task.description,
      questions: Object.fromEntries(Object.entries(task.questions).map(([id, q]) => [id, q.kind])),
      onEscalate: task.onEscalate,
      ...effective,
    };
  });
  const problems = Object.keys(settings.tasks)
    .filter((name) => !decisions.tasks.has(name))
    .map((name) => ({
      message: `decisions.tasks.${name} names no registered task.`,
      fix: `Use one of: ${tasks.map((t) => t.name).join(", ")}.`,
    }));

  let output: string;
  if (options.json) {
    output = JSON.stringify(
      {
        file: projectFound ? loaded.file : null,
        environment: loaded.environment?.name ?? null,
        backend: settings.backend,
        threshold: settings.threshold,
        cache: settings.cache,
        tasks,
        problems,
        diagnostics,
      },
      null,
      2,
    );
  } else {
    const backend =
      settings.backend === "none"
        ? "none (rules only; unclear cases escalate)"
        : String(settings.backend);
    const cache = settings.cache.enabled
      ? `on, answers kept ${duration(settings.cache.ttlSeconds)}`
      : "off";
    const rows = tasks.map((t) => [
      t.name,
      `v${t.version}`,
      t.phase,
      t.threshold.toFixed(2),
      `${t.timeLimitMs} ms`,
      t.enabled ? "on" : "off",
      t.onEscalate,
      Object.entries(t.questions)
        .map(([id, kind]) => `${id} (${kind})`)
        .join(", "),
    ]);
    const lines = [
      ...problems.map((p) => `  warning  ${p.message}\n           Fix: ${p.fix}`),
      ...diagnostics.map((d) => `  ${d.severity}  ${d.code}  ${d.message}\n         Fix: ${d.fix}`),
    ];
    output = [
      [
        `Project    ${projectFound ? loaded.file : "no project file here (using built-in defaults)"}`,
        `Backend    ${backend}`,
        `Threshold  ${settings.threshold.toFixed(2)} (project default)`,
        `Cache      ${cache}`,
      ].join("\n"),
      `Tasks\n${table([["TASK", "VER", "PHASE", "THRESHOLD", "LIMIT", "ENABLED", "ESCALATES TO", "QUESTIONS"], ...rows])}`,
      lines.length ? `Problems\n${lines.join("\n")}` : "No problems found.",
    ].join("\n\n");
  }
  io.stdout(`${defaultRedactor.redact(output)}\n`);
  return hasErrors(diagnostics) ? 2 : 0;
}
