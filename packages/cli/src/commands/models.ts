import { resolve } from "node:path";
import { hasErrors } from "@testament/config";
import {
  defaultRedactor,
  dotenvSource,
  findProject,
  loadProject,
  processEnvSource,
} from "@testament/config/node";
import {
  type CapUsage,
  capUsage,
  checkProviders,
  MODEL_ROLES,
  type ModelRole,
  type PoolEntry,
  type ProviderCheck,
  projectUsageStore,
  resolvePools,
  resolveProviders,
} from "@testament/models";
import type { CommandIo } from "./config.js";

export interface ModelsCommandOptions {
  env?: string;
  dir?: string;
  json?: boolean;
  check?: boolean;
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
          .join("  "),
    )
    .join("\n");
}

const capText = (caps: CapUsage[] | undefined) =>
  caps?.length
    ? caps.map((c) => `${c.window} $${c.spentUsd.toFixed(2)}/$${c.capUsd}`).join(", ")
    : "-";

/**
 * `models`: each role's resolved pool (provider, model, key set/missing, cap
 * usage); `--check` also validates every provider's key. Exit code 2 when a
 * role has no usable entry.
 */
export async function runModelsCommand(
  options: ModelsCommandOptions,
  io: CommandIo,
): Promise<number> {
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  const projectFound = !loaded.diagnostics.some((d) => d.code === "PROJECT_NOT_FOUND");
  // Outside a project the built-in defaults are all there is; config diagnostics would only be noise.
  const diagnostics = projectFound ? loaded.diagnostics : [];
  const environment = loaded.environment?.name;
  const sources = [processEnvSource(io.env), dotenvSource(dir)];
  const providers = resolveProviders(loaded.config, sources, environment);
  const pools = resolvePools(loaded.config, providers);
  const store = projectUsageStore(dir);
  const caps: Record<string, CapUsage[]> = {};
  for (const [id, provider] of providers)
    caps[id] = await capUsage(store, id, provider.settings.caps);
  const checks: ProviderCheck[] | undefined = options.check
    ? await checkProviders(loaded.config, { sources, environment })
    : undefined;

  const unusable = MODEL_ROLES.filter((role) => !pools[role].some((entry) => entry.usable));
  const keyNames = [
    ...new Set(
      unusable.flatMap((role) =>
        pools[role].flatMap((entry) => providers.get(entry.provider)?.settings.keySecret ?? []),
      ),
    ),
  ];
  const problems = unusable.map((role) => ({
    role,
    message: `No usable model for the ${role} role.`,
    fix: keyNames.length
      ? `Set one of ${keyNames.join(", ")} (as an environment variable or in .env), or add a provider under models.roles.${role}.`
      : `Add entries under models.roles.${role}.`,
  }));

  let output: string;
  if (options.json) {
    output = JSON.stringify(
      {
        file: projectFound ? loaded.file : null,
        environment: environment ?? null,
        roles: pools,
        providers: Object.fromEntries(
          [...providers].map(([id, p]) => [
            id,
            {
              kind: p.settings.kind,
              host: p.host ?? null,
              keySecret: p.settings.keySecret ?? null,
              keyStatus: p.keyStatus,
              caps: caps[id] ?? [],
            },
          ]),
        ),
        checks: checks ?? null,
        problems,
        diagnostics,
      },
      null,
      2,
    );
  } else {
    const sections = [
      `Project  ${projectFound ? loaded.file : "no project file here (using built-in defaults)"}`,
      ...MODEL_ROLES.map((role: ModelRole) => {
        const rows = pools[role].map((entry: PoolEntry, i) => {
          const provider = providers.get(entry.provider);
          const key = provider?.settings.keySecret
            ? `${provider.settings.keySecret} ${entry.keyStatus === "not_allowed" ? "not allowed" : entry.keyStatus}`
            : entry.keyStatus === "not_needed"
              ? "no key needed"
              : "-";
          return [
            String(i + 1),
            entry.provider,
            entry.model,
            key,
            capText(caps[entry.provider]),
            entry.usable ? "ready" : `unusable: ${entry.problem}`,
          ];
        });
        return `Role ${role}\n${rows.length ? table([["#", "PROVIDER", "MODEL", "KEY", "CAP USAGE", "STATUS"], ...rows]) : "  (no entries)"}`;
      }),
    ];
    if (checks) {
      sections.push(
        `Key check\n${table(checks.map((c) => [c.provider, c.status, c.message, c.status === "valid" ? "" : `Fix: ${c.fix}`]))}`,
      );
    }
    const lines = [
      ...problems.map((p) => `  error  ${p.message}\n         Fix: ${p.fix}`),
      ...diagnostics.map((d) => `  ${d.severity}  ${d.code}  ${d.message}\n         Fix: ${d.fix}`),
    ];
    sections.push(lines.length ? `Problems\n${lines.join("\n")}` : "No problems found.");
    output = sections.join("\n\n");
  }
  io.stdout(`${defaultRedactor.redact(output)}\n`);
  return unusable.length > 0 || hasErrors(diagnostics) ? 2 : 0;
}
