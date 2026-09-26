import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import type { DelegatedKind } from "../config.js";
import type { AttemptOutcome, TokenUsage, ToolCall, ToolDefinition } from "../types.js";
import {
  CLAUDE_MIN_VERSION,
  CODEX_REQUIRED_FLAGS,
  claudeArgs,
  codexArgs,
  delegatedEnv,
  SIGN_IN_COMMAND,
  STATUS_ARGS,
} from "./lockdown.js";
import { parseVersion, type ResolvedBinary, runBinary, versionAtLeast } from "./process.js";
import { flattenMessages, parseReply, replySchema } from "./schema.js";

// One call through a delegated CLI: a fresh empty folder, the pinned argv and
// environment, the prompt on stdin, structured JSON back. Failures come back as
// typed outcomes; nothing here throws.

export interface DelegatedRequest {
  system: string | undefined;
  /** AI SDK message shapes, as the client already built them. */
  messages: readonly unknown[];
  tools: readonly ToolDefinition[] | undefined;
  output: z.ZodType | undefined;
  model: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}

export interface DelegatedResult {
  outcome: AttemptOutcome;
  message?: string;
  text?: string;
  toolCalls?: ToolCall[];
  object?: unknown;
  usage?: TokenUsage;
  /** What the tool itself estimated (information only; not charged to budgets). */
  reportedCostUsd?: number;
  invalidText?: string;
}

const AUTH =
  /not (logged|signed) in|please (log|sign) ?in|\/login|login required|authenticat|unauthori[sz]ed|invalid (api key|token|credentials)|oauth|\b401\b/i;
const PLAN_LIMIT =
  /usage limit|limit reached|reached your (usage|plan|weekly|5-hour)|plan limit|quota|out of (credits|messages)|too many requests|rate[ _-]?limit/i;

function classify(message: string): AttemptOutcome {
  if (AUTH.test(message)) return "auth_failed";
  if (PLAN_LIMIT.test(message)) return "plan_limit";
  return "server_error";
}

const short = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

// ── Probes (models --check, login, first use) ────────────────────────────────

export interface ProbeResult {
  installed: boolean;
  version?: string;
  meetsMinimum: boolean;
  /** Why it can't run, when it can't. */
  problem?: string;
}

function tempFolder(): string {
  return mkdtempSync(join(tmpdir(), "delegated-"));
}

