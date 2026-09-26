import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { Config } from "@testament/config";
import { findProject, loadProject, projectFile } from "@testament/config/node";
import {
  type ExpandedStep,
  type ExpandedTest,
  hasSpecErrors,
  printExactOp,
  type SpecDiagnostic,
  type Step,
  specSteps,
  type TestSpec,
} from "@testament/spec";
import { type LoadedTest, loadTest, loadTests } from "@testament/spec/node";
import type { CommandIo } from "./config.js";

export interface ListCommandOptions {
  tag?: string;
  dir?: string;
  env?: string;
  json?: boolean;
}

export interface ShowCommandOptions {
  expanded?: boolean;
  env?: string;
  seed?: string;
  dir?: string;
  json?: boolean;
}

export interface Project {
  dir: string;
  /** Undefined when the folder has no project file: default settings, secrets unchecked. */
  config: Config | undefined;
  environment: string | undefined;
}

export function openProject(io: CommandIo, options: { dir?: string; env?: string }): Project {
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  if (!existsSync(projectFile(dir))) return { dir, config: undefined, environment: options.env };
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  return { dir, config: loaded.config, environment: loaded.environment?.name ?? options.env };
}

function table(rows: string[][], indent = "  "): string {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows
    .map(
      (row) =>
        indent +
        row
          .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
          .join("  ")
          .trimEnd(),
    )
    .join("\n");
}

export function formatSpecDiagnostic(d: SpecDiagnostic): string {
  const at = d.range ? `:${d.range.start.line}:${d.range.start.column}` : "";
  const where = d.file ? `  ${d.file}${at}` : "";
  const indent = (text: string) => text.split("\n").join("\n               ");
  return `  ${d.severity.padEnd(7)} ${d.code}${where}\n          ${indent(d.message)}\n          Fix: ${indent(d.fix)}`;
}

const problemsSection = (diagnostics: readonly SpecDiagnostic[]) =>
  diagnostics.length > 0
    ? `Problems\n${diagnostics.map(formatSpecDiagnostic).join("\n")}`
    : "No problems found.";

/** `list`: the runnable tests of the project. Exit 2 on any error diagnostic. */
export async function runListCommand(options: ListCommandOptions, io: CommandIo): Promise<number> {
  const project = openProject(io, options);
  const loaded = await loadTests(project.dir, project.config, { environment: project.environment });
  const tests = options.tag
    ? loaded.tests.filter((t) => t.spec.frontmatter.tags.includes(options.tag ?? ""))
    : loaded.tests;
  const diagnostics = [...loaded.diagnostics, ...tests.flatMap((t) => t.diagnostics)];
  const errors = hasSpecErrors(diagnostics);
  const row = (t: LoadedTest) => ({
    id: t.id,
    path: t.path,
    name: t.spec.frontmatter.name,
    tags: t.spec.frontmatter.tags,
    steps: t.expanded.steps.length,
    problems: t.diagnostics.length,
  });

  if (options.json) {
    io.stdout(
      `${JSON.stringify(
        {
          project: project.dir,
          testsDir: loaded.dir,
          tests: tests.map((t) => ({ ...row(t), diagnostics: t.diagnostics })),
          flows: loaded.flows.map((f) => ({
            id: f.id,
            path: f.path,
            name: f.spec.frontmatter.name,
          })),
          diagnostics: loaded.diagnostics,
        },
        null,
        2,
      )}\n`,
    );
    return errors ? 2 : 0;
  }

  const sections: string[] = [];
  if (tests.length > 0) {
    sections.push(
      table([
        ["ID", "NAME", "TAGS", "STEPS", "PROBLEMS"],
        ...tests.map((t) => {
          const r = row(t);
          return [r.id, r.name, r.tags.join(", "), String(r.steps), String(r.problems)];
        }),
      ]),
    );
  }
  const count = `${tests.length} test${tests.length === 1 ? "" : "s"}${options.tag ? ` tagged ${options.tag}` : ""}`;
  const flows =
    loaded.flows.length > 0
      ? `, ${loaded.flows.length} flow${loaded.flows.length === 1 ? "" : "s"}`
      : "";
  sections.push(`${count}${flows} in ${loaded.dir}/.`);
  sections.push(problemsSection(diagnostics));
  io.stdout(`${sections.join("\n\n")}\n`);
  return errors ? 2 : 0;
}

function stepLabel(step: Step): string {
  switch (step.kind) {
    case "flow":
      return `Use: ${step.path}${
        Object.keys(step.params).length > 0
          ? ` { ${Object.entries(step.params)
              .map(([k, v]) => `${k}: ${v.raw}`)
              .join(", ")} }`
          : ""
      }`;
    case "exact":
      return step.exact.form === "code"
        ? `${step.exact.label ? `${step.exact.label} ` : ""}[ts code, ${step.exact.code.split("\n").length} lines]`
        : `Exact: ${printExactOp(step.exact.op, (t) => t.raw)}`;
    default:
      return step.text.raw;
  }
}

