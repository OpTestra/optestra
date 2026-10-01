import { relative, resolve } from "node:path";
import { brand } from "@optestra/brand";
import { findProject } from "@optestra/config/node";
import type { CommandIo } from "./config.js";

// `heal [runDir]` (HEAL-4): the heals of a run (default: the latest) with the
// before/after of the recording, the why (HEAL-6) and the confidence; then
// `--accept <id…|all>` / `--reject <id…>` apply or drop them. Accepting changes
// only the healed step's commands, regenerates the spec, records the decision
// in the run folder and writes labels. Nothing is committed to git.

export interface HealCommandOptions {
  list?: boolean;
  accept?: string[];
  reject?: string[];
  json?: boolean;
  env?: string;
  dir?: string;
}

const shown = (cwd: string, path: string) => {
  const rel = relative(cwd, path);
  return rel.startsWith("..") ? path : rel || ".";
};

const LEVEL: Record<string, string> = {
  fallback: "fallback locator, no AI",
  refind: "re-found, no AI",
  fixer: "fixer model, AI",
};

export async function runHealCommand(
  runDir: string | undefined,
  options: HealCommandOptions,
  io: CommandIo,
): Promise<number> {
  const { latestRunDir } = await import("@optestra/report/node");
  const project = options.dir
    ? resolve(io.cwd, options.dir)
    : (findProject(runDir ? resolve(io.cwd, runDir) : io.cwd) ?? findProject(io.cwd));
  const dir = runDir ? resolve(io.cwd, runDir) : project ? latestRunDir(project) : undefined;
  const fail = (message: string) => {
    io.stdout(options.json ? `${JSON.stringify({ error: message }, null, 2)}\n` : `${message}\n`);
    return 2;
  };
  if (!dir)
    return fail(
      project
        ? `No finished runs in ${shown(io.cwd, project)}. Run the tests first, or pass a run folder.`
        : `Not inside a project (no ${brand.configFileName} found). Pass a run folder.`,
    );
  const { applyHeals, listHeals, BEHAVIOUR_WARNING } = await import("@optestra/core/node");
  let listing: ReturnType<typeof listHeals>;
  try {
    listing = listHeals(dir);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const where = shown(io.cwd, dir);

  // ── accept / reject ─────────────────────────────────────────────────────────
  const accept = options.accept ?? [];
  const reject = options.reject ?? [];
  if (!options.list && (accept.length > 0 || reject.length > 0)) {
    if (!project) return fail(`Not inside a project (no ${brand.configFileName} found). Use -C.`);
    const ids = accept.some((id) => id === "all") ? "all" : accept;
    const result = await applyHeals(project, dir, ids, {
      reject,
      ...(options.env ? { environment: options.env } : {}),
      env: io.env,
    });
    if (options.json) {
      io.stdout(`${JSON.stringify({ runDir: dir, runId: listing.runId, ...result }, null, 2)}\n`);
      return result.skipped.length > 0 ? 1 : 0;
    }
    for (const heal of result.accepted)
      io.stdout(`Accepted ${heal.id}  ${heal.file} step ${heal.stepIndex + 1} "${heal.step}"\n`);
    for (const heal of result.rejected)
      io.stdout(`Rejected ${heal.id}  ${heal.file} step ${heal.stepIndex + 1} "${heal.step}"\n`);
    for (const skip of result.skipped) io.stdout(`Skipped  ${skip.id}: ${skip.reason}\n`);
    for (const file of result.recordings) io.stdout(`Updated  ${file}\n`);
    for (const file of result.specs) io.stdout(`Regenerated ${file}\n`);
    for (const warning of result.warnings) io.stdout(`  warning: ${warning}\n`);
    if (result.accepted.length + result.rejected.length === 0 && result.skipped.length === 0)
      io.stdout(`Nothing to accept or reject in ${where}.\n`);
    if (result.labels > 0) io.stdout(`${result.labels} labels written (LRN-9).\n`);
    if (result.accepted.length > 0)
      io.stdout(
        "The next run replays the accepted steps with no AI. Review and commit the recording yourself.\n",
      );
    return result.skipped.length > 0 ? 1 : 0;
  }

  // ── list ────────────────────────────────────────────────────────────────────
  if (options.json) {
    io.stdout(`${JSON.stringify(listing, null, 2)}\n`);
    return 0;
  }
  const pending = listing.heals.filter((h) => h.status === "pending").length;
  const counts = ["pending", "accepted", "rejected"]
    .map((status) => [status, listing.heals.filter((h) => h.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`);
  io.stdout(
    listing.heals.length === 0
      ? `No heals in ${where}.\n`
      : `Heals in ${where} (${counts.join(", ")})\n`,
  );
  for (const heal of listing.heals) {
    const level = heal.level ? LEVEL[heal.level] : "heal";
    io.stdout(
      `\n  ${heal.id}  ${heal.status.toUpperCase()}${heal.appliedBy ? ` (by ${heal.appliedBy})` : ""}\n  ${heal.file} › step ${heal.stepIndex + 1} "${heal.step}"\n  ${level} · ${heal.classification.replace("_", " ")} · confidence ${Math.round(heal.confidence * 100)}%\n`,
    );
    if (heal.behaviourChange)
      io.stdout(`  ⚠ ${BEHAVIOUR_WARNING[0]?.toUpperCase()}${BEHAVIOUR_WARNING.slice(1)}.\n`);
    for (const line of heal.before) io.stdout(`    - ${line}\n`);
    for (const line of heal.after) io.stdout(`    + ${line}\n`);
    if (heal.before.length === 0 && heal.after.length === 0)
      for (const change of heal.changes)
        io.stdout(`    ${change.target}: ${change.before} → ${change.after}\n`);
    for (const line of heal.why) io.stdout(`    why: ${line}\n`);
    if (heal.problem && heal.status === "pending") io.stdout(`    can't accept: ${heal.problem}\n`);
  }
  for (const flag of listing.rerecord)
    io.stdout(
      `\nRe-record this test: ${flag.file} healed ${flag.healed} times in its last ${flag.runs} runs.\n  ${flag.command}\n`,
    );
  if (pending > 0)
    io.stdout(
      `\nAccept: ${brand.cliName} heal ${where} --accept all   (or --accept <id>, --reject <id>)\n`,
    );
  return 0;
}
