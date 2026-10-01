import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { brand } from "@optestra/brand";
import { findProject } from "@optestra/config/node";
import type { CommandIo } from "./config.js";

// `explain [runDir] [test]` (DIA-6): why a test failed, from the run's own
// evidence. Rules only (no AI) unless --ai, which makes one model call. Reads
// the run folder; never changes it.

export interface ExplainCommandOptions {
  ai?: boolean;
  json?: boolean;
  env?: string;
  dir?: string;
}

export async function runExplainCommand(
  args: string[],
  options: ExplainCommandOptions,
  io: CommandIo & { models?: import("@optestra/models").Models },
): Promise<number> {
  const fail = (message: string) => {
    io.stdout(options.json ? `${JSON.stringify({ error: message }, null, 2)}\n` : `${message}\n`);
    return 2;
  };
  const [first, second] = args;
  const isRun = (path: string | undefined) =>
    path !== undefined && existsSync(join(resolve(io.cwd, path), "run.json"));
  let runDir = isRun(first) ? resolve(io.cwd, first as string) : undefined;
  const test = runDir ? second : first;
  const project = options.dir
    ? resolve(io.cwd, options.dir)
    : (findProject(runDir ?? io.cwd) ?? findProject(io.cwd));
  if (!runDir) {
    const { latestRunDir } = await import("@optestra/report/node");
    runDir = project ? latestRunDir(project) : undefined;
    if (!runDir)
      return fail(
        project
          ? `No finished runs in this project. Run the tests first (${brand.cliName} run), or pass a run folder.`
          : `Not inside a project (no ${brand.configFileName} found). Pass a run folder.`,
      );
  }

  let models: import("@optestra/models").Models | undefined = io.models;
  let budget: import("@optestra/models").BudgetMeter | undefined;
  if (options.ai && !models) {
    if (!project) return fail("--ai needs the project (for its AI settings). Use -C <project>.");
    const m = await import("@optestra/models");
    const { dotenvSource, loadProject, processEnvSource } = await import("@optestra/config/node");
    const loaded = loadProject(project, { environment: options.env, env: io.env });
    budget = m.BudgetMeter.forRun(loaded.config);
    models = m.createModels({
      config: loaded.config,
      sources: [processEnvSource(io.env), dotenvSource(project)],
      environment: loaded.environment?.name,
      budgets: [budget],
      usageStore: m.projectUsageStore(project),
      env: io.env,
    });
    if (!models.pool("planner").some((entry) => entry.usable))
      return fail(
        "No AI model is available (no planner provider has a key). Run without --ai for the rules-only explanation.",
      );
  }

  const { explainRun, formatExplanation } = await import("@optestra/core/node");
  let result: Awaited<ReturnType<typeof explainRun>>;
  try {
    result = await explainRun(runDir, {
      ...(test ? { test } : {}),
      ...(options.ai && models ? { models, maxCalls: 1 } : {}),
      ...(budget ? { budget } : {}),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (options.json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.explanations.length || !test ? 0 : 2;
  }
  if (result.message) io.stdout(`${result.message}\n`);
  for (const [i, explanation] of result.explanations.entries())
    io.stdout(`${i ? "\n────────\n\n" : ""}${formatExplanation(explanation)}\n`);
  if (result.explanations.length > 1 && options.ai)
    io.stdout(
      "\nOnly the first test was explained with AI (one call per explain); the rest are rules-only.\n",
    );
  return result.explanations.length || !test ? 0 : 2;
}
