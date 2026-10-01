import { resolve } from "node:path";
import {
  type Config,
  type Diagnostic,
  ENVIRONMENT_VAR,
  formatPath,
  hasErrors,
  isPlainObject,
  type Provenance,
} from "@optestra/config";
import {
  defaultRedactor,
  dotenvSource,
  findProject,
  loadProject,
  processEnvSource,
  resolveSecrets,
} from "@optestra/config/node";

export interface ConfigCommandOptions {
  env?: string;
  dir?: string;
  json?: boolean;
}

export interface CommandIo {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
}

interface SecretRow {
  name: string;
  status: "set" | "missing";
  origin?: string;
  domains: string[];
}

function sourceLabel(provenance: Provenance | undefined): string {
  if (!provenance) return "";
  const line = provenance.line ? `, line ${provenance.line}` : "";
  switch (provenance.source) {
    case "project":
      return `project file${line}`;
    case "environment":
      return `environment "${provenance.environment}"${line}`;
    case "envVar":
      return `env ${provenance.envVar}`;
    case "runOption":
      return "run option";
    default:
      return provenance.note ? `default (${provenance.note})` : "default";
  }
}

function selectedByLabel(provenance: Provenance): string {
  switch (provenance.source) {
    case "runOption":
      return "chosen with --env";
    case "envVar":
      return `from ${ENVIRONMENT_VAR}`;
    case "project":
      return "defaultEnvironment in the project file";
    default:
      return "the only environment";
  }
}

/** Leaves of the config: plain values, arrays and empty objects. */
function leaves(value: unknown, path: string[] = []): [string[], unknown][] {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]));
  }
  return [[path, value]];
}

function lookup(provenance: Record<string, Provenance>, path: string[]): Provenance | undefined {
  for (let length = path.length; length > 0; length--) {
    const found = provenance[formatPath(path.slice(0, length))];
    if (found) return found;
  }
  return undefined;
}

const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

function table(rows: string[][], indent = "  "): string {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows
    .map(
      (row) =>
        indent +
        row
          .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
          .join("  "),
    )
    .join("\n");
}

function formatDiagnostic(d: Diagnostic): string {
  const where = [d.path, d.file && `${d.file.split(/[\\/]/).pop()}${d.line ? `:${d.line}` : ""}`]
    .filter(Boolean)
    .join("  ");
  return `  ${d.severity.padEnd(7)} ${d.code}${where ? `  ${where}` : ""}\n          ${d.message}\n          Fix: ${d.fix}`;
}

/**
 * `config`: prints the resolved settings for an environment, where each value came
 * from, and which secrets are set. Secret values are never printed. Returns the
 * exit code: 2 when there is any error diagnostic.
 */
export function runConfigCommand(options: ConfigCommandOptions, io: CommandIo): number {
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  const environment = loaded.environment;
  const secrets = resolveSecrets(loaded.config, [processEnvSource(io.env), dotenvSource(dir)], {
    environment: environment?.name,
    file: loaded.file,
  });
  const diagnostics = [...loaded.diagnostics, ...secrets.diagnostics];
  const secretRows: SecretRow[] = Object.entries(loaded.config.secrets ?? {}).map(
    ([name, declaration]) => {
      const value = secrets.secrets[name];
      return value
        ? { name, status: "set", origin: value.origin, domains: declaration.domains }
        : { name, status: "missing", domains: declaration.domains };
    },
  );

  const output = options.json
    ? JSON.stringify(
        {
          file: loaded.file,
          environment: environment
            ? { name: environment.name, selectedBy: environment.selectedBy }
            : null,
          config: loaded.config,
          provenance: loaded.provenance,
          secrets: Object.fromEntries(secretRows.map(({ name, ...row }) => [name, row])),
          diagnostics,
        },
        null,
        2,
      )
    : human(loaded.file, loaded.config, loaded.provenance, environment, secretRows, diagnostics);
  io.stdout(`${defaultRedactor.redact(output)}\n`);
  return hasErrors(diagnostics) ? 2 : 0;
}

function human(
  file: string,
  config: Config,
  provenance: Record<string, Provenance>,
  environment: ReturnType<typeof loadProject>["environment"],
  secretRows: SecretRow[],
  diagnostics: Diagnostic[],
): string {
  const sections: string[] = [
    table(
      [
        ["Project file", file],
        [
          "Environment",
          environment
            ? `${environment.name} (${selectedByLabel(environment.selectedBy)})`
            : "none selected",
        ],
      ],
      "",
    ),
  ];
  const rows = leaves(config)
    .filter(([path]) => {
      const [section, name] = path;
      if (section === "version" || section === "secrets") return false;
      return section !== "environments" || name === environment?.name;
    })
    .map(([path, value]) => [formatPath(path), show(value), sourceLabel(lookup(provenance, path))]);
  if (rows.length > 0)
    sections.push(`Settings\n${table([["SETTING", "VALUE", "SET BY"], ...rows])}`);
  if (secretRows.length > 0) {
    const secretTable = secretRows.map((row) => [
      row.name,
      `[secret:${row.name}] (${row.status}${row.origin ? `, from ${row.origin}` : ""})`,
      `domains: ${row.domains.join(", ") || "none"}`,
    ]);
    sections.push(`Secrets\n${table(secretTable)}`);
  }
  sections.push(
    diagnostics.length > 0
      ? `Problems\n${diagnostics.map(formatDiagnostic).join("\n")}`
      : "No problems found.",
  );
  return sections.join("\n\n");
}
