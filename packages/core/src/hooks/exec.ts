import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SecretValue } from "@optestra/config/node";
import { revealSecret } from "@optestra/config/reveal";
import { type HooksSettings, matchGlob } from "@optestra/spec";

// `run:` and `sql:` hooks (AUT-10). Declared, scoped and safe:
// - run: only a command listed in `hooks.run.allow` (a program on the PATH, or
//   a project path glob), started with no shell from the project folder, with
//   a timeout. The project's secrets are in its environment (a seed script
//   needs its database); its output is scrubbed before anyone sees it.
// - sql: only through the database's own client (psql, mysql), against the
//   connection string of a declared secret, never in a production environment
//   unless the hook says `production: true`. The connection string goes to the
//   client in environment variables, never on its command line or in output.
// Secret values are revealed here only to hand them to that process (SEC-1).

export interface HookContext {
  /** The project folder: scripts run from here and must live inside it. */
  projectDir: string;
  settings: HooksSettings;
  /** The environment is production (SAF-4). */
  production: boolean;
  /** The project's resolved secrets (by name). */
  secrets: Readonly<Record<string, SecretValue>>;
  /** Scrubs output and messages (secrets and the run's redactor). */
  redact: (text: string) => string;
  /** The environment the process starts with (default: this process's). */
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}

export interface HookExecResult {
  status: "ok" | "failed" | "refused" | "unsupported" | "error";
  /** Why it was refused or couldn't run: for the verdict's blocked reason. */
  reason?: "not_allowed" | "missing_secret" | "production" | "no_client";
  message?: string;
  /** Scrubbed, at most the last 2000 characters. */
  output?: string;
  exitCode?: number | null;
  ms: number;
}

const OUTPUT_LIMIT = 2000;

/** The built-in settings (config defaults.yaml): nothing may run until allowed. */
export const DEFAULT_HOOKS: HooksSettings = {
  run: { allow: [], timeoutSeconds: 60 },
  sql: { client: "psql", timeoutSeconds: 30 },
};

