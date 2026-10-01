import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { SessionStore } from "@optestra/auth";
import { afterAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const dirs: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const server of servers) server.close();
});

const run = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number; stdout: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { cwd, encoding: "utf8", env: { ...process.env, ...env } },
      (error, stdout) => resolve({ status: error ? Number(error.code ?? 1) : 0, stdout }),
    );
  });

const PLANTED = "planted-cli-cookie-3317";

function project(extra = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-auth-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, brand.configFileName),
    `version: 1
project: { name: Shop, target: web }
environments:
  local: { baseUrl: "http://127.0.0.1:4100" }
  staging: { baseUrl: "https://staging.acme.test" }
auth:
  profiles:
    admin:
      flow: flows/login-admin.test.md
      check: { url: /dashboard }
    viewer:
      flow: flows/login-viewer.test.md
      reuse: shared
${extra}`,
  );
  mkdirSync(join(dir, "tests", "flows"), { recursive: true });
  writeFileSync(
    join(dir, "tests", "flows", "login-admin.test.md"),
    '---\nname: L\nkind: flow\n---\n\n1. Click "Log in"\n',
  );
  return dir;
}

function save(dir: string, profile: string, environment: string, worker: number, ttlMinutes = 60) {
  const store = new SessionStore({ projectDir: dir });
  const state = {
    cookies: [
      {
        name: "sid",
        value: PLANTED,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };
  store.save(store.keyFor(profile, { reuse: "per-worker" }, { environment, worker }), state, {
    ttlMinutes,
    fingerprint: "f",
  });
}

describe("auth", { timeout: 30_000 }, () => {
  it("lists profiles with their saved sessions per environment, never a cookie", async () => {
    const dir = project();
    save(dir, "admin", "local", 0);
    save(dir, "admin", "local", 1);
    save(dir, "admin", "staging", 0, -1); // already expired
    const { status, stdout } = await run(dir, ["auth"]);
    // viewer's flow is missing: listed, and reported (exit 1).
    expect(status).toBe(1);
    expect(stdout).toMatch(
      /admin\s+flows\/login-admin\.test\.md\s+per-worker\s+60 min\s+valid until \d\d:\d\d UTC \(2 sessions\)\s+expired/,
    );
    expect(stdout).toMatch(
      /viewer\s+flows\/login-viewer\.test\.md\s+shared\s+60 min\s+none\s+none/,
    );
    expect(stdout).toContain("login-viewer.test.md, which doesn't exist");
    expect(stdout).not.toContain(PLANTED);
    const json = await run(dir, ["auth", "--json"]);
    expect(JSON.parse(json.stdout).profiles[0].environments.local).toMatchObject({
      status: "valid",
      workers: 2,
    });
    expect(json.stdout).not.toContain(PLANTED);
  });

  it("--clear deletes one profile's sessions, or all", async () => {
    const dir = project();
    save(dir, "admin", "local", 0);
    save(dir, "viewer", "local", 0);
    save(dir, "admin", "staging", 0);
    expect((await run(dir, ["auth", "--clear", "admin", "-e", "staging"])).stdout).toBe(
      "Deleted 1 saved session (profile admin in staging).\n",
    );
    expect((await run(dir, ["auth", "--clear", "admin"])).stdout).toBe(
      "Deleted 1 saved session (profile admin).\n",
    );
    expect((await run(dir, ["auth", "--clear"])).stdout).toBe(
      "Deleted 1 saved session (all profiles).\n",
    );
    expect(new SessionStore({ projectDir: dir }).list()).toEqual([]);
  });
});

async function fakeMailpit(): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const message = {
      ID: "m1",
      From: { Address: "no-reply@acme.test" },
      To: [{ Address: "ada@example.test" }],
      Subject: "Verify your email",
      Created: "2026-09-26T10:00:00Z",
    };
    if (url.pathname === "/api/v1/info") return json({ Version: "v1.27.0" });
    if (url.pathname === "/api/v1/search") {
      return json({ messages: url.searchParams.get("query")?.includes("ada@") ? [message] : [] });
    }
    if (url.pathname === "/api/v1/message/m1") {
      return json({
        ...message,
        Date: message.Created,
        Text: "Your verification code is 482913.\nhttp://127.0.0.1:4100/verify?t=abc\nhttps://evil.example/verify?t=abc\nSECRET-BODY-LINE",
        HTML: "",
      });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("inbox", { timeout: 30_000 }, () => {
  it("check: reachable Mailpit is ok; none configured is exit 2; down is exit 1", async () => {
    const url = await fakeMailpit();
    const dir = project(`inbox:\n  provider: mailpit\n  mailpit: { url: "${url}" }\n`);
    const ok = await run(dir, ["inbox", "check"]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("Mailpit v1.27.0 is running.");
    const none = await run(project(), ["inbox", "check"]);
    expect(none.status).toBe(2);
    expect(none.stdout).toContain("inbox.provider is none");
    const down = await run(
      project('inbox:\n  provider: mailpit\n  mailpit: { url: "http://127.0.0.1:9" }\n'),
      ["inbox", "check"],
    );
    expect(down.status).toBe(1);
    expect(down.stdout).toContain("unavailable");
  });

  it("check: a missing hosted key is reported, never sent", async () => {
    const dir = project("inbox:\n  provider: mailslurp\n");
    const result = await run(dir, ["inbox", "check"], { MAILSLURP_API_KEY: "" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("MAILSLURP_API_KEY is not set");
  });

  it("last: prints the subject, code and allowed link, never the body", async () => {
    const url = await fakeMailpit();
    const dir = project(`inbox:\n  provider: mailpit\n  mailpit: { url: "${url}" }\n`);
    const { status, stdout } = await run(dir, [
      "inbox",
      "last",
      "--to",
      "ada@example.test",
      "-e",
      "local",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("Subject   Verify your email");
    expect(stdout).toContain("Code      482913");
    expect(stdout).toContain("Link      http://127.0.0.1:4100/verify?t=abc");
    expect(stdout).toContain("Refused   links to evil.example");
    expect(stdout).not.toContain("SECRET-BODY-LINE");
    const miss = await run(dir, ["inbox", "last", "--to", "bo@example.test", "--wait", "1"]);
    expect(miss.status).toBe(1);
    expect(miss.stdout).toContain("No email to bo@example.test.");
  });
});
