import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { findProject, projectFile } from "@optestra/config/node";
import type { CommandIo } from "./config.js";

// `record` (AUT-8): opens a browser window on the app; you click through it and
// mark what you expect (the overlay's "Expect text" / "Expect URL", or
// Alt+Shift+E), then Finish (or close the window, or Ctrl-C). It prints the test
// and saves it with its recording, which replays with no AI, only when you say
// so (--accept, --out, or yes in a terminal). Typed values become templates:
// never a password in the file.

export interface RecordCommandOptions {
  url?: string;
  start?: string;
  name?: string;
  out?: string;
  accept?: boolean;
  env?: string;
  browser?: string;
  dir?: string;
}

const posix = (path: string) => path.split(sep).join("/");
const shown = (cwd: string, path: string) => {
  const rel = relative(cwd, path);
  return rel.startsWith("..") ? path : posix(rel);
};

export async function runRecordCommand(
  options: RecordCommandOptions,
  io: CommandIo & {
    confirm?: (question: string) => Promise<boolean>;
    signal?: AbortSignal;
    /** Test hook: records without a window (see core recordProject). */
    record?: typeof import("@optestra/core/node").recordProject;
  },
): Promise<number> {
  if (options.out && options.accept) {
    io.stdout("Choose one of --out and --accept.\n");
    return 2;
  }
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  if (!existsSync(projectFile(dir))) {
    io.stdout(`No project file found in ${dir}. Create one first (${brand.cliName} init).\n`);
    return 2;
  }
  let start = options.start;
  let baseUrl: string | undefined;
  if (options.url) {
    try {
      const url = new URL(options.url);
      baseUrl = url.origin;
      start = `${url.pathname}${url.search}`;
    } catch {
      if (!options.url.startsWith("/")) {
        io.stdout(`--url must be a URL or a path on the app, not "${options.url}".\n`);
        return 2;
      }
      start = options.url;
    }
  }
  const core = await import("@optestra/core/node");
  const record = io.record ?? core.recordProject;
  io.stdout(
    "Recording: a browser window opens. Click through the app; mark what you expect with the overlay (Expect text / Expect URL) or Alt+Shift+E, then press Finish (or close the window, or Ctrl-C here).\n",
  );
  let recorded: Awaited<ReturnType<typeof core.recordProject>>;
  try {
    recorded = await record({
      project: dir,
      environment: options.env,
      start,
      ...(baseUrl ? { baseUrl } : {}),
      name: options.name,
      env: io.env,
      ...(options.browser ? { browser: options.browser as "chromium" | "firefox" | "webkit" } : {}),
      signal: io.signal,
      onProgress: (line) => {
        if (line.type === "step") io.stdout(`  + ${line.text}\n`);
        if (line.type === "expect") io.stdout(`  + Expect: ${line.text}   (${line.summary})\n`);
        if (line.type === "refused") io.stdout(`  ! not added: ${line.text}: ${line.message}\n`);
        if (line.type === "note") io.stdout(`  ! ${line.message}\n`);
      },
    });
  } catch (error) {
    const fix = error instanceof core.DraftSetupError ? `\nFix: ${error.fix}` : "";
    io.stdout(
      `Could not record: ${error instanceof Error ? error.message : String(error)}${fix}\n`,
    );
    return 2;
  }
  const steps = recorded.items.filter((i) => i.kind === "action").length;
  io.stdout(
    `\nRecorded ${steps} steps (${recorded.ended}).\n\n${recorded.text.replace(/^(?=.)/gm, "    ")}\n`,
  );
  io.stdout(recorded.lintClean ? "Lint: clean.\n" : "Lint: problems to fix:\n");
  for (const note of recorded.notes) io.stdout(`  - ${note}\n`);
  if (steps === 0) {
    io.stdout("\nNothing was recorded: not saved.\n");
    return 1;
  }

  let accept = options.accept ?? false;
  if (!accept && !options.out && io.confirm)
    accept = await io.confirm(
      `\nSave it as ${shown(io.cwd, recorded.absolutePath)} (with its recording)?`,
    );
  const target = options.out
    ? resolve(io.cwd, options.out)
    : accept
      ? recorded.absolutePath
      : undefined;
  if (!target) {
    io.stdout(
      `\nNot saved. Record again with --accept to save it as ${shown(io.cwd, recorded.absolutePath)}, or --out <file>.\n`,
    );
    return 0;
  }
  try {
    const { loadProject } = await import("@optestra/config/node");
    const testsDir = loadProject(dir, { env: io.env }).config.tests?.dir ?? "tests";
    const saved = core.saveRecorded(recorded, target, testsDir);
    io.stdout(
      `\nSaved ${shown(io.cwd, saved.test)} and its recording ${shown(io.cwd, saved.recording)}. It replays with no AI: ${brand.cliName} run ${shown(io.cwd, saved.test)}\n`,
    );
    return recorded.lintClean ? 0 : 1;
  } catch (error) {
    io.stdout(`\n${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
