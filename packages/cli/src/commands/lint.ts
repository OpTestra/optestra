import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { hasErrors } from "@testament/config";
import { loadProject, projectFile } from "@testament/config/node";
import {
  applySafeFixes,
  type CheckedFile,
  checkTest,
  type Finding,
  lintConfigDiagnostics,
  lintProject,
  type SpecDiagnostic,
} from "@testament/spec";
import { DEFAULT_TESTS, findTestFiles, nodeFileReader } from "@testament/spec/node";
import type { CommandIo } from "./config.js";
import { openProject } from "./tests.js";

export interface LintCommandOptions {
  json?: boolean;
  fix?: boolean;
  strict?: boolean;
  env?: string;
  dir?: string;
}

interface FileReport {
  path: string;
  findings: Finding[];
}

const toPosix = (path: string) => path.split(sep).join("/");

function line(f: SpecDiagnostic & { rule?: string }): string {
  const at = f.range ? `${f.range.start.line}:${f.range.start.column}` : "-";
  const where = `${f.file ?? ""}:${at}`;
  return `  ${where.padEnd(34)}  ${f.severity.padEnd(7)}  ${(f.rule ?? f.code).padEnd(22)}  ${f.message.split("\n")[0]}`;
}

/**
 * `lint [paths…]`: parse, expand and lint test files. Exit 0 when there are no
 * errors, 1 for lint errors (or warnings with --strict), 2 when a file can't be
 * parsed, a path is missing or the project settings have errors.
 */
export async function runLintCommand(
  paths: readonly string[],
  options: LintCommandOptions,
  io: CommandIo,
): Promise<number> {
  const project = openProject(io, options);
  const configProblems: SpecDiagnostic[] = [];
  let configBroken = false;
  if (existsSync(projectFile(project.dir))) {
    const loaded = loadProject(project.dir, { environment: options.env, env: io.env });
    configBroken = hasErrors(loaded.diagnostics);
    // Config diagnostics keep their own codes; they share the shape.
    for (const d of loaded.diagnostics) {
      configProblems.push({
        ...d,
        file: toPosix(relative(project.dir, d.file ?? loaded.file)),
      } as unknown as SpecDiagnostic);
    }
  }
  configProblems.push(...lintConfigDiagnostics(project.config, "project settings"));
  const strict = options.strict ?? project.config?.lint?.strict ?? false;
  const settings = project.config?.tests ?? DEFAULT_TESTS;
  const readFile = nodeFileReader(project.dir);
  const all = findTestFiles(project.dir, settings);

  let missing = false;
  const selected = new Set<string>();
  const notes: string[] = [];
  if (paths.length === 0) for (const p of all) selected.add(p);
  for (const arg of paths) {
    const absolute = resolve(io.cwd, arg);
    const rel = toPosix(relative(project.dir, absolute));
    if (!existsSync(absolute) || rel.startsWith("..")) {
      notes.push(`${arg}: no such file or folder in the project.`);
      missing = true;
      continue;
    }
    if (statSync(absolute).isDirectory()) {
      for (const p of all) if (rel === "" || p === rel || p.startsWith(`${rel}/`)) selected.add(p);
    } else selected.add(rel);
  }

  const check = (text: string, path: string) =>
    checkTest(text, path, {
      readFile: (p) => (p === path ? text : readFile(p)),
      config: project.config,
      environment: project.environment,
      vars: project.environment
        ? project.config?.environments[project.environment]?.vars
        : undefined,
      testsDir: settings.dir,
    });

  const fixed: { path: string; rule: string; title: string; line: number }[] = [];
  if (options.fix) {
    for (const path of selected) {
      const file = resolve(project.dir, path);
      const text = readFileSync(file, "utf8");
      const result = await applySafeFixes(text, async (t) => (await check(t, path)).findings);
      if (result.text !== text) {
        writeFileSync(file, result.text);
        for (const a of result.applied)
          fixed.push({ path, rule: a.rule ?? "", title: a.title, line: a.line });
      }
    }
  }

  const checked: CheckedFile[] = [];
  const reports = new Map<string, FileReport>();
  for (const path of new Set([...all, ...selected])) {
    const text = readFileSync(resolve(project.dir, path), "utf8");
    const result = await check(text, path);
    checked.push({ path, spec: result.spec, expanded: result.expanded });
    if (selected.has(path)) {
      const findings = result.findings.filter((f) => f.file === path || f.file === undefined);
      // AUT-9: a dataset is read here (the parser reads no files).
      if (result.spec.frontmatter.dataset) {
        const { datasetColumnProblems, loadDataset } = await import("@testament/spec/node");
        const dataset = loadDataset(project.dir, path, result.spec.frontmatter.dataset);
        const problems = dataset.diagnostics.length
          ? dataset.diagnostics
          : datasetColumnProblems(result.spec, dataset);
        findings.push(...problems.map((d) => ({ ...d, fixes: [] })));
      }
      reports.set(path, { path, findings });
    }
  }
  for (const f of lintProject(checked, project.config)) {
    const report = f.file ? reports.get(f.file) : undefined;
    report?.findings.push(f);
  }
  const files = [...reports.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const findings = files.flatMap((f) => f.findings);
  const count = (severity: string) => findings.filter((f) => f.severity === severity).length;
  const errors = count("error");
  const warnings = count("warning");
  const infos = count("info");
  // A dataset problem is an error in a file that parsed (exit 1), not an unreadable file.
  const unparseable = findings.some(
    (f) => f.rule === undefined && f.severity === "error" && !f.code.startsWith("DATASET_"),
  );
  const exitCode =
    missing || configBroken || unparseable ? 2 : errors > 0 || (strict && warnings > 0) ? 1 : 0;

  if (options.json) {
    io.stdout(
      `${JSON.stringify(
        {
          project: project.dir,
          strict,
          files,
          config: configProblems,
          fixed,
          summary: { files: files.length, errors, warnings, info: infos },
          exitCode,
        },
        null,
        2,
      )}\n`,
    );
    return exitCode;
  }

  const out: string[] = [];
  for (const { path, rule, title, line: at } of fixed)
    out.push(`Fixed ${path}:${at}  ${rule}  ${title}`);
  if (fixed.length > 0) out.push("");
  for (const note of notes) out.push(note);
  if (configProblems.length > 0) {
    out.push(
      "Project settings",
      ...configProblems.map((d) => `  ${d.severity.padEnd(7)}  ${d.code}  ${d.message}`),
      "",
    );
  }
  for (const file of files) {
    if (file.findings.length === 0) continue;
    out.push(file.path, ...file.findings.map(line), "");
  }
  const total = errors + warnings + infos;
  out.push(
    total === 0
      ? `No problems found in ${files.length} file${files.length === 1 ? "" : "s"}.`
      : `${total} problem${total === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}, ${infos} info) in ${files.filter((f) => f.findings.length > 0).length} of ${files.length} files.${strict && warnings > 0 ? " Strict: warnings count as errors." : ""}`,
  );
  io.stdout(`${out.join("\n")}\n`);
  return exitCode;
}