/** Splits a script line into words: spaces separate, "double" and 'single' quotes group. No shell. */
export function splitCommand(line: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || word) words.push(word);
      word = "";
      has = false;
    } else {
      // Shell syntax has no meaning without a shell: refuse it rather than mis-run it.
      if (/[|&;<>`$()]/.test(c)) return undefined;
      word += c;
      has = true;
    }
  }
  if (quote) return undefined;
  if (has || word) words.push(word);
  return words;
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The executable for a run: hook's command, or why it may not start. */
export function allowedCommand(
  command: string,
  ctx: Pick<HookContext, "projectDir" | "settings">,
): { ok: true; file: string } | { ok: false; message: string } {
  const allow = ctx.settings.run.allow;
  const fix = `Add "${command}" to hooks.run.allow in the project file (a program name, or a path glob like scripts/*).`;
  const isPath = command.includes("/") || command.includes("\\") || command.startsWith(".");
  if (!isPath) {
    if (allow.includes(command)) return { ok: true, file: command };
    return { ok: false, message: `run: "${command}" is not an allowed command. ${fix}` };
  }
  const root = realpathSync.native(resolve(ctx.projectDir));
  const file = resolve(root, command);
  const rel = relative(root, file).split(sep).join("/");
  if (!inside(root, file))
    return { ok: false, message: `run: "${command}" is outside the project folder.` };
  if (!allow.some((glob) => matchGlob(glob.replace(/^\.\//, ""), rel)))
    return { ok: false, message: `run: "${rel}" is not an allowed command. ${fix}` };
  if (!existsSync(file)) return { ok: false, message: `run: ${rel} does not exist.` };
  // A link can't lead out of the project.
  if (!inside(root, realpathSync.native(file)))
    return { ok: false, message: `run: "${rel}" points outside the project folder.` };
  return { ok: true, file };
}

function execute(
  file: string,
  args: string[],
  env: Record<string, string>,
  ctx: HookContext,
  timeoutSeconds: number,
): Promise<HookExecResult> {
  const started = Date.now();
  return new Promise((done) => {
    let output = "";
    let finished = false;
    const child = spawn(file, args, {
      cwd: ctx.projectDir,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT * 4);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const clean = () => ctx.redact(output).slice(-OUTPUT_LIMIT).trim();
    const end = (result: Omit<HookExecResult, "ms">) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", abort);
      done({ ...result, ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      end({
        status: "failed",
        message: `timed out after ${timeoutSeconds} s`,
        output: clean(),
        exitCode: null,
      });
    }, timeoutSeconds * 1000);
    const abort = () => {
      child.kill("SIGKILL");
      end({ status: "error", message: "stopped", output: clean(), exitCode: null });
    };
    ctx.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      end(
        error.code === "ENOENT"
          ? {
              status: "unsupported",
              reason: "no_client",
              message: `${file} was not found on this machine.`,
            }
          : { status: "error", message: ctx.redact(error.message) },
      );
    });
    child.on("close", (code) => {
      const text = clean();
      end(
        code === 0
          ? { status: "ok", exitCode: 0, ...(text ? { output: text } : {}) }
          : {
              status: "failed",
              exitCode: code,
              message: `exit code ${code}${text ? `: ${text.split("\n").slice(-3).join(" ")}` : ""}`,
              ...(text ? { output: text } : {}),
            },
      );
    });
  });
}

function baseEnv(ctx: HookContext): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.env ?? process.env))
    if (value !== undefined) env[key] = value;
  return env;
}

/** A `run:` hook: an allowlisted command from the project folder, secrets in its environment. */
export async function runScriptHook(script: string, ctx: HookContext): Promise<HookExecResult> {
  const words = splitCommand(script);
  if (!words || words.length === 0)
    return {
      status: "refused",
      reason: "not_allowed",
      message: `run: "${script}" can't be split into a command and its arguments (no shell: pipes, redirects and $VARS don't work). Put it in a script file.`,
      ms: 0,
    };
  const [command, ...args] = words as [string, ...string[]];
  const allowed = allowedCommand(command, ctx);
  if (!allowed.ok)
    return { status: "refused", reason: "not_allowed", message: allowed.message, ms: 0 };
  const env = baseEnv(ctx);
  for (const [name, secret] of Object.entries(ctx.secrets)) env[name] = revealSecret(secret);
  return execute(allowed.file, args, env, ctx, ctx.settings.run.timeoutSeconds);
}

/** The client's environment for a connection string: the password never goes on the command line. */
export function clientEnv(
  client: "psql" | "mysql",
  connection: string,
): { env: Record<string, string>; args: string[] } | undefined {
  let url: URL;
  try {
    url = new URL(connection);
  } catch {
    return undefined;
  }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (client === "psql") {
    if (!/^postgres(ql)?:$/.test(url.protocol)) return undefined;
    const env: Record<string, string> = {};
    if (url.hostname) env.PGHOST = url.hostname;
    if (url.port) env.PGPORT = url.port;
    if (user) env.PGUSER = user;
    if (password) env.PGPASSWORD = password;
    if (database) env.PGDATABASE = database;
    const sslmode = url.searchParams.get("sslmode");
    if (sslmode) env.PGSSLMODE = sslmode;
    return { env, args: ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c"] };
  }
  if (url.protocol !== "mysql:") return undefined;
  const args = ["--batch"];
  if (url.hostname) args.push("-h", url.hostname);
  if (url.port) args.push("-P", url.port);
  if (user) args.push("-u", user);
  if (database) args.push(database);
  args.push("-e");
  return { env: password ? { MYSQL_PWD: password } : {}, args };
}

/** A `sql:` hook: one statement through psql or mysql, against the declared connection secret. */
export async function runSqlHook(
  statement: string,
  production: boolean | undefined,
  ctx: HookContext,
): Promise<HookExecResult> {
  const settings = ctx.settings.sql;
  if (!settings.connection)
    return {
      status: "refused",
      reason: "missing_secret",
      message:
        "sql: hooks need a connection: set hooks.sql.connection to the secret that holds the database URL.",
      ms: 0,
    };
  if (ctx.production && !production)
    return {
      status: "refused",
      reason: "production",
      message:
        "sql: hooks don't run in a production environment unless the hook says production: true.",
      ms: 0,
    };
  const secret = ctx.secrets[settings.connection];
  if (!secret)
    return {
      status: "refused",
      reason: "missing_secret",
      message: `sql: the connection secret ${settings.connection} has no value here (declare it and set it).`,
      ms: 0,
    };
  const client = clientEnv(settings.client, revealSecret(secret));
  if (!client)
    return {
      status: "refused",
      reason: "not_allowed",
      message: `sql: ${settings.connection} is not a ${settings.client === "psql" ? "postgres://" : "mysql://"} URL.`,
      ms: 0,
    };
  const result = await execute(
    settings.client,
    [...client.args, statement],
    { ...baseEnv(ctx), ...client.env },
    ctx,
    settings.timeoutSeconds,
  );
  if (result.reason === "no_client")
    result.message = `sql: the ${settings.client} client is not installed. Install it (${settings.client === "psql" ? "the Postgres client" : "the MySQL client"}), or seed through a run: hook.`;
  return result;
}
