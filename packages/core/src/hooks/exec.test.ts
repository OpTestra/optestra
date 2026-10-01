import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretValue, Redactor } from "@optestra/config/node";
import { afterAll, describe, expect, it } from "vitest";
import {
  allowedCommand,
  clientEnv,
  DEFAULT_HOOKS,
  type HookContext,
  runScriptHook,
  runSqlHook,
  splitCommand,
} from "./exec.js";

// run:/sql: hooks (AUT-10): only allowlisted commands, from the project folder,
// with a timeout; secrets reach the process and never its reported output.

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SECRET = "db-pass-8c1f7e2a";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "hooks-"));
  dirs.push(dir);
  mkdirSync(join(dir, "scripts"));
  const script = (name: string, body: string) => {
    const file = join(dir, "scripts", name);
    writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(file, 0o755);
  };
  script("seed.js", `console.log("seeded " + process.argv.slice(2).join(","));`);
  script("leak.js", `console.log("url is " + process.env.DB_URL); process.exit(3);`);
  script("slow.js", "setTimeout(() => {}, 60_000);");
  return dir;
}

function context(dir: string, overrides: Partial<HookContext> = {}): HookContext {
  const redactor = new Redactor();
  const url = `postgres://seed:${SECRET}@127.0.0.1:5432/shop`;
  return {
    projectDir: dir,
    settings: {
      run: { allow: ["scripts/*.js", "node"], timeoutSeconds: 5 },
      sql: { connection: "DB_URL", client: "psql", timeoutSeconds: 5 },
    },
    production: false,
    secrets: { DB_URL: createSecretValue("DB_URL", url, { redactor }) },
    redact: (text) => redactor.redact(text),
    env: { PATH: process.env.PATH },
    ...overrides,
  };
}

describe("splitCommand", () => {
  it("splits words and quotes, and refuses shell syntax", () => {
    expect(splitCommand(`scripts/seed.js --plan "pro plan" 'a b'`)).toEqual([
      "scripts/seed.js",
      "--plan",
      "pro plan",
      "a b",
    ]);
    expect(splitCommand("node -e ''")).toEqual(["node", "-e", ""]);
    for (const bad of ["a | b", "a > out", "rm $HOME", "a; b", "a && b", "`x`", '"open'])
      expect(splitCommand(bad), bad).toBeUndefined();
  });
});

describe("run: hooks", () => {
  it("runs an allowlisted script from the project folder with its arguments", async () => {
    const dir = project();
    const result = await runScriptHook("scripts/seed.js pro 3", context(dir));
    expect(result).toMatchObject({ status: "ok", exitCode: 0, output: "seeded pro,3" });
  });

  it("refuses commands that aren't allowed, outside the project, or through a link", async () => {
    const dir = project();
    const ctx = context(dir);
    expect(await runScriptHook("bash -c 'echo hi'", ctx)).toMatchObject({
      status: "refused",
      reason: "not_allowed",
      message: expect.stringContaining('Add "bash" to hooks.run.allow'),
    });
    expect(allowedCommand("../outside.js", ctx)).toMatchObject({ ok: false });
    expect(allowedCommand("scripts/missing.js", ctx)).toMatchObject({ ok: false });
    symlinkSync("/bin/sh", join(dir, "scripts", "sh.js"));
    expect(allowedCommand("scripts/sh.js", ctx)).toMatchObject({
      ok: false,
      message: expect.stringContaining("outside the project"),
    });
    expect(await runScriptHook("scripts/seed.js | cat", ctx)).toMatchObject({ status: "refused" });
    // Nothing is allowed by default.
    expect(await runScriptHook("node -v", context(dir, { settings: DEFAULT_HOOKS }))).toMatchObject(
      { status: "refused" },
    );
  });

  it("stops a script at the timeout", async () => {
    const dir = project();
    const ctx = context(dir);
    ctx.settings = { ...ctx.settings, run: { ...ctx.settings.run, timeoutSeconds: 0.3 } };
    const result = await runScriptHook("scripts/slow.js", ctx);
    expect(result).toMatchObject({ status: "failed", message: "timed out after 0.3 s" });
    expect(result.ms).toBeLessThan(3_000);
  });

  it("gives the script the project's secrets, never shows their values", async () => {
    const dir = project();
    const result = await runScriptHook("scripts/leak.js", context(dir));
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(result.output).toBe("url is [secret:DB_URL]");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("sql: hooks", () => {
  it("never runs in production unless the hook says so", async () => {
    const ctx = context(project(), { production: true });
    expect(await runSqlHook("DELETE FROM carts", undefined, ctx)).toMatchObject({
      status: "refused",
      reason: "production",
    });
  });

  it("needs a declared connection secret with a value", async () => {
    const dir = project();
    const none = context(dir);
    none.settings = { ...none.settings, sql: { client: "psql", timeoutSeconds: 5 } };
    expect(await runSqlHook("SELECT 1", undefined, none)).toMatchObject({
      status: "refused",
      reason: "missing_secret",
    });
    expect(await runSqlHook("SELECT 1", undefined, context(dir, { secrets: {} }))).toMatchObject({
      status: "refused",
      reason: "missing_secret",
      message: expect.stringContaining("DB_URL has no value"),
    });
  });

  it("passes the connection in the environment, never on the command line", () => {
    expect(
      clientEnv("psql", `postgres://seed:${SECRET}@db.local:6543/shop?sslmode=require`),
    ).toEqual({
      env: {
        PGHOST: "db.local",
        PGPORT: "6543",
        PGUSER: "seed",
        PGPASSWORD: SECRET,
        PGDATABASE: "shop",
        PGSSLMODE: "require",
      },
      args: ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c"],
    });
    const mysql = clientEnv("mysql", `mysql://root:${SECRET}@127.0.0.1:3307/shop`);
    expect(mysql?.env).toEqual({ MYSQL_PWD: SECRET });
    expect(mysql?.args.join(" ")).not.toContain(SECRET);
    expect(clientEnv("psql", "mysql://x@y/z")).toBeUndefined();
  });

  it("says when the client isn't installed", async () => {
    const result = await runSqlHook(
      "SELECT 1",
      undefined,
      context(project(), { env: { PATH: "" } }),
    );
    expect(result).toMatchObject({ status: "unsupported", reason: "no_client" });
    expect(result.message).toContain("psql client is not installed");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
