import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { isNodeScript, type NodeRuntime, nodeRuntime } from "@optestra/config/node";
import type { DelegatedKind } from "../config.js";
import { BINARY_NAME } from "./lockdown.js";

// The ONLY place the engine starts other programs for AI (guard-tested): the
// user's own claude / codex binary, found on PATH or at an explicit `binary:`
// path, run with a fixed argument list, no shell, in an empty folder.

export interface ResolvedBinary {
  path: string;
  /**
   * A Node script (a .js file, or an npm install whose first line is
   * `#!/usr/bin/env node`): run with `node`, never through PATH's `node`
   * (the desktop app's PATH may have none).
   */
  viaNode: boolean;
  /** The Node that runs it (see `nodeRuntime`). */
  node?: NodeRuntime;
}

export type BinaryLookup = { ok: true; binary: ResolvedBinary } | { ok: false; problem: string };

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Finds the CLI without running anything (sync: used while resolving pools). */
export function findBinary(
  kind: DelegatedKind,
  configured: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  /** The Node for JS CLIs (default: detected, see `nodeRuntime`). */
  node?: string,
): BinaryLookup {
  const name = BINARY_NAME[kind];
  const wrap = (path: string): BinaryLookup => {
    if (/\.(cmd|bat)$/i.test(path)) {
      return {
        ok: false,
        problem: `${path} is a Windows script shim; install the native ${name} binary (${name}.exe) so it can run without a shell`,
      };
    }
    const viaNode = isNodeScript(path);
    return {
      ok: true,
      binary: { path, viaNode, ...(viaNode ? { node: nodeRuntime({ node, env }) } : {}) },
    };
  };
  if (configured) {
    const path = isAbsolute(configured) ? configured : resolve(configured);
    return isFile(path)
      ? wrap(path)
      : { ok: false, problem: `${name} binary not found at ${configured}` };
  }
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const path = join(dir, `${name}${extension}`);
      if (existsSync(path) && isFile(path)) return wrap(path);
    }
  }
  return { ok: false, problem: `${name} is not installed (not found on PATH)` };
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** The process could not be started at all. */
  spawnError?: string;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

const MAX_OUTPUT = 20 * 1024 * 1024;

/** Kills the child and everything it started. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
      "error",
      () => {},
    );
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 2000).unref();
}

/** Runs the binary with `args`, no shell. Never throws. */
export function runBinary(
  binary: ResolvedBinary,
  args: readonly string[],
  options: RunOptions,
): Promise<ProcessResult> {
  const node = binary.viaNode ? (binary.node ?? nodeRuntime({ env: options.env })) : undefined;
  const command = node ? node.command : binary.path;
  const argv = node ? [binary.path, ...args] : [...args];
  const env = node ? { ...options.env, ...node.env } : options.env;
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let finished = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, argv, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      done({
        code: null,
        stdout,
        stderr,
        timedOut,
        aborted,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const finish = (result: ProcessResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      done(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      finish({ code: null, stdout, stderr, timedOut, aborted, spawnError: error.message }),
    );
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut, aborted }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin ?? "");
  });
}

export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}
