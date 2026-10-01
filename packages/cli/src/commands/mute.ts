import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { findProject, loadProject, projectFile, saveProject } from "@optestra/config/node";
import type { ConfigPatch } from "@optestra/config";
import type { CommandIo } from "./config.js";

// `mute <test> --reason … --until …`, `unmute <test>`, `mute --list` (DIA-5):
// quarantine entries in the project file. A muted test still runs and keeps
// its evidence; its failure doesn't fail the run or the Action. A mute ends on
// its date (at most 90 days ahead); changing an existing one takes --renew.

export interface MuteCommandOptions {
  reason?: string;
  until?: string;
  renew?: boolean;
  list?: boolean;
  json?: boolean;
  dir?: string;
}

const posix = (path: string) => path.split(sep).join("/");

export async function runMuteCommand(
  test: string | undefined,
  options: MuteCommandOptions & { unmute?: boolean },
  io: CommandIo & { now?: () => Date },
): Promise<number> {
  const fail = (message: string) => {
    io.stdout(options.json ? `${JSON.stringify({ error: message }, null, 2)}\n` : `${message}\n`);
    return 2;
  };
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  if (!existsSync(projectFile(dir)))
    return fail(`No project file found in ${dir}. Create one first (${brand.cliName} init).`);
  const core = await import("@optestra/core");
  const { testIdFromPath } = await import("@optestra/contract");
  const now = (io.now ?? (() => new Date()))();
  const loaded = loadProject(dir, { env: io.env });
  const entries = loaded.config.quarantine ?? [];
  const today = core.todayOf(now);

  if (options.list || !test) {
    const rows = entries.map((e) => ({ ...e, active: e.until >= today }));
    if (options.json) io.stdout(`${JSON.stringify({ today, mutes: rows }, null, 2)}\n`);
    else if (rows.length === 0) io.stdout("No muted tests.\n");
    else
      for (const r of rows)
        io.stdout(
          `  ${r.active ? "muted  " : "expired"}  ${r.test}  until ${r.until}  ${r.reason}\n`,
        );
    return 0;
  }

  const absolute = resolve(io.cwd, test);
  const path = existsSync(absolute) ? posix(relative(dir, absolute)) : posix(test);
  const target = { path, id: testIdFromPath(path) };
  const save = (list: typeof entries) =>
    saveProject(dir, { quarantine: list } as unknown as ConfigPatch);

  if (options.unmute) {
    const { entries: next, removed } = core.withoutMute(entries, target);
    if (!removed) return fail(`${path} is not muted.`);
    const saved = save(next);
    if (!saved.ok) return fail(saved.diagnostics.map((d) => d.message).join(" "));
    io.stdout(
      options.json
        ? `${JSON.stringify({ unmuted: removed }, null, 2)}\n`
        : `Unmuted ${path}: its failures count again.\n`,
    );
    return 0;
  }

  if (!existsSync(resolve(dir, path))) return fail(`There is no test ${path} in the project.`);
  const change = core.withMute(
    entries,
    target,
    {
      reason: options.reason ?? "",
      until: options.until ?? "",
      ...(options.renew ? { renew: true } : {}),
    },
    now,
  );
  if (!change.ok) return fail(change.message);
  const saved = save(change.entries);
  if (!saved.ok) return fail(saved.diagnostics.map((d) => d.message).join(" "));
  io.stdout(
    options.json
      ? `${JSON.stringify({ muted: change.entry, renewed: change.renewed }, null, 2)}\n`
      : `${change.renewed ? "Renewed the mute of" : "Muted"} ${path} until ${change.entry.until} ("${change.entry.reason}"). It still runs; its failures don't fail the run until then. The mute is in ${brand.configFileName}: commit it so everyone sees it.\n`,
  );
  return 0;
}
