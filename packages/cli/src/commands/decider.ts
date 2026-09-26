import { resolve } from "node:path";
import { brand } from "@testament/brand";
import {
  defaultRedactor,
  dotenvSource,
  findProject,
  loadProject,
  processEnvSource,
} from "@testament/config/node";
import type { DecisionsSettings } from "@testament/decide";
import {
  canonicalModel,
  formatBytes,
  hasModel,
  KNOWN_MODEL_SIZES,
  ollayaStatus,
  pullModel,
  resolveBackendKey,
} from "@testament/decide/node";
import type { CommandIo } from "./config.js";

export interface DeciderSetupOptions {
  model?: string;
  yes?: boolean;
  env?: string;
  dir?: string;
}

export interface DeciderIo extends CommandIo {
  /** Asks a yes/no question; undefined when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;
}

/**
 * `decider setup <backend>`. For laya: find Ollaya, list its models and, only
 * after the user agrees (or `--yes`), pull the chosen model. Never installs
 * Ollaya. Exit 0 ready, 1 declined, 2 not possible.
 */
export async function runDeciderSetup(
  backend: string,
  options: DeciderSetupOptions,
  io: DeciderIo,
): Promise<number> {
  const out = (text: string) => io.stdout(`${defaultRedactor.redact(text)}\n`);
  if (backend === "jev") {
    out(
      "Jev is hosted by TypeSafe AI: nothing to install.\n" +
        "Set JEV_API_KEY (environment variable or .env). With decisions.backend: auto (the default) Jev is used as soon as the key is set.\n" +
        `Then check it with \`${brand.cliName} decisions --check\`.`,
    );
    return 0;
  }
  if (backend === "kev") {
    out(
      "Kev runs on your own machine or server (https://github.com/jaredpalmer/kev):\n" +
        "  uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009\n" +
        `Then set decisions.backend: kev and check it with \`${brand.cliName} decisions --check\`.`,
    );
    return 0;
  }
  if (backend !== "laya") {
    out(`Unknown decision backend "${backend}". Use laya, jev or kev.`);
    return 2;
  }

  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  const settings = loaded.config.decisions as DecisionsSettings;
  const model = options.model ?? settings.laya.model;
  const key = resolveBackendKey(
    loaded.config,
    settings.laya,
    [processEnvSource(io.env), dotenvSource(dir)],
    loaded.environment?.name,
  ).key;
  const connection = { baseUrl: settings.laya.baseUrl, apiKey: key };

  const status = await ollayaStatus(connection);
  if (!status.running) {
    out(
      `${status.problem}\nFix: ${status.fix}\n${brand.productName} never installs Ollaya itself.`,
    );
    return 2;
  }
  out(`Ollaya ${status.version ?? "(unknown version)"} at ${settings.laya.baseUrl}`);
  if (status.problem) {
    out(`${status.problem}\nFix: ${status.fix}`);
    return 2;
  }
  out(
    status.models.length
      ? `Installed models:\n${status.models.map((m) => `  ${m.name.padEnd(28)} ${formatBytes(m.size)}${m.parameterSize ? `  ${m.parameterSize}` : ""}`).join("\n")}`
      : "No models installed yet.",
  );

  const ready = () => {
    const using = settings.backend === "laya" && settings.laya.model === model;
    out(
      using
        ? `\n${model} is ready and selected (decisions.backend: laya).`
        : `\n${model} is ready. To use it, set in your project file:\n  decisions:\n    backend: laya${model === settings.laya.model ? "" : `\n    laya: { model: "${model}" }`}`,
    );
    out(
      "Note: Laya is untrained on this project, so expect more escalations until training lands.",
    );
    return 0;
  };
  if (hasModel(status, model)) return ready();

  const size = KNOWN_MODEL_SIZES[canonicalModel(model)];
  out(`\n${model} is not installed. Download size: ${size ? formatBytes(size) : "unknown"}.`);
  let agreed = options.yes === true;
  if (!agreed) {
    if (!io.confirm) {
      out("Re-run with --yes to download it (no terminal to ask on).");
      return 1;
    }
    agreed = await io.confirm(`Download ${model}${size ? ` (${formatBytes(size)})` : ""} now?`);
  }
  if (!agreed) {
    out("Nothing downloaded.");
    return 1;
  }

  let lastShown = -1;
  const pulled = await pullModel(connection, model, (progress) => {
    if (progress.total && progress.completed !== undefined) {
      const pct = Math.floor((progress.completed / progress.total) * 100);
      if (pct >= lastShown + 10 || pct === 100) {
        lastShown = pct;
        out(`  ${progress.status}  ${pct}% of ${formatBytes(progress.total)}`);
      }
    } else if (progress.status !== "success") {
      out(`  ${progress.status}`);
    }
  });
  if (!pulled.ok) {
    out(`Download failed: ${pulled.message}`);
    return 2;
  }
  out(`Downloaded ${model}.`);
  return ready();
}
