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
  EVAL_TASKS,
  type EvalReport,
  loadEvalSet,
  runEval,
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
  /** Score the after-run tasks on the committed eval sets. */
  eval?: boolean;
  /** For --eval with a backend: turn the rules off to measure the model alone. */
  modelOnly?: boolean;
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

/** The routing from config, or with every phase forced to one backend (for --check, --bench, --eval). */
function select(project: Project, backend?: ModelBackendId): BackendSelection {
  const settings = backend
    ? { ...project.settings, backend, during: backend, after: backend }
    : project.settings;
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
  const used = new Set<string>([selection.during.selected, selection.after.selected]);
  const checks = await Promise.all(MODEL_BACKENDS.map((id) => checkBackend(project, id)));
  const unusable = checks.filter((c) => used.has(c.backend) && c.status !== "ok");
  const failed = unusable.length > 0;
  const routing = `during ${selection.during.summary} · after ${selection.after.summary}`;
  if (options.json) {
    io.stdout(
      `${defaultRedactor.redact(JSON.stringify({ during: selection.during.summary, after: selection.after.summary, checks }, null, 2))}\n`,
    );
  } else {
    const rows = checks.map((c) => [
      used.has(c.backend) ? `${c.backend} *` : c.backend,
      c.baseUrl,
      c.model,
      CHECK_LABEL[c.status],
      c.message,
    ]);
    const fixes = checks
      .filter((c) => c.fix && (c.status !== "ok" || used.has(c.backend)))
      .map((c) => `  ${c.backend}: ${c.fix}`);
    io.stdout(
      `${defaultRedactor.redact(
        [
          `Routing  ${routing}`,
          "",
          table([["BACKEND", "URL", "MODEL", "STATUS", "DETAILS"], ...rows]),
          "  (* selected)",
          ...(fixes.length ? ["", "Fixes", ...fixes] : []),
          ...(failed
            ? [
                "",
                `A selected backend (${unusable.map((c) => c.backend).join(", ")}) is not usable; those decisions fall back to rules.`,
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
  } else if (selection.after.selected !== "none" || selection.during.selected !== "none") {
    targets = [
      ...new Set(
        [selection.during.selected, selection.after.selected].filter(
          (id): id is ModelBackendId => id !== "none",
        ),
      ),
    ];
  } else {
    io.stdout(
      `No decision backend is selected (during ${selection.during.summary}; after ${selection.after.summary}).\nPick one to measure: --backend jev | kev | laya | all\n`,
    );
    return 2;
  }

  const results: BenchResult[] = [];
  const skipped: { backend: string; message: string; fix?: string }[] = [];
  for (const id of targets) {
    const check = await checkBackend(project, id);
    const backend = select(project, id).after.backend;
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
 * `--eval [--backend rules|jev|kev|laya]`: the after-run tasks on the committed
 * eval sets. Exit 1 when any decided answer is wrong (a false label), 2 when the
 * backend can't be used.
 */
/**
 * The decision evals for one backend (rules, or rules then a model): every
 * after-run task on its committed eval set. Also the first half of `eval`.
 * A string is a problem to print (exit 2).
 */
export async function decisionEvals(
  options: Pick<DecisionsCommandOptions, "backend" | "modelOnly" | "dir" | "env">,
  io: CommandIo,
): Promise<
  | {
      ok: true;
      choice: string;
      reports: EvalReport[];
      usage:
        | ReturnType<NonNullable<ReturnType<typeof select>["after"]["backend"]>["usage"]>
        | undefined;
    }
  | { ok: false; message: string }
> {
  const project = loadDecisionsProject(options, io);
  const choice = options.backend ?? "rules";
  if (choice !== "rules" && !(MODEL_BACKENDS as readonly string[]).includes(choice))
    return { ok: false, message: `Unknown backend "${choice}". Use rules, jev, kev or laya.` };
  let backend = null;
  if (choice !== "rules") {
    const id = choice as ModelBackendId;
    const check = await checkBackend(project, id);
    backend = select(project, id).after.backend;
    if (check.status !== "ok" || !backend)
      return {
        ok: false,
        message: `${id} can't be used: ${check.message}${check.fix ? `\nFix: ${check.fix}` : ""}`,
      };
    if (backend.warmUp) await backend.warmUp({ timeoutMs: project.settings.laya.warmUpTimeoutMs });
  }
  // Comparing models: lift the during-run limits so a slow model (Jev) is measured, not skipped.
  const DURING = ["page_is_error", "same_element", "miss_action"];
  const settings = backend
    ? {
        ...project.settings,
        tasks: {
          ...project.settings.tasks,
          ...Object.fromEntries(
            DURING.map((t) => [t, { ...project.settings.tasks[t], timeLimitMs: 10_000 }]),
          ),
        },
      }
    : project.settings;
  const decisions = createDecisions({
    config: { decisions: settings },
    backend,
    bypassCache: true,
    ...(options.modelOnly && backend ? { skipRules: true } : {}),
  });
  const reports: EvalReport[] = [];
  for (const task of EVAL_TASKS)
    reports.push(await runEval(decisions, task, loadEvalSet(task), { backend: choice }));
  return { ok: true, choice, reports, usage: backend?.usage() };
}

