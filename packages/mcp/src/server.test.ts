import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentInstructions } from "./instructions.js";
import { LATEST_PROTOCOL_VERSION } from "./protocol.js";
import { RESOURCES, serveStdio } from "./server.js";
import type { ToolContext } from "./tools.js";

// The MCP server (AGT-1) over stdio: the real `mcp` command in a child process
// for the project tools, and the same framing over in-memory streams with an
// injected engine for the tools that need a browser or AI. Every tool's input
// and output is checked against the schemas it publishes.

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../contract/fixtures/v1/", import.meta.url));
const BIN = fileURLToPath(new URL("../../cli/bin/cli.js", import.meta.url));

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** The shop project (tests and recordings) in a temp folder, with two finished runs. */
function shopProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-shop-"));
  temps.push(dir);
  cpSync(join(SHOP, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(SHOP, "tests"), join(dir, "tests"), { recursive: true });
  for (const name of ["failed-product-bug", "healed"]) {
    const run = JSON.parse(readFileSync(join(FIXTURES, name, "run.json"), "utf8")) as {
      runId: string;
    };
    cpSync(join(FIXTURES, name), join(dir, brand.dataDirName, "runs", run.runId), {
      recursive: true,
    });
  }
  return dir;
}

interface Response {
  id: number | string | null;
  result?: Record<string, unknown> & {
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/** A line-delimited JSON-RPC client over a pair of streams. */
class Client {
  #next = 1;
  #waiting = new Map<number | string | null, (r: Response) => void>();
  #buffer = "";
  readonly raw: Response[] = [];
  constructor(
    readonly write: (line: string) => void,
    output: NodeJS.ReadableStream,
  ) {
    output.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("utf8");
      for (let i = this.#buffer.indexOf("\n"); i >= 0; i = this.#buffer.indexOf("\n")) {
        const line = this.#buffer.slice(0, i);
        this.#buffer = this.#buffer.slice(i + 1);
        const message = JSON.parse(line) as Response;
        this.raw.push(message);
        this.#waiting.get(message.id)?.(message);
        this.#waiting.delete(message.id);
      }
    });
  }
  request(method: string, params?: Record<string, unknown>): Promise<Response> {
    const id = this.#next++;
    return this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, id);
  }
  send(message: unknown, id: number | string | null): Promise<Response> {
    const answer = new Promise<Response>((resolve) => this.#waiting.set(id, resolve));
    this.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
    return answer;
  }
  notify(method: string, params?: Record<string, unknown>) {
    this.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
  }
  async call(name: string, args: Record<string, unknown> = {}) {
    const response = await this.request("tools/call", { name, arguments: args });
    if (!response.result) throw new Error(JSON.stringify(response));
    return response.result;
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
let tools: { name: string; inputSchema: object; outputSchema: object }[] = [];
const valid = (name: string, value: unknown) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const validate = ajv.compile(tool.outputSchema);
  if (!validate(value)) throw new Error(`${name}: ${ajv.errorsText(validate.errors)}`);
  return true;
};
const validInput = (name: string, value: unknown) => {
  const tool = tools.find((t) => t.name === name);
  return ajv.compile(tool?.inputSchema ?? {})(value);
};

describe("the mcp command over stdio (a real process)", () => {
  let dir: string;
  let child: ChildProcess;
  let client: Client;
  let stderr = "";

  beforeAll(async () => {
    dir = shopProject();
    child = spawn(process.execPath, [BIN, "mcp"], {
      cwd: dir,
      // No keys, no subscription CLIs: nothing here may call a model.
      env: { PATH: "", HOME: dir, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    client = new Client((line) => child.stdin?.write(line), child.stdout as NodeJS.ReadableStream);
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: brand.cliName },
    });
    expect(String(init.result?.instructions)).toMatch(/never change an Expect: line/);
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list");
    tools = (listed.result?.tools ?? []) as typeof tools;
  }, 30_000);

  afterAll(() => {
    child.stdin?.end();
    child.kill();
  });

  it("lists exactly the tools of AGT-1, none that edits a test, all with valid schemas", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "list_tests",
      "get_test",
      "draft_test",
      "save_test",
      "run_tests",
      "get_results",
      "explain",
      "list_heals",
      "accept_heal",
    ]);
    for (const tool of tools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
      expect(() => ajv.compile(tool.outputSchema), tool.name).not.toThrow();
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
    // No tool takes an existing test and new text for it.
    expect(tools.some((t) => /edit|update|write|patch|delete/.test(t.name))).toBe(false);
  });

  it("answers ping, rejects unknown methods and bad JSON", async () => {
    expect((await client.request("ping")).result).toEqual({});
    expect((await client.request("prompts/get")).error?.code).toBe(-32601);
    const bad = await client.send("{not json", null);
    expect(bad.error?.code).toBe(-32700);
    const unknown = await client.request("tools/call", { name: "edit_test", arguments: {} });
    expect(unknown.error?.code).toBe(-32602);
  });

  it("serves the test format reference and the agent instructions", async () => {
    const list = await client.request("resources/list");
    expect(((list.result?.resources ?? []) as { uri: string }[]).map((r) => r.uri)).toEqual([
      RESOURCES.format,
      RESOURCES.agents,
    ]);
    const format = await client.request("resources/read", { uri: RESOURCES.format });
    const text = ((format.result?.contents ?? []) as { text: string; mimeType: string }[])[0];
    expect(text?.mimeType).toBe("text/markdown");
    expect(text?.text).toContain("## Frontmatter");
    expect(text?.text).toContain("### vague-step");
    const agents = await client.request("resources/read", { uri: RESOURCES.agents });
    expect(((agents.result?.contents ?? []) as { text: string }[])[0]?.text).toBe(
      agentInstructions(),
    );
    expect(
      (await client.request("resources/read", { uri: "file:///etc/passwd" })).error?.code,
    ).toBe(-32602);
  });

  it("list_tests: the shop's tests, with recordings", async () => {
    expect(validInput("list_tests", {})).toBe(true);
    const result = await client.call("list_tests");
    expect(result.isError).toBeUndefined();
    const out = result.structuredContent as {
      tests: { path: string; recorded: boolean; name: string }[];
      flows: { path: string }[];
    };
    expect(valid("list_tests", out)).toBe(true);
    expect(out.tests.map((t) => t.path)).toContain("tests/login.test.md");
    expect(out.tests.find((t) => t.path === "tests/login.test.md")).toMatchObject({
      name: "Returning user can log in and out",
      recorded: true,
    });
    expect(out.flows.map((f) => f.path)).toEqual(["tests/flows/login.test.md"]);
    // The text content is the same JSON, for clients without structured content.
    expect(JSON.parse(result.content?.[0]?.text ?? "")).toEqual(out);
    const smoke = (await client.call("list_tests", { tag: "smoke" })).structuredContent as {
      tests: unknown[];
    };
    expect(smoke.tests.length).toBeLessThan(out.tests.length);
  });

  it("get_test: the text, steps and findings", async () => {
    const result = await client.call("get_test", { path: "tests/login.test.md" });
    expect(valid("get_test", result.structuredContent)).toBe(true);
    const out = result.structuredContent as {
      text: string;
      steps: { kind: string; text: string }[];
      findings: unknown[];
    };
    expect(out.text).toBe(readFileSync(join(dir, "tests/login.test.md"), "utf8"));
    expect(out.steps.filter((s) => s.kind === "expect").map((s) => s.text)).toContain(
      'the page heading is "Dashboard"',
    );
    const missing = await client.call("get_test", { path: "tests/nope.test.md" });
    expect(missing.isError).toBe(true);
    const outside = await client.call("get_test", { path: "../../etc/passwd.test.md" });
    expect(outside.isError).toBe(true);
    expect(outside.content?.[0]?.text).toMatch(/not allowed/);
  });

  it("save_test: writes a new, lint-clean file only; never touches an existing test", async () => {
    const login = readFileSync(join(dir, "tests/login.test.md"), "utf8");
    // An agent trying to change an expectation of an existing test is refused.
    const weakened = login.replace(
      'Expect: the page heading is "Dashboard"',
      'Expect: the page shows "Dash"',
    );
    const overwrite = await client.call("save_test", {
      path: "tests/login.test.md",
      text: weakened,
    });
    expect(overwrite.isError).toBe(true);
    expect(overwrite.content?.[0]?.text).toMatch(/already exists.*never changes an existing test/s);
    expect(readFileSync(join(dir, "tests/login.test.md"), "utf8")).toBe(login);

    const vague = await client.call("save_test", {
      path: "tests/vague.test.md",
      text: "---\nname: Vague\nstart: /\n---\n\n1. Log in normally\n2. Expect: it works\n",
    });
    expect(vague.isError).toBe(true);
    expect(vague.content?.[0]?.text).toMatch(/lint must pass/);
    expect(existsSync(join(dir, "tests/vague.test.md"))).toBe(false);

    const recordings = await client.call("save_test", {
      path: `tests/${brand.dataDirName}/x.test.md`,
      text: "---\nname: X\n---\n",
    });
    expect(recordings.isError).toBe(true);

    const text = `---
name: Pricing page shows the plans
start: /pricing
---

1. Expect: the page heading is "Pricing"
`;
    const saved = await client.call("save_test", { path: "pricing.test.md", text });
    expect(saved.isError).toBeUndefined();
    expect(valid("save_test", saved.structuredContent)).toBe(true);
    expect(saved.structuredContent).toMatchObject({ saved: true, path: "tests/pricing.test.md" });
    expect(readFileSync(join(dir, "tests/pricing.test.md"), "utf8")).toBe(text);
    const again = await client.call("save_test", { path: "tests/pricing.test.md", text });
    expect(again.isError).toBe(true);
  });

  it("get_results: the latest run, a run by id, with the failing check and evidence paths", async () => {
    const latest = await client.call("get_results");
    expect(latest.isError).toBeUndefined();
    expect(valid("get_results", latest.structuredContent)).toBe(true);
    const failed = await client.call("get_results", { runId: "01M3EG7AG0M0AHEMTHAS09ZS7Y" });
    const out = failed.structuredContent as {
      runDir: string;
      summary: {
        exitCode: number;
        tests: {
          verdict: string;
          file: string;
          failingCheck: { expectation: string; expected: string; actual: string } | null;
          cause: string | null;
        }[];
      };
      evidence: { files: { kind: string; path: string }[] }[];
    };
    expect(valid("get_results", out)).toBe(true);
    const failing = out.summary.tests.find((t) => t.verdict === "failed");
    expect(failing?.cause).toBe("product_bug");
    expect(failing?.failingCheck?.expectation).toBeTruthy();
    expect(failing?.file).toMatch(/^tests\/.*\.md$/);
    expect(out.summary.exitCode).toBe(1);
    const files = out.evidence.flatMap((e) => e.files);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file.path.startsWith(out.runDir)).toBe(true);
    const unknown = await client.call("get_results", { runId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" });
    expect(unknown.isError).toBe(true);
    expect((await client.call("get_results", { runId: "../x" })).isError).toBe(true);
  });

  it("explain: a rules-only diagnosis citing the run's evidence, no AI", async () => {
    const result = await client.call("explain", { runId: "01M3EG7AG0M0AHEMTHAS09ZS7Y" });
    expect(result.isError).toBeUndefined();
    expect(valid("explain", result.structuredContent)).toBe(true);
    const out = result.structuredContent as {
      explanations: {
        mode: string;
        diagnosis: string;
        cause: string;
        evidence: { id: string }[];
      }[];
    };
    expect(out.explanations[0]).toMatchObject({ mode: "rules", cause: "product_bug" });
    expect(out.explanations[0]?.diagnosis).toMatch(/failed \[E1\]/);
    // No model is set up in this process: ai: true says so, it doesn't guess.
    const ai = await client.call("explain", { ai: true });
    expect(ai.isError).toBe(true);
    expect(ai.content?.[0]?.text).toMatch(/No AI model is available/);
  });

  it("list_heals: the heals of a run", async () => {
    const result = await client.call("list_heals", { runId: "01M3EFN0J0FQBKEWDYW4JQ19PW" });
    expect(result.isError).toBeUndefined();
    expect(valid("list_heals", result.structuredContent)).toBe(true);
    const out = result.structuredContent as { heals: { id: string; step: string }[] };
    expect(out.heals.length).toBeGreaterThan(0);
  });

  it("rejects arguments that don't match the input schema", async () => {
    expect(validInput("save_test", { path: "tests/a.test.md" })).toBe(false);
    const result = await client.call("save_test", { path: "tests/a.test.md" });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/Invalid arguments for save_test: text/);
    const extra = await client.call("list_tests", { tag: "smoke", edit: true });
    expect(extra.isError).toBe(true);
  });

  it("writes only protocol messages to stdout", () => {
    for (const message of client.raw) expect(message).toHaveProperty("jsonrpc", "2.0");
    expect(stderr).toBe("");
  });
});

