import { execFile, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { afterAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const fixtures = fileURLToPath(new URL("../../contract/fixtures/v1/", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
// No real keys reach the child processes.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !["JEV_API_KEY", "KEV_API_KEY"].includes(key)),
);
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [bin, "decisions", ...args], { cwd, encoding: "utf8", env });
/** Async, so a fake server in this process can answer the child. */
const runAsync = (cwd: string, args: string[], extraEnv: Record<string, string> = {}) =>
  new Promise<{ status: number; stdout: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { cwd, encoding: "utf8", env: { ...env, ...extraEnv } },
      (error, stdout) => resolve({ status: error ? Number(error.code ?? 1) : 0, stdout }),
    );
  });

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});
/** A fake Ollaya 0.6.1 with laya:typed-decisions installed; answers every decision with noul 0.95. */
async function fakeOllaya(): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  const installed = ["laya:typed-decisions"];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      paths.push(`${req.method} ${req.url}`);
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/") return res.end("Ollaya is running");
      if (req.url === "/api/version") return json(200, { version: "0.6.1" });
      if (req.url === "/api/tags")
        return json(200, { models: installed.map((name) => ({ name, size: 853527607 })) });
      if (req.url === "/api/pull") {
        installed.push(JSON.parse(body).model);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ status: "pulling manifest" })}\n`);
        res.write(`${JSON.stringify({ status: "pulling abc", total: 10, completed: 10 })}\n`);
        return res.end(`${JSON.stringify({ status: "success" })}\n`);
      }
      if (req.url === "/api/decide") {
        const questions = Object.keys(JSON.parse(body).questions);
        return json(200, {
          model: "laya:typed-decisions",
          answers: Object.fromEntries(questions.map((q) => [q, { type: "noul", noul: 0.95 }])),
          usage: { input_tokens: 50, output_tokens: 0 },
          state_truncated: false,
        });
      }
      json(404, { error: "not found", code: "NOT_FOUND" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths };
}
function projectWith(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-decisions-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, brand.configFileName),
    [
      "version: 1",
      "project: { name: demo }",
      "environments: { local: { baseUrl: 'http://localhost:3000' } }",
      ...lines,
      "",
    ].join("\n"),
  );
  return dir;
}

describe("decisions command", () => {
  it("lists page_is_error with its threshold and time limit, rules only by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-decisions-"));
    dirs.push(dir);
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Backend    auto → none (rules only; set JEV_API_KEY to use Jev)",
    );
    expect(result.stdout).toMatch(/page_is_error\s+v1\s+during\s+0\.80\s+100 ms\s+on\s+fixer/);
  });

  it("applies project overrides and warns about unknown task names", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-decisions-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, brand.configFileName),
      [
        "version: 1",
        "project: { name: demo }",
        "environments: { local: { baseUrl: 'http://localhost:3000' } }",
        "decisions:",
        "  threshold: 0.7",
        "  tasks:",
        "    page_is_error: { threshold: 0.9, timeLimitMs: 250 }",
        "    typo_task: { enabled: false }",
        "",
      ].join("\n"),
    );
    const output = JSON.parse(run(dir, "--json").stdout);
    expect(output.threshold).toBe(0.7);
    expect(output.tasks[0]).toMatchObject({
      name: "page_is_error",
      threshold: 0.9,
      timeLimitMs: 250,
    });
    expect(output.problems[0].message).toContain("typo_task");
  });

  it("prints per-task metrics from a run folder with --stats", () => {
    const result = run(fixtures, "--stats", "flaky");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/failure_cause\s+1\s+100%\s+0%\s+0%/);
    const json = JSON.parse(run(fixtures, "--stats", "flaky", "--json").stdout);
    expect(json.tasks.flaky_or_real).toMatchObject({ total: 1, rules: 1, cacheHits: null });
    expect(run(fixtures, "--stats", "no-such-run").status).toBe(2);
  });

  it("--check reports each backend and fails only when the selected one is unusable", async () => {
    const ollaya = await fakeOllaya();
    const closed = "http://127.0.0.1:9"; // discard port: nothing listens
    const base = [
      "decisions:",
      `  kev: { baseUrl: "${closed}" }`,
      `  laya: { baseUrl: "${ollaya.url}" }`,
    ];
    const auto = await runAsync(projectWith(base), ["decisions", "--check"]);
    expect(auto.status).toBe(0);
    expect(auto.stdout).toMatch(/jev\s+https:\/\/api\.typesafe\.ai\s+jev-latest\s+no key/);
    expect(auto.stdout).toMatch(/kev\s+http:\/\/127\.0\.0\.1:9\s+kev-latest\s+unreachable/);
    expect(auto.stdout).toContain("Ollaya 0.6.1 running; laya:typed-decisions installed");

    const kev = await runAsync(projectWith([...base, "  backend: kev"]), ["decisions", "--check"]);
    expect(kev.status).toBe(2);
    expect(kev.stdout).toContain("The selected backend (kev) is not usable");
  });

  it("--bench measures Laya after a warm-up", async () => {
    const ollaya = await fakeOllaya();
    const dir = projectWith(["decisions:", `  laya: { baseUrl: "${ollaya.url}" }`]);
    const result = await runAsync(dir, [
      "decisions",
      "--bench",
      "--backend",
      "laya",
      "--n",
      "5",
      "--json",
    ]);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.results[0]).toMatchObject({ backend: "laya", n: 5, decided: 5, errorRate: 0 });
    expect(output.layaTarget.met).toBe(true);
    // One warm-up plus five decisions.
    expect(ollaya.paths.filter((p) => p === "POST /api/decide")).toHaveLength(6);
  });

  it("decider setup laya finds Ollaya, and pulls a missing model only with consent", async () => {
    const ollaya = await fakeOllaya();
    const dir = projectWith(["decisions:", `  laya: { baseUrl: "${ollaya.url}" }`]);
    const found = await runAsync(dir, ["decider", "setup", "laya"]);
    expect(found.status).toBe(0);
    expect(found.stdout).toContain("Ollaya 0.6.1 at");
    expect(found.stdout).toContain("laya:typed-decisions is ready");

    const noTty = await runAsync(dir, ["decider", "setup", "laya", "--model", "laya:en"]);
    expect(noTty.status).toBe(1);
    expect(noTty.stdout).toContain("laya:en is not installed. Download size: 854 MB.");
    expect(noTty.stdout).toContain("Re-run with --yes");
    expect(ollaya.paths).not.toContain("POST /api/pull");

    const pulled = await runAsync(dir, ["decider", "setup", "laya", "--model", "laya:en", "--yes"]);
    expect(pulled.status).toBe(0);
    expect(pulled.stdout).toContain("Downloaded laya:en.");
    expect(ollaya.paths).toContain("POST /api/pull");
  });

  it("decider setup laya prints the fix when Ollaya isn't running and never installs it", async () => {
    const dir = projectWith(["decisions:", '  laya: { baseUrl: "http://127.0.0.1:9" }']);
    const result = await runAsync(dir, ["decider", "setup", "laya"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Ollaya is not running at http://127.0.0.1:9");
    expect(result.stdout).toMatch(/Fix: .*Ollaya/);
    expect(result.stdout).toContain("never installs Ollaya");
  });
});
