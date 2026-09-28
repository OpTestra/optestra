import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { type RunningShop, startShop } from "@testament/fixture-shop";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// What a coding agent does with the MCP server (AGT-1, AGT-3): list the shop's
// tests, run one, and read why it failed, over stdio from the real `mcp`
// command. The runner is real (replay-only: no AI); the shop runs twice, the
// correct build and one whose login is broken, as two environments.

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const BIN = fileURLToPath(new URL("../../cli/bin/cli.js", import.meta.url));

let correct: RunningShop;
let broken: RunningShop;
let dir: string;
let child: ChildProcess;
let next = 1;
const waiting = new Map<number, (message: Record<string, unknown>) => void>();

function request(method: string, params: Record<string, unknown> = {}) {
  const id = next++;
  const answer = new Promise<Record<string, unknown>>((resolve) => waiting.set(id, resolve));
  child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return answer;
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = (await request("tools/call", { name, arguments: args })) as {
    result: {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content: { text: string }[];
    };
  };
  if (response.result.isError) throw new Error(response.result.content[0]?.text);
  return response.result.structuredContent as Record<string, unknown>;
}

beforeAll(async () => {
  correct = await startShop({ variant: "correct", port: 0 });
  broken = await startShop({ variant: "broken-login-redirect", port: 0 });
  for (const shop of [correct, broken]) await fetch(`${shop.url}/__test/seed`, { method: "POST" });
  dir = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
  cpSync(join(SHOP, "tests"), join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, brand.configFileName),
    `version: 1
project:
  name: Acme Shop
  target: web
defaultEnvironment: local
environments:
  local:
    baseUrl: ${correct.url}
    allowedDomains: [127.0.0.1]
  broken:
    baseUrl: ${broken.url}
    allowedDomains: [127.0.0.1]
secrets:
  SHOP_PASSWORD:
    domains: [127.0.0.1]
auth:
  profiles:
    ada:
      flow: flows/login.test.md
      check: { url: /dashboard }
`,
  );
  child = spawn(process.execPath, [BIN, "mcp"], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SHOP_PASSWORD: "shop-demo-pass",
      // No AI: no keys, and replay-only runs.
      ANTHROPIC_API_KEY: "",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, i)) as { id: number };
      buffer = buffer.slice(i + 1);
      waiting.get(message.id)?.(message);
    }
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
});

afterAll(async () => {
  child?.stdin?.end();
  child?.kill();
  await correct?.stop();
  await broken?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("a coding agent's session over MCP (real runner, no AI)", () => {
  it("lists the tests, runs one, and reads the failure on the broken build", async () => {
    const listed = await call("list_tests");
    expect((listed.tests as { path: string }[]).map((t) => t.path)).toContain(
      "tests/login.test.md",
    );

    const passed = (await call("run_tests", {
      tests: ["tests/login.test.md"],
      mode: "replay-only",
    })) as { summary: { exitCode: number; tests: { verdict: string; ai: { calls: number } }[] } };
    expect(passed.summary.tests.map((t) => t.verdict)).toEqual(["passed"]);
    expect(passed.summary.tests[0]?.ai.calls).toBe(0);
    expect(passed.summary.exitCode).toBe(0);

    const failed = (await call("run_tests", {
      tests: ["tests/login.test.md"],
      mode: "replay-only",
      environment: "broken",
    })) as {
      runDir: string;
      summary: {
        runId: string;
        exitCode: number;
        tests: {
          verdict: string;
          file: string;
          headline: string;
          cause: string;
          failingStep: { text: string } | null;
          failingCheck: { expectation: string; actual: string } | null;
        }[];
      };
      evidence: { files: { kind: string; path: string }[] }[];
    };
    const test = failed.summary.tests[0];
    expect(test?.verdict).toBe("failed");
    expect(test?.file).toBe("tests/login.test.md");
    expect(test?.cause).toBe("product_bug");
    expect(test?.headline).toBeTruthy();
    expect(test?.failingCheck ?? test?.failingStep).not.toBeNull();
    expect(failed.summary.exitCode).toBe(1);
    expect(failed.evidence[0]?.files.some((f) => f.kind === "screenshot")).toBe(true);

    // The same results later, by run id.
    const again = (await call("get_results", { runId: failed.summary.runId })) as {
      summary: { tests: { headline: string }[] };
    };
    expect(again.summary.tests[0]?.headline).toBe(test?.headline);
    const heals = (await call("list_heals")) as { heals: unknown[] };
    expect(heals.heals).toEqual([]);
  });
});