function frontmatterRows(spec: TestSpec, id: string, expanded?: ExpandedTest): string[][] {
  const fm = spec.frontmatter;
  const rows: string[][] = [
    ["id", id],
    ["name", fm.name],
    ["kind", fm.kind],
  ];
  if (fm.tags.length > 0) rows.push(["tags", fm.tags.join(", ")]);
  const start = expanded ? expanded.start?.display : fm.start?.raw;
  if (start) rows.push(["start", start]);
  if (fm.auth) rows.push(["auth", fm.auth]);
  const timeout = expanded ? expanded.timeout : fm.timeout;
  if (timeout) rows.push(["timeout", `${timeout}s`]);
  if (fm.heal) rows.push(["heal", fm.heal]);
  if (fm.allowDestructive.length > 0)
    rows.push(["allowDestructive", fm.allowDestructive.join(", ")]);
  if (fm.dataset) rows.push(["dataset", fm.dataset]);
  for (const key of ["setup", "teardown"] as const) {
    for (const hook of fm[key]) {
      rows.push([
        key,
        hook.type === "request"
          ? `${hook.method} ${hook.target}${hook.body !== undefined ? ` ${JSON.stringify(hook.body)}` : ""}`
          : hook.type === "run"
            ? `run ${hook.script}`
            : `sql ${hook.statement}`,
      ]);
    }
  }
  if (expanded?.environment) rows.push(["environment", expanded.environment]);
  return rows;
}

const origin = (step: ExpandedStep) =>
  [...step.origin]
    .reverse()
    .map((frame) => `${frame.file}:${frame.line}`)
    .join(" ← ");

function human(loaded: LoadedTest, expanded: boolean): string {
  const { spec, expanded: x } = loaded;
  const sections = [
    `${loaded.path}\n${table(frontmatterRows(spec, loaded.id, expanded ? x : undefined))}`,
  ];
  if (expanded) {
    const values = [
      ...Object.entries(x.data).map(([k, v]) => [`data.${k}`, v.display, v.raw]),
      ...Object.entries(x.params).map(([k, v]) => [`params.${k}`, v.display, v.raw]),
    ];
    if (values.length > 0) sections.push(`Variables\n${table(values)}`);
    const rows = (steps: ExpandedStep[]) =>
      table([
        ["#", "KIND", "STEP", "FROM"],
        ...steps.map((s) => [String(s.index + 1), s.kind, s.display, origin(s)]),
      ]);
    sections.push(`Steps (flows inlined, variables bound)\n${rows(x.steps)}`);
    if (x.guards.length > 0) sections.push(`Guards (apply to the whole test)\n${rows(x.guards)}`);
  } else {
    const steps = specSteps(spec);
    const rows = steps.map((s) => [
      s.number === null ? "-" : `${s.number}.`,
      s.kind,
      stepLabel(s),
      `line ${s.at?.range.start.line ?? "?"}`,
    ]);
    if (rows.length > 0) sections.push(`Steps\n${table([["#", "KIND", "STEP", "LINE"], ...rows])}`);
  }
  sections.push(problemsSection(loaded.diagnostics));
  return sections.join("\n\n");
}

/** `show <file>`: one test's model; `--expanded` inlines flows and binds variables. */
export async function runShowCommand(
  file: string,
  options: ShowCommandOptions,
  io: CommandIo,
): Promise<number> {
  const project = openProject(io, options);
  const absolute = resolve(io.cwd, file);
  const rel = relative(project.dir, absolute).split(sep).join("/");
  if (rel.startsWith("..") || resolve(project.dir, rel) !== absolute) {
    io.stdout(`${file} is outside the project folder ${project.dir}.\n`);
    return 2;
  }
  const loaded = await loadTest(project.dir, rel, project.config, {
    environment: project.environment,
    seed: options.seed,
  });
  if (!loaded) {
    io.stdout(`No test file at ${rel}.\n`);
    return 2;
  }
  if (options.json) {
    io.stdout(
      `${JSON.stringify(
        {
          id: loaded.id,
          path: loaded.path,
          spec: loaded.spec,
          ...(options.expanded && { expanded: loaded.expanded }),
          diagnostics: loaded.diagnostics,
        },
        null,
        2,
      )}\n`,
    );
  } else io.stdout(`${human(loaded, options.expanded ?? false)}\n`);
  return hasSpecErrors(loaded.diagnostics) ? 2 : 0;
}
