import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

// Which Node runs the JS programs the engine starts (a subscription CLI that is
// a Node script, the generated Playwright specs). Usually this process's own
// binary. Inside the packaged desktop app `process.execPath` is the app itself
// (Electron), which would open another window: then a `node` on PATH is used,
// else the app's binary in Node mode (ELECTRON_RUN_AS_NODE).

export interface NodeRuntime {
  /** The program to start, with the script as its first argument. */
  command: string;
  /** Extra environment for the child (ELECTRON_RUN_AS_NODE when the app runs as Node). */
  env: Record<string, string>;
  /** option: the `node` path given; self: this process is Node; path: node on PATH; electron: the app in Node mode. */
  how: "option" | "self" | "path" | "electron";
}

type Env = Readonly<Record<string, string | undefined>>;

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** True when this process isn't plain Node (the packaged Electron app, Bun). */
export function execPathIsNode(versions: NodeJS.ProcessVersions = process.versions): boolean {
  return !("electron" in versions && versions.electron) && !("bun" in versions && versions.bun);
}

/** The PATH value, whatever its case (Windows keeps it as `Path`). */
function pathValue(env: Env): string {
  if (env.PATH !== undefined) return env.PATH;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return (key && env[key]) || "";
}

/**
 * `node` on PATH (`node.exe` on Windows, where PATH is `;`-separated and may be
 * called `Path`), or null. `platform` is for tests: every OS's rules can be
 * checked anywhere.
 */
export function nodeOnPath(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  isFileAt: (path: string) => boolean = isFile,
): string | null {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  // Only a real executable: node.cmd / node.bat would need a shell.
  const name = windows ? "node.exe" : "node";
  for (const dir of pathValue(env).split(path.delimiter)) {
    const clean = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!clean) continue;
    const candidate = path.join(clean, name);
    if (isFileAt(candidate)) return candidate;
  }
  return null;
}

/** How to run a Node script from this process (see the note above). */
export function nodeRuntime(
  options: {
    node?: string | undefined;
    env?: Env;
    versions?: NodeJS.ProcessVersions;
    /** For tests: the OS whose PATH rules apply (default this one). */
    platform?: NodeJS.Platform;
    isFileAt?: (path: string) => boolean;
  } = {},
): NodeRuntime {
  if (options.node) return { command: options.node, env: {}, how: "option" };
  if (execPathIsNode(options.versions)) return { command: process.execPath, env: {}, how: "self" };
  const found = nodeOnPath(options.env ?? process.env, options.platform, options.isFileAt);
  if (found) return { command: found, env: {}, how: "path" };
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" }, how: "electron" };
}

/**
 * True for a JS script: a .js/.mjs/.cjs file, or a file whose first line is a
 * `#!` line naming node (an npm-installed CLI such as `claude`). Such a file
 * needs a Node to run, which PATH may not have inside the desktop app.
 */
export function isNodeScript(path: string): boolean {
  if (/\.(c|m)?js$/i.test(path)) return true;
  if (!existsSync(path)) return false;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(128);
    const read = readSync(fd, head, 0, head.length, 0);
    const line = head.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
    return /^#!.*\bnode\b/.test(line);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
