import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { brand } from "@testament/brand";
import { baselinePath } from "./bench.js";
import type { CommandIo } from "./config.js";

// `eval` (LRN-10, CLI-1): the gate for changing a default model, prompt or
// decision backend. It runs the decision evals with the candidate backend and
// Bench's false-pass check (replay of every variant), and — for a model —
// the model eval, then compares each with the committed baseline. Exit 1 on any
// rise in false passes or false labels (or no baseline to compare with), 2 when
// it can't run. It never changes a test result or a default: it only says
// whether the evidence allows the change.

export interface EvalCommandOptions {
  /** Decision backend to evaluate: rules (default), jev, kev, laya. */
  backend?: string;
  /** Candidate planner/fixer models (provider:model), evaluated like `bench --models`. */
  models?: string[];
  fixture?: string;
  /** Write the decision eval results into the baseline (after an accepted change). */
  saveBaseline?: boolean;
  /** Skip Bench (decision evals only). */
  bench?: boolean;
  yes?: boolean;
  dir?: string;
  env?: string;
  json?: boolean;
}

export async function runEvalCommand(options: EvalCommandOptions, io: CommandIo): Promise<number> {
  const bench = await import("@testament/core/bench");
  const { decisionEvals } = await import("./decisions.js");
  const say = options.json ? () => {} : (line: string) => io.stdout(`${line}\n`);

  // 1. The decision evals, with the candidate backend.
  say(`Decision evals (${options.backend ?? "rules"})…`);
  const evaluated = await decisionEvals(
    {
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.dir ? { dir: options.dir } : {}),
      ...(options.env ? { env: options.env } : {}),
    },
    io,
  );
  if (!evaluated.ok) {
    io.stdout(`${evaluated.message}\n`);
    return 2;
  }
  const decisions = {
    backend: evaluated.choice,
    tasks: evaluated.reports.map((r) => ({
      task: r.task,
      cases: r.cases,
      decided: r.decided,
      falseLabels: r.falseLabels,
    })),
  };

  // 2. Bench's false passes (replay of every variant, no AI), against the baseline.
  let dir: string;
  try {
    dir = await bench.benchDir();
  } catch (error) {
    io.stdout(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const file = baselinePath(dir);
  const baseline = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Awaited<ReturnType<typeof bench.runBench>>)
    : null;
  let benchNow: Awaited<ReturnType<typeof bench.runBench>> | undefined;
  if (options.bench !== false) {
    const fixture = (options.fixture ?? "shop") as "shop" | "android" | "all";
    say(`Bench false-pass check (${fixture}, every variant once, no AI)…`);
    benchNow = await bench.runBench({
      fixture,
      reruns: 1,
      equivalence: false,
      command: `eval --fixture ${fixture}`,
      onProgress: say,
    });
  }

  // 3. Candidate models: their own false passes against the reference model's.
  let models:
    | { now: { model: string; falsePasses: number }[]; baseline: number | null }
    | undefined;
  if (options.models?.length) {
    const { modelEval } = await import("./bench-models.js");
    const result = await modelEval(
      {
        models: options.models,
        ...(options.yes ? { yes: true } : {}),
        json: options.json ?? false,
      },
      io,
    );
    if (!result.ok) return result.code;
    models = {
      now: result.results.models.map((m) => ({ model: m.model, falsePasses: m.falsePasses })),
      baseline: result.reference,
    };
  }

  // The first --save-baseline seeds the decision baseline (there is nothing to compare with yet).
  const seeding = Boolean(options.saveBaseline && baseline && !baseline.decisions);
  if (seeding && baseline) {
    baseline.decisions = decisions;
    say("No decision eval baseline yet: seeded from this run.");
  }
  const gate = bench.evalGate({
    decisions: { now: decisions, baseline: baseline?.decisions ?? null },
    ...(benchNow ? { bench: { now: benchNow, baseline } } : {}),
    ...(models ? { models } : {}),
  });
  if (options.saveBaseline && gate.passed && baseline) {
    writeFileSync(file, `${JSON.stringify({ ...baseline, decisions }, null, 2)}\n`);
    say(`Saved the decision evals to the baseline: ${file}`);
  } else if (options.saveBaseline && !baseline) {
    io.stdout(`No baseline to add to: run ${brand.cliName} bench --save-baseline first.\n`);
    return 2;
  }
  if (options.json)
    io.stdout(`${JSON.stringify({ gate, decisions, bench: benchNow?.total ?? null }, null, 2)}\n`);
  else
    io.stdout(
      `\nEval gate (LRN-10): ${gate.passed ? "PASSED" : "FAILED"}\n${gate.lines.map((l) => `  ${l}`).join("\n")}\n${gate.passed ? "" : "\nThe change isn't supported by the evidence: keep the current default.\n"}`,
    );
  return gate.exitCode;
}
