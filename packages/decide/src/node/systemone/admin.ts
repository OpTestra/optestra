import { existsSync } from "node:fs";
import { brand } from "@testament/brand";
import { SecretValue } from "@testament/config/node";
import { revealSecret } from "@testament/config/reveal";
import { createTransport, type FetchLike } from "./transport.js";
import { errorMessage, failureFromHttp } from "./wire.js";

/**
 * Setup and health checks for the decision backends: is Ollaya running, which
 * models are installed, pull one (only when the user asked), and is a Jev/Kev
 * key valid. All requests go through the pinned transport.
 */

/** Download sizes of the Laya models on the Ollaya registry (ollaya.dev/library/laya, 2026-09). */
export const KNOWN_MODEL_SIZES: Record<string, number> = {
  "laya:en": 854_000_000,
  "laya:multilingual": 684_000_000,
  "laya:typed-decisions": 854_000_000,
  "laya:latest": 1_538_000_000,
};

export const OLLAYA_INSTALL = {
  unix: "curl -fsSL https://ollaya.dev/install.sh | sh",
  windows: "irm https://ollaya.dev/install.ps1 | iex",
  page: "https://ollaya.dev/download",
} as const;

/** Ollama-style names: case-insensitive, a missing tag means `latest`. */
export function canonicalModel(name: string): string {
  const lower = name.trim().toLowerCase();
  const last = lower.split("/").pop() ?? lower;
  return last.includes(":") ? lower : `${lower}:latest`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

/** The exact fix when Ollaya can't be reached. */
export function ollayaNotRunningFix(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin" && existsSync("/Applications/Ollaya.app"))
    return "Open Ollaya.app (it serves on 127.0.0.1:11435), or run `ollaya serve`.";
  if (platform === "win32")
    return `Install Ollaya (${OLLAYA_INSTALL.page}, or in PowerShell: ${OLLAYA_INSTALL.windows}), then start it.`;
  return `Install Ollaya (${OLLAYA_INSTALL.page}, or: ${OLLAYA_INSTALL.unix}), then run \`ollaya serve\`.`;
}

export interface InstalledModel {
  name: string;
  size: number;
  parameterSize?: string;
}

export interface OllayaStatus {
  running: boolean;
  version?: string;
  models: InstalledModel[];
  /** Why it isn't usable, when it isn't. */
  problem?: string;
  fix?: string;
}

interface Connection {
  baseUrl: string;
  apiKey?: SecretValue | string | undefined;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const auth = (key: SecretValue | string | undefined): Record<string, string> =>
  key === undefined
    ? {}
    : { authorization: `Bearer ${key instanceof SecretValue ? revealSecret(key) : key}` };

/** `GET /`, `/api/version` and `/api/tags`. */
export async function ollayaStatus(connection: Connection): Promise<OllayaStatus> {
  const transport = createTransport(connection.baseUrl, connection.fetch);
  const timeoutMs = connection.timeoutMs ?? 3000;
  const headers = auth(connection.apiKey);
  const live = await transport.request({ method: "GET", path: "/", timeoutMs });
  if (live.kind === "error" || live.status !== 200) {
    return {
      running: false,
      models: [],
      problem: `Ollaya is not running at ${connection.baseUrl}${live.kind === "error" ? ` (${live.message})` : ` (HTTP ${live.status})`}.`,
      fix: ollayaNotRunningFix(),
    };
  }
  const version = await transport.request({
    method: "GET",
    path: "/api/version",
    headers,
    timeoutMs,
  });
  const tags = await transport.request({ method: "GET", path: "/api/tags", headers, timeoutMs });
  const status: OllayaStatus = { running: true, models: [] };
  if (version.kind === "response" && version.status === 200) {
    const v = (version.json as { version?: unknown } | undefined)?.version;
    if (typeof v === "string") status.version = v;
  }
  if (tags.kind === "response" && tags.status === 200) {
    const list = (tags.json as { models?: unknown } | undefined)?.models;
    if (Array.isArray(list)) {
      for (const entry of list as Record<string, unknown>[]) {
        if (typeof entry?.name !== "string") continue;
        const details = entry.details as { parameter_size?: unknown } | undefined;
        status.models.push({
          name: entry.name,
          size: typeof entry.size === "number" ? entry.size : 0,
          ...(typeof details?.parameter_size === "string"
            ? { parameterSize: details.parameter_size }
            : {}),
        });
      }
    }
  } else {
    const reason = tags.kind === "response" ? failureFromHttp(tags.status, tags.json) : tags;
    status.problem = `Cannot list Ollaya's models: ${"message" in reason ? reason.message : ""}`;
    status.fix =
      tags.kind === "response" && tags.status === 401
        ? "Set the key Ollaya expects (OLLAYA_API_KEY) as decisions.laya.keySecret."
        : "Check the Ollaya server log.";
  }
  return status;
}

export function hasModel(status: OllayaStatus, model: string): boolean {
  const wanted = canonicalModel(model);
  return status.models.some((m) => canonicalModel(m.name) === wanted);
}

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

/**
 * `POST /api/pull`, streaming progress. Only `decider setup laya` calls this,
 * after the user agreed; nothing pulls a model during a run.
 */
export async function pullModel(
  connection: Connection,
  model: string,
  onProgress: (progress: PullProgress) => void,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const transport = createTransport(connection.baseUrl, connection.fetch);
  let failure: string | undefined;
  const result = await transport.stream(
    {
      method: "POST",
      path: "/api/pull",
      body: { model },
      headers: auth(connection.apiKey),
      timeoutMs: connection.timeoutMs ?? 3_600_000,
    },
    (line) => {
      const entry = line as Record<string, unknown>;
      if (typeof entry.error === "string") failure = errorMessage(entry) ?? entry.error;
      else if (typeof entry.status === "string")
        onProgress({
          status: entry.status,
          ...(typeof entry.total === "number" ? { total: entry.total } : {}),
          ...(typeof entry.completed === "number" ? { completed: entry.completed } : {}),
        });
    },
  );
  if (result.kind === "error") return { ok: false, message: result.message };
  if (result.status !== 200)
    return { ok: false, message: failureFromHttp(result.status, result.json).message ?? "" };
  if (failure) return { ok: false, message: failure };
  const last = result.json as { status?: unknown } | undefined;
  return last?.status === "success"
    ? { ok: true }
    : { ok: false, message: "the pull ended without success" };
}

export type CheckStatus =
  | "ok"
  | "missing_key"
  | "invalid_key"
  | "unreachable"
  | "model_missing"
  | "error";

export interface BackendCheck {
  backend: string;
  baseUrl: string;
  model: string;
  status: CheckStatus;
  message: string;
  fix?: string;
  version?: string;
}

/** Jev or Kev: `GET /v1/models` with the key (no tokens spent). */
export async function checkSystemOne(options: {
  backend: "jev" | "kev";
  baseUrl: string;
  model: string;
  keySecret?: string | undefined;
  apiKey: SecretValue | undefined;
  fetch?: FetchLike;
}): Promise<BackendCheck> {
  const base = { backend: options.backend, baseUrl: options.baseUrl, model: options.model };
  if (options.keySecret && !options.apiKey) {
    return {
      ...base,
      status: "missing_key",
      message: `${options.keySecret} is not set.`,
      fix:
        options.backend === "jev"
          ? `Get a key at https://typesafe.ai and set ${options.keySecret} (environment variable or .env).`
          : `Set ${options.keySecret} to the key your Kev server expects.`,
    };
  }
  const transport = createTransport(options.baseUrl, options.fetch);
  const result = await transport.request({
    method: "GET",
    path: "/v1/models",
    headers: auth(options.apiKey),
    timeoutMs: 5000,
  });
  if (result.kind === "error") {
    return {
      ...base,
      status: "unreachable",
      message: result.message,
      fix:
        options.backend === "kev"
          ? `Start Kev: uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port ${new URL(options.baseUrl).port || 8009}`
          : "Check your network connection.",
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      ...base,
      status: "invalid_key",
      message: `The key in ${options.keySecret ?? "the request"} was rejected.`,
      fix: `Set a valid key in ${options.keySecret ?? "keySecret"}.`,
    };
  }
  if (result.status !== 200) {
    return {
      ...base,
      status: "error",
      message: failureFromHttp(result.status, result.json).message ?? "",
    };
  }
  const names = ((result.json as { models?: { name?: unknown }[] } | undefined)?.models ?? [])
    .map((m) => m.name)
    .filter((n): n is string => typeof n === "string");
  // Jev accepts versioned ids that aren't listed, so an unlisted model is only a warning.
  const listed = names.includes(options.model);
  return {
    ...base,
    status: "ok",
    message: `${options.backend === "jev" ? "key valid" : "reachable"}; model ${options.model}${listed ? " listed" : ` not listed (available: ${names.join(", ") || "none"})`}`,
  };
}

/** Laya: Ollaya reachable and the model installed. */
export async function checkLaya(options: {
  baseUrl: string;
  model: string;
  apiKey: SecretValue | undefined;
  fetch?: FetchLike;
}): Promise<BackendCheck> {
  const base = { backend: "laya", baseUrl: options.baseUrl, model: options.model };
  const status = await ollayaStatus(options);
  if (!status.running) {
    return {
      ...base,
      status: "unreachable",
      message: status.problem ?? "Ollaya is not running.",
      ...(status.fix ? { fix: status.fix } : {}),
    };
  }
  const version = status.version ? { version: status.version } : {};
  if (status.problem) {
    return {
      ...base,
      ...version,
      status: "error",
      message: status.problem,
      ...(status.fix ? { fix: status.fix } : {}),
    };
  }
  if (!hasModel(status, options.model)) {
    return {
      ...base,
      ...version,
      status: "model_missing",
      message:
        `Ollaya ${status.version ?? ""} is running but ${options.model} is not installed.`.replace(
          "  ",
          " ",
        ),
      fix: `Run: ${brand.cliName} decider setup laya --model ${options.model}`,
    };
  }
  return {
    ...base,
    ...version,
    status: "ok",
    message: `Ollaya ${status.version ?? "?"} running; ${options.model} installed`,
  };
}
