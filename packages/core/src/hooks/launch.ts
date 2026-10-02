import { extname } from "node:path";

// How a `run:` hook's command starts, per platform (AUT-10). Windows can only
// start real executables (.exe, .com): spawning a script file without a shell
// fails with EFTYPE, and Node refuses .cmd/.bat without one. So instead of a
// shell for everything (which would bring its quoting and %VAR% expansion to
// every hook), each kind of script is given to its own interpreter explicitly:
//   .js .mjs .cjs .ts .mts .cts → this Node            (every platform)
//   .ps1                        → PowerShell -File      (powershell.exe; pwsh elsewhere)
//   .cmd .bat                   → cmd.exe /d /s /c      (Windows only: the one case that needs cmd)
//   .sh                         → /bin/sh               (not on Windows)
//   a program on the PATH       → itself (on Windows found with PATHEXT; a .cmd shim goes through cmd)
//   any other file              → itself (POSIX: its shebang); on Windows its shebang decides
// Batch arguments are limited to plain characters, so cmd has nothing to expand.

export interface LaunchEnv {
  platform: NodeJS.Platform;
  /** This Node, for JavaScript and TypeScript hooks. */
  execPath: string;
  /** Windows: %ComSpec% (default C:\Windows\System32\cmd.exe). */
  comSpec?: string | undefined;
  /** Windows: where a program name is on the PATH (with PATHEXT), else undefined. */
  findOnPath?: ((name: string) => string | undefined) | undefined;
  /** The first line of a file (for a shebang), else undefined. */
  firstLine?: ((file: string) => string | undefined) | undefined;
}

export type LaunchPlan =
  | {
      ok: true;
      command: string;
      args: string[];
      /** Windows: pass the arguments as they are (the cmd.exe route builds its own line). */
      windowsVerbatimArguments?: boolean;
      via: "direct" | "node" | "powershell" | "cmd" | "sh";
    }
  | { ok: false; message: string };

const NODE = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
/**
 * What may appear in an argument of a batch file: nothing cmd would expand or split on.
 * `~` is allowed because Windows short paths use it (`C:\\Users\\RUNNER~1`); cmd only treats it
 * specially after `%`, which stays refused. `' # $ [ ] { }` are plain characters to cmd.
 */
const BATCH_SAFE = /^[A-Za-z0-9 _.,:=+@()\\/~'#$[\]{}-]*$/;

/** One cmd.exe word: quoted when it has a space (cmd keeps everything inside quotes). */
const cmdWord = (word: string) => (/[ ,=()]/.test(word) || word === "" ? `"${word}"` : word);

function viaCmd(file: string, args: string[], env: LaunchEnv): LaunchPlan {
  const bad = [file, ...args].find((word) => !BATCH_SAFE.test(word));
  if (bad !== undefined)
    return {
      ok: false,
      message: `run: a batch file's arguments may only use letters, digits, spaces and _ . , : = + @ ( ) \\ / ~ ' # $ [ ] { } - (cmd.exe would expand or split "${bad}"). Use a .js script for anything else.`,
    };
  // /s /c "…": cmd strips exactly the outer quotes and runs the line inside.
  const line = [file, ...args].map(cmdWord).join(" ");
  return {
    ok: true,
    command: env.comSpec || "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
    via: "cmd",
  };
}

function powershell(file: string, args: string[], env: LaunchEnv): LaunchPlan {
  return {
    ok: true,
    command: env.platform === "win32" ? "powershell.exe" : "pwsh",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
    via: "powershell",
  };
}

/**
 * How to start `command` (a resolved project file, or a program name) with
 * `args`, on `env.platform`. Never a shell, except cmd.exe for batch files.
 */
export function launchPlan(
  command: string,
  args: string[],
  env: LaunchEnv,
  isFile: boolean,
): LaunchPlan {
  const windows = env.platform === "win32";
  if (!isFile) {
    if (!windows) return { ok: true, command, args, via: "direct" };
    const found = env.findOnPath?.(command);
    if (!found) return { ok: true, command, args, via: "direct" };
    return launchPlan(found, args, env, true);
  }
  const ext = extname(command).toLowerCase();
  if (NODE.has(ext))
    return { ok: true, command: env.execPath, args: [command, ...args], via: "node" };
  if (ext === ".ps1") return powershell(command, args, env);
  if (ext === ".cmd" || ext === ".bat")
    return windows
      ? viaCmd(command, args, env)
      : {
          ok: false,
          message: `run: ${command} is a Windows batch file; it can't run here. Use a .js script, which runs everywhere.`,
        };
  if (ext === ".sh")
    return windows
      ? {
          ok: false,
          message: `run: ${command} is a shell script; Windows has no /bin/sh. Use a .js script, which runs everywhere.`,
        }
      : { ok: true, command: "/bin/sh", args: [command, ...args], via: "sh" };
  if (!windows) return { ok: true, command, args, via: "direct" };
  if (ext === ".exe" || ext === ".com") return { ok: true, command, args, via: "direct" };
  // Windows can't follow a shebang: read it.
  const shebang = env.firstLine?.(command) ?? "";
  if (/^#!.*\bnode\b/.test(shebang))
    return { ok: true, command: env.execPath, args: [command, ...args], via: "node" };
  return {
    ok: false,
    message: `run: Windows can't start ${command} (${shebang.startsWith("#!") ? `its interpreter "${shebang.slice(2).trim()}" isn't one we start` : "not a program or a script we know"}). Use a .js, .cmd or .ps1 script.`,
  };
}

/** Windows: a program name on the PATH, with PATHEXT (pnpm → pnpm.cmd). */
export function windowsLookup(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean,
  join: (dir: string, name: string) => string,
): (name: string) => string | undefined {
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (env.Path ?? env.PATH ?? "").split(";").filter(Boolean);
  return (name) => {
    const hasExt = extname(name) !== "";
    for (const dir of dirs)
      for (const ext of hasExt ? [""] : exts) {
        const path = join(dir, `${name}${ext.toLowerCase()}`);
        if (exists(path)) return path;
      }
    return undefined;
  };
}
