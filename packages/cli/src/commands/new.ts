import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { findProject, projectFile } from "@optestra/config/node";
import type { CommandIo } from "./config.js";

// `new "<sentence>"` (AUT-7, "Describe it"): explores the app and drafts a
// test for one sentence. It prints the draft and where it would go; it writes
// only with --out <file> (anywhere, e.g. to edit it first) or --accept (into
// the tests folder, and only when lint is clean). In a terminal it asks before
// saving to the tests folder, which counts as --accept. Never over an existing file.

export interface NewCommandOptions {
  out?: string;
  accept?: boolean;
  start?: string;
  env?: string;
  headed?: boolean;
  json?: boolean;
  dir?: string;
}

const posix = (path: string) => path.split(sep).join("/");
const shown = (cwd: string, path: string) => {
  const rel = relative(cwd, path);
  return rel.startsWith("..") ? path : posix(rel);
};

/** Exit 0: drafted (and saved if asked). 1: not lint-clean or not finished. 2: can't draft, or refused to write. */
export async function runNewCommand(
  sentence: string,
  options: NewCommandOptions,
  io: CommandIo & {
    confirm?: (question: string) => Promise<boolean>;
    /** Test hook: drafts without a browser or AI. */
    draft?: typeof import("@optestra/core/node").draftTest;
  },
): Promise<number> {
  const fail = (message: string, code = 2) => {
    io.stdout(options.json ? `${JSON.stringify({ error: message }, null, 2)}\n` : `${message}\n`);
    return code;
  };
  if (!sentence.trim())
    return fail(
      `Describe the test in one sentence: ${brand.cliName} new "a returning user can log in".`,
    );
  if (options.out && options.accept) return fail("Choose one of --out and --accept.");
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  if (!existsSync(projectFile(dir)))
    return fail(`No project file found in ${dir}. Create one first (${brand.cliName} init).`);

  const core = await import("@optestra/core/node");
  const { DraftSetupError } = core;
  const draftTest = io.draft ?? core.draftTest;
  if (!options.json) io.stdout(`Drafting "${sentence.trim()}" by exploring the app…\n`);
  let draft: Awaited<ReturnType<typeof draftTest>>;
  try {
    draft = await draftTest(sentence.trim(), {
      project: dir,
      environment: options.env,
      start: options.start,
      env: io.env,
      headless: !options.headed,
      onEvent: options.json
        ? undefined
        : (event) => {
            if (event.type === "item")
              io.stdout(
                `  + ${event.item.kind === "expect" ? `Expect: ${event.item.text}   (${event.item.check.summary})` : event.item.text}\n`,
              );
          },
    });
  } catch (error) {
    if (error instanceof DraftSetupError) return fail(`${error.message}\nFix: ${error.fix}`);
    const fix =
      error instanceof Error && "fix" in error && typeof error.fix === "string"
        ? `\nFix: ${error.fix}`
        : "";
    return fail(`Could not draft: ${error instanceof Error ? error.message : String(error)}${fix}`);
  }

  if (!options.json) {
    const t = draft.totals;
    const ai =
      t.billing === "subscription"
        ? `${t.aiCalls} AI calls via your subscription`
        : `${t.aiCalls} AI calls, $${t.costUsd.toFixed(4)}`;
    const status =
      draft.status === "drafted"
        ? "Drafted"
        : draft.status === "impossible"
          ? `Couldn't draft it: ${draft.message ?? "the goal can't be done on this app"}`
          : `${draft.status === "stopped" ? "Stopped" : "Unfinished"} (${draft.reason ?? "?"}): ${draft.message ?? ""}`;
    io.stdout(
      `\n${status} · ${draft.actions} actions · ${ai} · ${(draft.durationMs / 1000).toFixed(1)} s\n\n`,
    );
    io.stdout(`${draft.text.replace(/^(?=.)/gm, "    ")}\n`);
    io.stdout(
      draft.lintClean
        ? `Lint: clean${draft.fixed.length ? ` (fixed: ${draft.fixed.join("; ")})` : ""}.\n`
        : "Lint: problems to fix before it can be saved:\n",
    );
    for (const note of draft.notes) io.stdout(`  - ${note}\n`);
  }

  // Where it goes, only when asked: --out, --accept, or yes to the question in a terminal.
  let written: string | undefined;
  let refused: string | undefined;
  let accept = options.accept ?? false;
  let declined = false;
  if (!accept && !options.out && !options.json && io.confirm && draft.lintClean) {
    accept = await io.confirm(`\nSave it as ${shown(io.cwd, draft.absolutePath)}?`);
    declined = !accept;
  }
  const target = options.out
    ? resolve(io.cwd, options.out)
    : accept
      ? draft.absolutePath
      : undefined;
  if (target) {
    if (accept && !draft.lintClean)
      refused =
        "Not saved: the draft doesn't lint clean. Save it elsewhere to edit it (--out <file>), or describe the test more precisely.";
    else if (accept && (draft.status === "impossible" || draft.status === "stopped"))
      refused = `Not saved: the draft is ${draft.status}.`;
    else if (existsSync(target)) refused = `Not saved: ${shown(io.cwd, target)} already exists.`;
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, draft.text, { flag: "wx" });
      written = target;
    }
  }

  const code = refused
    ? 2
    : draft.lintClean && draft.status === "drafted"
      ? 0
      : draft.status === "stopped"
        ? 2
        : 1;
  if (options.json) {
    const { spec: _spec, modelCalls: _calls, ...rest } = draft;
    io.stdout(
      `${JSON.stringify({ ...rest, saved: written ? shown(io.cwd, written) : null, ...(refused ? { refused } : {}) }, null, 2)}\n`,
    );
    return code;
  }
  if (written)
    io.stdout(
      `\nSaved ${shown(io.cwd, written)}. Next: record it with ${brand.cliName} author ${shown(io.cwd, written)}\n`,
    );
  else if (refused) io.stdout(`\n${refused}\n`);
  else
    io.stdout(
      `\nNot saved.${declined ? "" : ` It would go to ${shown(io.cwd, draft.absolutePath)}: run again with --accept to save it there, or write it elsewhere with --out <file>.`}\n`,
    );
  return code;
}
