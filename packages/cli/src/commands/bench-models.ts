import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brand } from "@testament/brand";
import type { ModelEvalFile } from "@testament/core/bench";
import type { BenchCommandOptions } from "./bench.js";
import type { CommandIo } from "./config.js";

// `bench --models` (MOD-9): authoring, check compiling and fixer heals with each
// listed model, on the shop. Real models spend calls: without --yes it only
// prints the estimate (so a person decides first); each model runs once. Real
// results are written to bench/results/ to be committed. `--scripted` runs the
// same pipeline with a stand-in that spends nothing (CI).

/** The model the gate compares candidates with: the default planner. */
export const REFERENCE_MODEL = "claude-sonnet-4-6";

/** The reference model's false passes in the newest real model eval, or null. */
export function referenceFalsePasses(benchDir: string): number | null {
  const dir = join(benchDir, "results");
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as ModelEvalFile;
      if (data.kind !== "model-eval" || data.scripted) continue;
      const reference = data.models.find(
        (m) => m.model.endsWith(`:${REFERENCE_MODEL}`) && m.problem === null,
      );
      if (reference) return reference.falsePasses;
    } catch {
      // Skip what can't be read.
    }
  }
  return null;
}

export async function modelEval(
  options: Pick<BenchCommandOptions, "models" | "scripted" | "yes" | "json">,
  io: CommandIo,
): Promise<
  | { ok: true; results: ModelEvalFile; reference: number | null; saved: string | null }
  | { ok: false; code: number }
> {
  const bench = await import("@testament/core/bench");
  const texts = options.models?.length
    ? options.models
    : options.scripted
      ? ["scripted:stand-in"]
      : [];
  const entries = texts.map((t) => ({ text: t, entry: bench.parseModelEntry(t) }));
  const bad = entries.find((e) => !e.entry);
  if (bad) {
    io.stdout(
      `"${bad.text}" isn't a pool entry: use provider:model, e.g. claude-code:claude-sonnet-4-6 or openrouter:z-ai/glm-4.6.\n`,
    );
    return { ok: false, code: 2 };
  }
  let shop: Awaited<ReturnType<typeof bench.shopFixture>>;
  try {
    shop = await bench.shopFixture();
  } catch (error) {
    io.stdout(`${error instanceof Error ? error.message : String(error)}\n`);
    return { ok: false, code: 2 };
  }
  const list = entries.map((e) => e.entry as NonNullable<(typeof e)["entry"]>);
  if (!options.scripted && !options.yes) {
    const { low, high } = bench.estimateCalls(shop);
    io.stdout(
      `A model eval makes real AI calls: about ${low}–${high} per model on the shop (authoring every test, compiling checks, fixer heals on cosmetic), ${list.length} model${list.length === 1 ? "" : "s"}: ${list.map(bench.entryId).join(", ")}. Each model runs once.\nRun again with --yes to spend them.\n`,
    );
    return { ok: false, code: 2 };
  }
  const results = await bench.runModelEval({
    entries: list,
    scripted: options.scripted ?? false,
    command: `bench ${options.scripted ? "--scripted" : `--models ${list.map(bench.entryId).join(" ")}`}`,
    onProgress: options.json ? () => {} : (line) => io.stdout(`${line}\n`),
  });
  const saved = results.scripted ? null : bench.saveModelEval(shop.benchDir, results);
  return { ok: true, results, reference: referenceFalsePasses(shop.benchDir), saved };
}

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((c, i) => c.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function formatModelEval(file: ModelEvalFile): string {
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const rows = [
    [
      "MODEL",
      "AUTHORED",
      "PASSED",
      "FALSE PASS",
      "FALSE FAIL",
      "FIXER HEALS",
      "COSMETIC OK",
      "CALLS",
      "TOKENS IN/OUT",
      "COST",
      "TIME",
    ],
    ...file.models.map((m) => [
      m.model,
      `${m.authoring.stepsAuthored} steps, ${m.authoring.checksCompiled} checks`,
      `${m.authoring.passed}/${m.authoring.tests}`,
      `${m.replay.falsePass.count}/${m.replay.falsePass.of}`,
      `${m.replay.falseFail.count}/${m.replay.falseFail.of}`,
      String(m.fixer.healedByFixer),
      `${m.fixer.passedOrHealed}/${m.fixer.tests}`,
      `${m.authoring.aiCalls + m.fixer.aiCalls}${m.authoring.subscriptionCalls ? ` (${m.authoring.subscriptionCalls} subscr.)` : ""}`,
      `${m.authoring.tokens.input}/${m.authoring.tokens.output}`,
      usd(m.authoring.costUsd + m.fixer.costUsd),
      `${(m.authoring.durationMs / 1000).toFixed(0)}s`,
    ]),
  ];
  const problems = file.models.filter((m) => m.problem).map((m) => `  ${m.model}: ${m.problem}`);
  const cases = file.models.flatMap((m) => [
    ...m.replay.falsePass.cases.map((c) => `  ${m.model} FALSE PASS ${c}`),
    ...m.replay.falseFail.cases.map((c) => `  ${m.model} false fail ${c}`),
  ]);
  return [
    `Model eval · shop · engine ${file.engineVersion}${file.commit ? ` (${file.commit})` : ""} · ${file.date.slice(0, 10)}${file.scripted ? " · SCRIPTED stand-in (no real model)" : ""}`,
    `Reproduce: ${brand.cliName} ${file.command}`,
    "",
    table(rows),
    ...(cases.length ? ["", ...cases] : []),
    ...(problems.length ? ["", "Stopped early:", ...problems] : []),
  ].join("\n");
}

export async function runModelEvalCommand(
  options: BenchCommandOptions,
  io: CommandIo,
): Promise<number> {
  const result = await modelEval(options, io);
  if (!result.ok) return result.code;
  if (options.json) io.stdout(`${JSON.stringify(result.results, null, 2)}\n`);
  else {
    io.stdout(`\n${formatModelEval(result.results)}\n`);
    if (result.saved)
      io.stdout(`\nSaved: ${result.saved} (commit it with the change it supports)\n`);
  }
  return result.results.models.some((m) => m.problem) ? 1 : 0;
}