async function runEvalCommand(options: DecisionsCommandOptions, io: CommandIo): Promise<number> {
  const evaluated = await decisionEvals(options, io);
  if (!evaluated.ok) {
    io.stdout(`${evaluated.message}\n`);
    return 2;
  }
  const { choice, reports, usage } = evaluated;
  const backend = choice !== "rules";
  if (options.json) {
    io.stdout(
      `${defaultRedactor.redact(JSON.stringify({ backend: choice, modelOnly: Boolean(options.modelOnly && backend), reports, usage: usage ?? null }, null, 2))}\n`,
    );
  } else {
    const rows = reports.map((r) => [
      r.task,
      String(r.cases),
      `${r.decided} (${r.decidedPct}%)`,
      `${r.escalated} (${r.escalatedPct}%)`,
      `${Math.round(r.accuracy * 1000) / 10}%`,
      String(r.falseLabels),
      `${r.p50Ms} ms`,
      r.modelP50Ms === null ? "-" : `${r.modelP50Ms} ms (${r.modelCalls})`,
      `${r.byRules}/${r.byModel}`,
    ]);
    const lines = [
      `Eval  decisions · ${choice === "rules" ? "rules only" : options.modelOnly ? `${choice} alone (rules off)` : `rules → ${choice}`}`,
      "",
      table([
        [
          "TASK",
          "CASES",
          "DECIDED",
          "ESCALATED",
          "ACCURACY",
          "FALSE",
          "P50",
          "MODEL P50 (CALLS)",
          "RULES/MODEL",
        ],
        ...rows,
      ]),
      "",
      "Escalations",
      ...reports.map(
        (r) =>
          `  ${r.task}: ${
            Object.entries(r.escalations)
              .map(([reason, n]) => `${reason} ×${n}`)
              .join(", ") || "none"
          }`,
      ),
    ];
    const mistakes = reports.flatMap((r) => r.mistakes.map((m) => ({ ...m, task: r.task })));
    if (mistakes.length)
      lines.push(
        "",
        "False labels",
        ...mistakes.map(
          (m) =>
            `  ${m.task} ${m.id}: expected ${m.expected}, got ${m.got} (${m.source}, ${m.confidence})`,
        ),
      );
    if (backend)
      lines.push(
        "",
        "During-run tasks ran with their 100 ms limit lifted, to compare models; in a run a model slower than the limit is skipped.",
      );
    if (usage)
      lines.push(
        "",
        `Backend usage: ${usage.requests} requests, ${usage.inputTokens} input tokens, $${usage.costUsd.toFixed(4)}`,
      );
    io.stdout(`${defaultRedactor.redact(lines.join("\n"))}\n`);
  }
  return reports.some((r) => r.falseLabels > 0) ? 1 : 0;
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
  if (options.eval) return runEvalCommand(options, io);

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
  const phases = (["during", "after"] as const).map((phase) => {
    const route = selection[phase];
    const s = route.selected === "none" ? null : settings[route.selected];
    return { phase, ...route, model: s?.model ?? null, baseUrl: s?.baseUrl ?? null };
  });

  let output: string;
  if (options.json) {
    output = JSON.stringify(
      {
        file: project.file,
        environment: project.environment ?? null,
        backend: settings.backend,
        during: phases[0] && { ...phases[0], backend: undefined },
        after: phases[1] && { ...phases[1], backend: undefined },
        skipAfterTimeouts: settings.skipAfterTimeouts,
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
        ...phases.map(
          (p) =>
            `${p.phase === "during" ? "During " : "After  "}    ${p.summary}${p.model ? ` · ${p.model} at ${p.baseUrl}` : ""}`,
        ),
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