describe("the engine tools over stdio (injected engine)", () => {
  const calls: { tool: string; args: unknown }[] = [];
  let dir: string;
  let client: Client;
  let served: Promise<void>;
  const input = new PassThrough();
  const output = new PassThrough();

  beforeAll(async () => {
    dir = shopProject();
    const runDir = join(dir, brand.dataDirName, "runs", "01M3EG7AG0M0AHEMTHAS09ZS7Y");
    const core: ToolContext["core"] = async () => ({
      runTests: (async (options: unknown) => {
        calls.push({ tool: "runTests", args: options });
        return { dir: runDir };
      }) as never,
      draftTest: (async (sentence: string, options: unknown) => {
        calls.push({ tool: "draftTest", args: { sentence, options } });
        return {
          status: "drafted",
          sentence,
          name: "Returning user can log in",
          path: "tests/returning-user-can-log-in.test.md",
          absolutePath: join(dir, "tests/returning-user-can-log-in.test.md"),
          text: '---\nname: Returning user can log in\nstart: /login\n---\n\n1. Click "Log in"\n2. Expect: the page heading is "Dashboard"\n',
          lintClean: true,
          findings: [],
          notes: [],
          totals: { aiCalls: 4, costUsd: 0, billing: "subscription" },
        };
      }) as never,
      listHeals: (() => ({ runDir, runId: "x", heals: [], rerecord: [] })) as never,
      explainRun: (async () => ({ runDir, runId: "x", explanations: [] })) as never,
      applyHeals: (async (_p: string, _d: string, ids: unknown) => {
        calls.push({ tool: "applyHeals", args: ids });
        return {
          accepted: [],
          rejected: [],
          skipped: [],
          recordings: [],
          specs: [],
          warnings: [],
          labels: 0,
        };
      }) as never,
    });
    served = serveStdio({ project: dir, env: {}, core }, { input, output });
    client = new Client((line) => input.write(line), output);
    await client.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    tools = ((await client.request("tools/list")).result?.tools ?? []) as typeof tools;
  });

  it("negotiates the latest protocol version when the client asks for an unknown one", async () => {
    const init = client.raw.find((r) => r.id === 1);
    expect(init?.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("draft_test returns the draft and saves nothing", async () => {
    const result = await client.call("draft_test", {
      sentence: "a returning user can log in",
      start: "/login",
    });
    expect(result.isError).toBeUndefined();
    expect(valid("draft_test", result.structuredContent)).toBe(true);
    expect(result.structuredContent).toMatchObject({
      saved: false,
      status: "drafted",
      path: "tests/returning-user-can-log-in.test.md",
      lintClean: true,
      ai: { calls: 4, billing: "subscription" },
    });
    expect(existsSync(join(dir, "tests/returning-user-can-log-in.test.md"))).toBe(false);
    expect(calls.at(-1)).toMatchObject({
      tool: "draftTest",
      args: { sentence: "a returning user can log in", options: { project: dir, start: "/login" } },
    });
  });

  it("run_tests runs through the runner and returns the AGT-3 summary", async () => {
    const result = await client.call("run_tests", {
      tests: ["login.test.md"],
      tags: ["smoke"],
      mode: "replay-only",
    });
    expect(result.isError).toBeUndefined();
    expect(valid("run_tests", result.structuredContent)).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      tool: "runTests",
      args: {
        projectDir: dir,
        tests: ["tests/login.test.md"],
        tags: ["smoke"],
        mode: "replay-only",
        trigger: "agent",
      },
    });
    const summary = (result.structuredContent as { summary: { kind: string } }).summary;
    expect(summary.kind).toBe("results-summary");
    expect(validInput("run_tests", { mode: "rerecord" })).toBe(false);
    expect((await client.call("run_tests", { mode: "rerecord" })).isError).toBe(true);
  });

  it("accept_heal goes through applyHeals", async () => {
    const result = await client.call("accept_heal", { ids: ["all"] });
    expect(result.isError).toBeUndefined();
    expect(valid("accept_heal", result.structuredContent)).toBe(true);
    expect(calls.at(-1)).toEqual({ tool: "applyHeals", args: "all" });
    expect((await client.call("accept_heal", { ids: [] })).isError).toBe(true);
  });

  it("ends when stdin ends", async () => {
    input.end();
    await served;
  });
});

it("the test project has both fixture runs", () => {
  const dir = shopProject();
  expect(readdirSync(join(dir, brand.dataDirName, "runs")).sort()).toEqual([
    "01M3EFN0J0FQBKEWDYW4JQ19PW",
    "01M3EG7AG0M0AHEMTHAS09ZS7Y",
  ]);
});
