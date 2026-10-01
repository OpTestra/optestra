import type { BenchCommandOptions } from "./bench.js";
import type { CommandIo } from "./config.js";

// `bench --compare` (EVAL-0): the model comparison and the cost facts for
// pricing. Real models spend calls: without --yes it only prints the estimate;
// each model runs once. The results go to bench/results/<date>-model-comparison.json.

export async function runCompareCommand(
  options: BenchCommandOptions,
  io: CommandIo,
): Promise<number> {
  const bench = await import("@optestra/core/bench");
  const texts = options.compare ?? [];
  const entries = texts.map((t) => ({ text: t, entry: bench.parseModelEntry(t) }));
  const bad = entries.find((e) => !e.entry);
  if (bad) {
    io.stdout(
      `"${bad.text}" isn't a pool entry: use provider:model, e.g. claude-code:claude-sonnet-4-6.\n`,
    );
    return 2;
  }
  const list = entries.map((e) => e.entry as NonNullable<(typeof e)["entry"]>);
  const android = options.fixture === "android" || options.fixture === "all";
  if (!options.scripted && !options.yes) {
    io.stdout(
      `A model comparison makes real AI calls, each model once: per model about 160–225 on the shop (authoring every test, fixer heals, 3 drafts, 2 explains, 1 CLI check)${android ? " and 75–95 on Android" : ""}. Models: ${list.map(bench.entryId).join(", ")}.\nRun again with --yes to spend them.\n`,
    );
    return 2;
  }
  let file: Awaited<ReturnType<typeof bench.runComparison>>;
  try {
    file = await bench.runComparison({
      entries: list,
      android,
      scripted: options.scripted ?? false,
      command: `bench --compare ${list.map(bench.entryId).join(" ")}${android ? " --fixture all" : ""}${options.scripted ? " --scripted" : ""}`,
      onProgress: options.json ? () => {} : (line) => io.stdout(`${line}\n`),
    });
  } catch (error) {
    io.stdout(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const saved = file.scripted ? null : bench.saveComparison(await bench.benchDir(), file);
  if (options.json) io.stdout(`${JSON.stringify(file, null, 2)}\n`);
  else io.stdout(`\n${bench.formatComparison(file)}\n${saved ? `\nSaved: ${saved}\n` : ""}`);
  return file.models.some((m) => m.problem) ? 1 : 0;
}
