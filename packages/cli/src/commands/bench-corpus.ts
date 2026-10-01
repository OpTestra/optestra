import type { BenchCommandOptions } from "./bench.js";
import type { CommandIo } from "./config.js";

// `bench --corpus` (COST-0): the real-developer corpus, per phrasing style:
// lint, the phrase rules, authoring, false passes / fails across the variants,
// cosmetic heals, calls, tokens, list $ and time. `--static` is the free part
// (lint and phrase rules, no browser, no model). Real models spend calls:
// without --yes it prints the estimate and stops. The results go to
// bench/results/<date>-corpus-models.json.

const DEFAULT_ENTRY = "claude-code:claude-sonnet-5-5";

export async function runCorpusCommand(
  options: BenchCommandOptions,
  io: CommandIo,
): Promise<number> {
  const bench = await import("@optestra/core/bench");
  const dir = await bench.benchDir();
  const fixture = options.fixture ?? "shop";
  const fixtures = (fixture === "all" ? ["shop", "android"] : [fixture]) as Array<
    "shop" | "android"
  >;
  const styles = options.style?.length ? options.style : undefined;
  const tests = options.test?.length ? options.test : undefined;
  const route = options.route as "file" | "description" | undefined;
  if (route && route !== "file" && route !== "description") {
    io.stdout(`--route must be file or description, not "${route}".\n`);
    return 2;
  }
  const known = new Set(bench.loadStyles(dir).map((s) => s.id));
  const unknown = styles?.find((s) => !known.has(s));
  if (unknown) {
    io.stdout(`"${unknown}" isn't a corpus style: ${[...known].join(", ")}.\n`);
    return 2;
  }
  const entries = bench.selectEntries(bench.loadCorpus(dir), {
    fixtures,
    ...(styles ? { styles } : {}),
    ...(tests ? { tests } : {}),
  });
  if (entries.length === 0) {
    io.stdout("No corpus entries match those options.\n");
    return 2;
  }

  if (options.static) {
    const summary = await bench.analyzeCorpus(dir, entries);
    io.stdout(
      options.json ? `${JSON.stringify(summary, null, 2)}\n` : `${bench.formatStatic(summary)}\n`,
    );
    return 0;
  }

  const text = options.models?.[0] ?? (options.scripted ? "scripted:stand-in" : DEFAULT_ENTRY);
  const entry = bench.parseModelEntry(text);
  if (!entry) {
    io.stdout(`"${text}" isn't a pool entry: use provider:model, e.g. ${DEFAULT_ENTRY}.\n`);
    return 2;
  }
  const selection = {
    fixtures,
    ...(styles ? { styles } : {}),
    ...(tests ? { tests } : {}),
    ...(route ? { route } : {}),
    noCosmetic: options.cosmetic === false,
  };
  if (!options.scripted && !options.yes) {
    const estimate = await bench.estimateCorpus(dir, { ...selection, model: entry.model });
    io.stdout(
      `The corpus makes real AI calls with ${bench.entryId(entry)}, each style once:\n\n${bench.formatEstimate(estimate)}\n\nRun again with --yes to spend them, or trim with --style, --test and --route.\n`,
    );
    return 2;
  }
  const command = [
    "bench --corpus",
    `--models ${bench.entryId(entry)}`,
    ...(fixture !== "shop" ? [`--fixture ${fixture}`] : []),
    ...(styles ?? []).map((s) => `--style ${s}`),
    ...(tests ?? []).map((t) => `--test ${t}`),
    ...(route ? [`--route ${route}`] : []),
    ...(options.cosmetic === false ? ["--no-cosmetic"] : []),
    ...(options.scripted ? ["--scripted"] : []),
  ].join(" ");
  let saved: string | null = null;
  let file: Awaited<ReturnType<typeof bench.runCorpus>>;
  try {
    file = await bench.runCorpus({
      entry,
      scripted: options.scripted ?? false,
      ...selection,
      command,
      onProgress: options.json ? () => {} : (line) => io.stdout(`${line}\n`),
      // Real calls are saved after every style, so a crash later never loses them.
      onSave: (partial) => {
        if (!options.scripted) saved = bench.saveCorpus(dir, partial);
      },
    });
  } catch (error) {
    io.stdout(
      `${error instanceof Error ? error.message : String(error)}\n${saved ? `Saved so far: ${saved}\n` : ""}`,
    );
    return 2;
  }
  if (file.styles.length === 0) {
    io.stdout("Nothing ran (see the lines above for what was skipped and why).\n");
    return 2;
  }
  if (options.json) io.stdout(`${JSON.stringify(file, null, 2)}\n`);
  else io.stdout(`\n${bench.formatCorpus(file)}\n${saved ? `\nSaved: ${saved}\n` : ""}`);
  return file.styles.some((s) => s.problem) ? 1 : 0;
}
