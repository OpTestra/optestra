import { resolve } from "node:path";
import { brand } from "@testament/brand";
import { type Config, type Diagnostic, hasErrors } from "@testament/config";
import {
  defaultRedactor,
  dotenvSource,
  findProject,
  loadProject,
  processEnvSource,
  type SecretSource,
} from "@testament/config/node";
import type { DecisionRecord } from "@testament/contract";
import { readRun } from "@testament/contract/node";
import {
  createDecisions,
  type DecisionMetrics,
  type DecisionsSettings,
  MODEL_BACKENDS,
  type ModelBackendId,
  metricsFromRecords,
} from "@testament/decide";
import {
  type BackendCheck,
  type BackendSelection,
  type BenchResult,
  benchBackend,
  checkLaya,
  checkSystemOne,
  resolveDecisionBackend,
} from "@testament/decide/node";
import type { CommandIo } from "./config.js";

export interface DecisionsCommandOptions {
  env?: string;
  dir?: string;
  json?: boolean;
  /** A run folder to read decision records from. */
  stats?: string;
  /** Check every backend: key valid, reachable, model installed. */
  check?: boolean;
  /** Measure latency on the demo task. */
  bench?: boolean;
  /** For --bench: jev, kev, laya or all (default: the selected backend). */
  backend?: string;
  /** For --bench: decisions per backend. */
  n?: string;
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

interface Project {
  dir: string;
  file: string | null;
  environment: string | undefined;
  config: Config;
  settings: DecisionsSettings;
  diagnostics: Diagnostic[];
  sources: SecretSource[];
}

function loadDecisionsProject(options: DecisionsCommandOptions, io: CommandIo): Project {
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  const projectFound = !loaded.diagnostics.some((d) => d.code === "PROJECT_NOT_FOUND");
  return {
    dir,
    file: projectFound ? loaded.file : null,
    environment: loaded.environment?.name,
    config: loaded.config,
    settings: loaded.config.decisions as DecisionsSettings,
    // Outside a project the built-in defaults are all there is; config diagnostics would only be noise.
    diagnostics: projectFound ? loaded.diagnostics : [],
    sources: [processEnvSource(io.env), dotenvSource(dir)],
  };
}

function select(project: Project, backend?: ModelBackendId): BackendSelection {
  const settings = backend ? { ...project.settings, backend } : project.settings;
  return resolveDecisionBackend(
    { secrets: project.config.secrets, decisions: settings },
    {
      sources: project.sources,
      ...(project.environment ? { environment: project.environment } : {}),
    },
  );
}

async function checkBackend(project: Project, id: ModelBackendId): Promise<BackendCheck> {
  const selection = select(project, id);
  const s = project.settings[id];
  const apiKey = selection.keys[id].key;
  return id === "laya"
    ? checkLaya({ baseUrl: s.baseUrl, model: s.model, apiKey })
    : checkSystemOne({
        backend: id,
        baseUrl: s.baseUrl,
        model: s.model,
        keySecret: s.keySecret,
        apiKey,
      });
}

const CHECK_LABEL: Record<BackendCheck["status"], string> = {
  ok: "ok",
  missing_key: "no key",
  invalid_key: "invalid key",
  unreachable: "unreachable",
  model_missing: "model missing",
  error: "error",
};

/** `--check`: every backend; exit 2 only when the selected one isn't usable. */
async function runCheck(options: DecisionsCommandOptions, io: CommandIo): Promise<number> {
  const project = loadDecisionsProject(options, io);
  const selection = select(project);
  const checks = await Promise.all(MODEL_BACKENDS.map((id) => checkBackend(project, id)));
  const selectedCheck = checks.find((c) => c.backend === selection.selected);
  const failed = selectedCheck !== undefined && selectedCheck.status !== "ok";
  if (options.json) {
    io.stdout(
      `${defaultRedactor.redact(JSON.stringify({ backend: selection.summary, selected: selection.selected, checks }, null, 2))}\n`,
    );
  } else {
    const rows = checks.map((c) => [
      c.backend === selection.selected ? `${c.backend} *` : c.backend,
      c.baseUrl,
      c.model,
      CHECK_LABEL[c.status],
      c.message,
    ]);
    const fixes = checks
      .filter((c) => c.fix && (c.status !== "ok" || c.backend === selection.selected))
      .map((c) => `  ${c.backend}: ${c.fix}`);
    io.stdout(
      `${defaultRedactor.redact(
        [
          `Backend  ${selection.summary}`,
          "",
          table([["BACKEND", "URL", "MODEL", "STATUS", "DETAILS"], ...rows]),
          "  (* selected)",
          ...(fixes.length ? ["", "Fixes", ...fixes] : []),
          ...(failed
            ? [
                "",
                `The selected backend (${selection.selected}) is not usable; decisions fall back to rules.`,
              ]
            : []),
        ].join("\n"),
      )}\n`,
    );
  }
  return failed ? 2 : 0;
}

function benchRow(r: BenchResult): string[] {
  const agree = r.decided ? `${r.agreement}/${r.decided}` : "-";
  return [
    r.backend,
    `${r.p50Ms} ms`,
    `${r.p95Ms} ms`,
    `${Math.round(r.withinDuringLimit * 100)}%`,
    `${Math.round(r.errorRate * 100)}%`,
    String(r.decided),
    String(r.escalated),
    agree,
    r.warmUpMs === null ? "-" : `${(r.warmUpMs / 1000).toFixed(1)} s`,
  ];
}

/** `--bench`: the demo task against one or all backends, after a warm-up. */
async function runBench(options: DecisionsCommandOptions, io: CommandIo): Promise<number> {
  const project = loadDecisionsProject(options, io);
  const n = Math.max(1, Math.min(1000, Number.parseInt(options.n ?? "50", 10) || 50));
  const selection = select(project);
  let targets: ModelBackendId[];
  if (options.backend === "all") targets = [...MODEL_BACKENDS];
  else if (options.backend) {
    if (!(MODEL_BACKENDS as readonly string[]).includes(options.backend)) {
      io.stdout(`Unknown backend "${options.backend}". Use jev, kev, laya or all.\n`);
      return 2;
    }
    targets = [options.backend as ModelBackendId];
  } else if (selection.selected !== "none") targets = [selection.selected];
  else {
    io.stdout(
      `No decision backend is selected (${selection.summary}).\nPick one to measure: --backend jev | kev | laya | all\n`,
    );
    return 2;
  }

  const results: BenchResult[] = [];
  const skipped: { backend: string; message: string; fix?: string }[] = [];
  for (const id of targets) {
    const check = await checkBackend(project, id);
    const backend = select(project, id).backend;
    if (check.status !== "ok" || !backend) {
      skipped.push({
        backend: id,
        message: check.message,
        ...(check.fix ? { fix: check.fix } : {}),
      });
      continue;
    }
    results.push(await benchBackend(backend, project.settings, { n }));
  }
  const laya = results.find((r) => r.backend === "laya");
  const layaTarget = laya ? { p50Ms: laya.p50Ms, met: laya.p50Ms < 100 } : null;
  if (options.json) {
    io.stdout(
      `${defaultRedactor.redact(JSON.stringify({ task: "page_is_error", n, results, skipped, layaTarget }, null, 2))}\n`,
    );
  } else {
    const lines = [
      `Bench  page_is_error × ${n} per backend (cache off, after a warm-up)`,
      "",
      results.length
        ? table([
            [
              "BACKEND",
              "P50",
              "P95",
              "≤100 MS",
              "ERRORS",
              "DECIDED",
              "ESCALATED",
              "AGREE",
              "WARM-UP",
            ],
            ...results.map(benchRow),
          ])
        : "  Nothing measured.",
    ];
    for (const r of results) {
      const failures = Object.entries(r.failures);
      if (failures.length)
        lines.push(`  ${r.backend} failures: ${failures.map(([k, v]) => `${k} ×${v}`).join(", ")}`);
    }
    if (layaTarget)
      lines.push(
        "",
        `Laya during-run target (p50 < 100 ms): ${layaTarget.met ? "met" : "MISSED"} (p50 ${layaTarget.p50Ms} ms)`,
      );
    if (skipped.length)
      lines.push(
        "",
        "Skipped",
        ...skipped.map((s) => `  ${s.backend}: ${s.message}${s.fix ? `\n    Fix: ${s.fix}` : ""}`),
      );
    io.stdout(`${defaultRedactor.redact(lines.join("\n"))}\n`);
  }
  return results.length === 0 ? 2 : 0;
}

/**
 * `decisions`: the configured decision backend, thresholds and registered tasks;
 * `--stats <runDir>` per-task metrics from a run folder; `--check` backend health;
 * `--bench` latency. Exit 2 on config errors, an unreadable run folder, or an
 * unusable selected backend (--check).
 */
export async function runDecisionsCommand(
  options: DecisionsCommandOptions,
  io: CommandIo,
): Promise<number> {
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
  if (options.check) return runCheck(options, io);
  if (options.bench) return runBench(options, io);

  const project = loadDecisionsProject(options, io);
  const { settings, diagnostics } = project;
  const selection = select(project);
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
  const problems = [
    ...selection.problems,
    ...Object.keys(settings.tasks)
      .filter((name) => !decisions.tasks.has(name))
      .map((name) => ({
        message: `decisions.tasks.${name} names no registered task.`,
        fix: `Use one of: ${tasks.map((t) => t.name).join(", ")}.`,
      })),
  ];
  const warnings = selection.warnings;
  const active = selection.selected === "none" ? null : settings[selection.selected];

  let output: string;
  if (options.json) {
    output = JSON.stringify(
      {
        file: project.file,
        environment: project.environment ?? null,
        backend: settings.backend,
        selected: selection.selected,
        summary: selection.summary,
        model: active?.model ?? null,
        baseUrl: active?.baseUrl ?? null,
        keys: Object.fromEntries(MODEL_BACKENDS.map((id) => [id, selection.keys[id].status])),
        threshold: settings.threshold,
        cache: settings.cache,
        tasks,
        problems,
        warnings,
        diagnostics,
      },
      null,
      2,
    );
  } else {
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
      ...warnings.map((p) => `  warning  ${p.message}\n           ${p.fix}`),
      ...diagnostics.map((d) => `  ${d.severity}  ${d.code}  ${d.message}\n         Fix: ${d.fix}`),
    ];
    output = [
      [
        `Project    ${project.file ?? "no project file here (using built-in defaults)"}`,
        `Backend    ${selection.summary}`,
        ...(active ? [`Model      ${active.model} at ${active.baseUrl}`] : []),
        `Threshold  ${settings.threshold.toFixed(2)} (project default)`,
        `Cache      ${cache}`,
      ].join("\n"),
      `Tasks\n${table([["TASK", "VER", "PHASE", "THRESHOLD", "LIMIT", "ENABLED", "ESCALATES TO", "QUESTIONS"], ...rows])}`,
      lines.length ? `Problems\n${lines.join("\n")}` : "No problems found.",
      `Check the backends with \`${brand.cliName} decisions --check\`.`,
    ].join("\n\n");
  }
  io.stdout(`${defaultRedactor.redact(output)}\n`);
  return hasErrors(diagnostics) ? 2 : 0;
}