/** Version and required lock-down flags. Runs `--version` (and `exec --help` for Codex). */
export async function probeBinary(
  kind: DelegatedKind,
  binary: ResolvedBinary,
  parentEnv: Readonly<Record<string, string | undefined>>,
): Promise<ProbeResult> {
  const cwd = tempFolder();
  try {
    const env = delegatedEnv(kind, parentEnv, cwd);
    const result = await runBinary(binary, ["--version"], { cwd, env, timeoutMs: 15_000 });
    if (result.spawnError)
      return { installed: false, meetsMinimum: false, problem: result.spawnError };
    const version = parseVersion(`${result.stdout} ${result.stderr}`);
    if (kind === "claude-code") {
      if (!version)
        return {
          installed: true,
          meetsMinimum: false,
          problem: "could not read the Claude Code version",
        };
      const ok = versionAtLeast(version, CLAUDE_MIN_VERSION);
      return {
        installed: true,
        version,
        meetsMinimum: ok,
        ...(ok
          ? {}
          : {
              problem: `Claude Code ${version} is older than ${CLAUDE_MIN_VERSION}, which has the lock-down flags we need. Run \`claude update\`.`,
            }),
      };
    }
    const help = await runBinary(binary, ["exec", "--help"], { cwd, env, timeoutMs: 15_000 });
    const text = `${help.stdout}\n${help.stderr}`;
    const missing = CODEX_REQUIRED_FLAGS.filter((flag) => !text.includes(flag));
    return {
      installed: true,
      ...(version ? { version } : {}),
      meetsMinimum: missing.length === 0,
      ...(missing.length
        ? {
            problem: `This Codex${version ? ` (${version})` : ""} lacks ${missing.join(", ")}, needed to lock it down. Update Codex.`,
          }
        : {}),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Signed in? Asks the vendor's own status command; never reads its files. */
export async function signInStatus(
  kind: DelegatedKind,
  binary: ResolvedBinary,
  parentEnv: Readonly<Record<string, string | undefined>>,
): Promise<{ signedIn: boolean; fix?: string }> {
  const cwd = tempFolder();
  try {
    const result = await runBinary(binary, STATUS_ARGS[kind], {
      cwd,
      env: delegatedEnv(kind, parentEnv, cwd),
      timeoutMs: 15_000,
    });
    // Only the exit code is used: the output may name the account, and we don't need it.
    return result.code === 0
      ? { signedIn: true }
      : {
          signedIn: false,
          fix: `Run \`${SIGN_IN_COMMAND[kind]}\` and sign in with your own account.`,
        };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── One completion ───────────────────────────────────────────────────────────

/**
 * OpenAI structured outputs want every property required and no open objects:
 * optional properties become nullable (and nulls are dropped again on the way back).
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const node = { ...(schema as Record<string, unknown>) };
  if ("const" in node) {
    node.enum = [node.const];
    delete node.const;
  }
  for (const key of ["items", "anyOf", "oneOf", "allOf"])
    if (key in node) node[key] = strictSchema(node[key]);
  if (node.type === "object" && node.properties && typeof node.properties === "object") {
    const required = new Set((node.required as string[] | undefined) ?? []);
    const properties: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node.properties as Record<string, unknown>)) {
      const inner = strictSchema(value);
      properties[name] = required.has(name) ? inner : { anyOf: [inner, { type: "null" }] };
    }
    node.properties = properties;
    node.required = Object.keys(properties);
    node.additionalProperties = false;
  }
  return node;
}

function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, dropNulls(v)]),
  );
}

function usageFromClaude(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) return undefined;
  const n = (key: string) => (typeof raw[key] === "number" ? (raw[key] as number) : 0);
  const cached = n("cache_read_input_tokens");
  const written = n("cache_creation_input_tokens");
  return {
    inputTokens: n("input_tokens") + cached + written,
    outputTokens: n("output_tokens"),
    cachedInputTokens: cached,
    cacheWriteTokens: written,
  };
}

function lines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // not an event line
    }
  }
  return out;
}

function processFailure(
  result: Awaited<ReturnType<typeof runBinary>>,
  name: string,
): DelegatedResult | undefined {
  if (result.aborted) return { outcome: "aborted", message: "The request was cancelled." };
  if (result.timedOut)
    return { outcome: "timeout", message: `${name} did not answer in time; it was stopped.` };
  if (result.spawnError) return { outcome: "cli_unavailable", message: short(result.spawnError) };
  return undefined;
}

export async function runDelegated(
  kind: DelegatedKind,
  binary: ResolvedBinary,
  request: DelegatedRequest,
  parentEnv: Readonly<Record<string, string | undefined>>,
): Promise<DelegatedResult> {
  const shape = replySchema(request.tools, request.output);
  const system = [request.system, shape.instructions].filter(Boolean).join("\n\n");
  const prompt = flattenMessages(request.messages);
  const cwd = tempFolder();
  try {
    const env = delegatedEnv(kind, parentEnv, cwd);
    if (kind === "claude-code") {
      const content = [
        { type: "text", text: prompt.text },
        ...prompt.images.map((image) => ({
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.data },
        })),
      ];
      const stdin = `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
      const args = claudeArgs({
        model: request.model,
        system,
        schema: JSON.stringify(shape.schema),
      });
      const result = await runBinary(binary, args, {
        cwd,
        env,
        stdin,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
      const failed = processFailure(result, "Claude Code");
      if (failed) return failed;
      const events = lines(result.stdout);
      const final = [...events].reverse().find((event) => event.type === "result");
      if (!final) {
        const message = short(
          result.stderr || result.stdout || `Claude Code exited with code ${result.code}`,
        );
        return { outcome: classify(message), message };
      }
      const usage = usageFromClaude(final.usage as Record<string, unknown> | undefined);
      const extra = {
        ...(usage ? { usage } : {}),
        ...(typeof final.total_cost_usd === "number"
          ? { reportedCostUsd: final.total_cost_usd }
          : {}),
      };
      if (final.is_error === true || (final.subtype !== undefined && final.subtype !== "success")) {
        const message = short(String(final.result ?? final.error ?? final.subtype ?? "error"));
        const outcome =
          final.subtype === "error_max_turns" || /structured output/i.test(message)
            ? "invalid_output"
            : classify(message);
        return {
          outcome,
          message,
          ...extra,
          ...(outcome === "invalid_output" ? { invalidText: message } : {}),
        };
      }
      const value = final.structured_output ?? final.result;
      const parsed = parseReply(value, shape, request.tools);
      if (!parsed.ok)
        return {
          outcome: "invalid_output",
          message: parsed.error,
          invalidText: parsed.raw,
          ...extra,
        };
      return {
        outcome: "ok",
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        object: parsed.object,
        ...extra,
      };
    }

    // codex
    const schemaFile = join(cwd, "schema.json");
    const lastMessageFile = join(cwd, "last-message.json");
    writeFileSync(schemaFile, JSON.stringify(strictSchema(shape.schema)));
    const images = prompt.images.map((image, index) => {
      const file = join(cwd, `image-${index + 1}.${image.mediaType.split("/")[1] ?? "png"}`);
      writeFileSync(file, Buffer.from(image.data, "base64"));
      return file;
    });
    const args = codexArgs({
      model: request.model,
      schemaFile,
      lastMessageFile,
      workdir: cwd,
      images,
    });
    const result = await runBinary(binary, args, {
      cwd,
      env,
      stdin: `${system}\n\n${prompt.text}`,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    const failed = processFailure(result, "Codex");
    if (failed) return failed;
    const events = lines(result.stdout);
    const completed = [...events].reverse().find((event) => event.type === "turn.completed");
    const rawUsage = completed?.usage as Record<string, number> | undefined;
    const usage: TokenUsage | undefined = rawUsage
      ? {
          inputTokens: rawUsage.input_tokens ?? 0,
          outputTokens: rawUsage.output_tokens ?? 0,
          cachedInputTokens: rawUsage.cached_input_tokens ?? 0,
          cacheWriteTokens: 0,
        }
      : undefined;
    const errorEvent = events.find(
      (event) => event.type === "error" || event.type === "turn.failed",
    );
    if (result.code !== 0 || errorEvent) {
      const detail = errorEvent
        ? String(
            (errorEvent.error as { message?: string } | undefined)?.message ??
              errorEvent.message ??
              "",
          )
        : "";
      const message = short(detail || result.stderr || `Codex exited with code ${result.code}`);
      return { outcome: classify(message), message, ...(usage ? { usage } : {}) };
    }
    let last = "";
    try {
      last = readFileSync(lastMessageFile, "utf8");
    } catch {
      return {
        outcome: "invalid_output",
        message: "Codex wrote no final message.",
        ...(usage ? { usage } : {}),
      };
    }
    let value: unknown = last;
    try {
      value = dropNulls(JSON.parse(last));
    } catch {
      // parseReply reports it
    }
    const parsed = parseReply(value, shape, request.tools);
    if (!parsed.ok)
      return {
        outcome: "invalid_output",
        message: parsed.error,
        invalidText: parsed.raw,
        ...(usage ? { usage } : {}),
      };
    return {
      outcome: "ok",
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      object: parsed.object,
      ...(usage ? { usage } : {}),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
