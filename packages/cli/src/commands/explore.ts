import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { findProject, projectFile } from "@optestra/config/node";
import type { CommandIo } from "./config.js";

// `explore [url] --goal "…"` (EXPL-1, EXPL-2): roams the running app toward a
// goal with AI and reports what went wrong on the way (error pages, failed
// requests, console errors, broken links, dead ends), with evidence, and
// proposes regression tests as drafts. Findings never fail anything: the exit
// code is 0 unless exploring couldn't run. Drafts are saved only with --save-drafts.

export interface ExploreCommandOptions {
  goal?: string;
  start?: string;
  env?: string;
  json?: boolean;
  headed?: boolean;
  saveDrafts?: string;
  links?: string;
  dir?: string;
}

const posix = (path: string) => path.split(sep).join("/");

export async function runExploreCommand(
  url: string | undefined,
  options: ExploreCommandOptions,
  io: CommandIo & { explore?: typeof import("@optestra/core/node").exploreProject },
): Promise<number> {
  const fail = (message: string) => {
    io.stdout(options.json ? `${JSON.stringify({ error: message }, null, 2)}\n` : `${message}\n`);
    return 2;
  };
  if (!options.goal?.trim())
    return fail('Say what to explore toward: --goal "a visitor buys the Pro plan".');
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  if (!existsSync(projectFile(dir)))
    return fail(`No project file found in ${dir}. Create one first (${brand.cliName} init).`);
  let start = options.start;
  let baseUrl: string | undefined;
  if (url) {
    try {
      const parsed = new URL(url);
      baseUrl = parsed.origin;
      start ??= `${parsed.pathname}${parsed.search}`;
    } catch {
      return fail(`"${url}" is not a URL.`);
    }
  }
  const core = await import("@optestra/core/node");
  const explore = io.explore ?? core.exploreProject;
  if (!options.json) io.stdout(`Exploring toward "${options.goal.trim()}"…\n`);
  let result: Awaited<ReturnType<typeof core.exploreProject>>;
  try {
    result = await explore(baseUrl, options.goal.trim(), {
      project: dir,
      environment: options.env,
      start,
      env: io.env,
      headless: !options.headed,
      ...(options.links !== undefined ? { linkChecks: Number(options.links) } : {}),
    });
  } catch (error) {
    const fix = error instanceof core.DraftSetupError ? `\nFix: ${error.fix}` : "";
    return fail(
      `Could not explore: ${error instanceof Error ? error.message : String(error)}${fix}`,
    );
  }

  const drafts = [...(result.draft.items.length ? [result.draft] : []), ...result.proposals];
  const saved: string[] = [];
  if (options.saveDrafts) {
    const folder = resolve(io.cwd, options.saveDrafts);
    for (const draft of drafts) {
      const file = resolve(folder, draft.path.split("/").pop() as string);
      if (existsSync(file)) continue;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, draft.text, { flag: "wx" });
      saved.push(file);
    }
  }
  if (options.json) {
    const strip = <T extends { spec?: unknown; modelCalls?: unknown }>(d: T) => {
      const { spec: _s, modelCalls: _m, ...rest } = d;
      return rest;
    };
    io.stdout(
      `${JSON.stringify(
        {
          goal: result.goal,
          environment: result.environment,
          reached: result.draft.status === "drafted",
          findings: result.findings.map((f) => ({
            ...f,
            proposal: f.proposal ? strip(f.proposal) : undefined,
          })),
          draft: strip(result.draft),
          proposals: result.proposals.map(strip),
          linksChecked: result.linksChecked,
          aiCalls: result.modelCalls.length,
          notes: result.notes,
          saved,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const t = result.draft.totals;
  io.stdout(
    `\n${result.draft.status === "drafted" ? "Reached the goal" : `Didn't reach the goal (${result.draft.reason ?? result.draft.status})`} · ${result.draft.actions} actions · ${result.linksChecked} links checked · ${t.aiCalls} AI calls${t.billing === "subscription" ? " via your subscription" : `, $${t.costUsd.toFixed(4)}`}\n`,
  );
  io.stdout(
    result.findings.length
      ? `\nFindings (${result.findings.length}):\n`
      : "\nNo problems found on the way.\n",
  );
  for (const finding of result.findings) {
    io.stdout(`  ${finding.id} ${finding.kind.replace("_", " ")}: ${finding.summary}\n`);
    for (const line of finding.evidence.slice(0, 3)) io.stdout(`       ${line}\n`);
  }
  for (const draft of drafts) {
    io.stdout(
      `\nProposed test: ${draft.name} → ${draft.path}${draft.lintClean ? "" : " (lint problems)"}\n`,
    );
    io.stdout(`${draft.text.replace(/^(?=.)/gm, "    ")}`);
    for (const note of draft.notes) io.stdout(`    - ${note}\n`);
  }
  for (const note of result.notes) io.stdout(`\n${note}\n`);
  io.stdout(
    saved.length
      ? `\nDrafts written: ${saved.map((f) => posix(relative(io.cwd, f))).join(", ")}. Review them before moving them into your tests.\n`
      : "\nNothing was saved (findings are proposals: they never fail a run). Save the drafts with --save-drafts <folder>.\n",
  );
  return 0;
}
