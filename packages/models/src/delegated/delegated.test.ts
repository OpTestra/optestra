import { existsSync } from "node:fs";
import { resolveConfig } from "@testament/config";
import { Redactor } from "@testament/config/node";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import "../config.js";
import { BudgetMeter } from "../budget.js";
import { checkProviders } from "../check.js";
import { createModels } from "../client.js";
import { toModelCall } from "../contract.js";
import { resolvePools, resolveProviders } from "../keys.js";
import { CODEX_HELP, type FakeBehaviour, fakeCli } from "./fake-cli.test-support.js";
import {
  CLAUDE_MIN_VERSION,
  claudeArgs,
  codexArgs,
  delegatedEnv,
  EMPTY_MCP_CONFIG,
} from "./lockdown.js";
import { strictSchema } from "./run.js";

const TOOLS = [
  {
    name: "click",
    description: "Click",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "step_done",
    description: "Done",
    parameters: {
      type: "object",
      properties: { visible_effect: { type: "string" } },
      required: ["visible_effect"],
      additionalProperties: false,
    },
  },
];

const ok = (value: unknown) => ({ kind: "ok" as const, value });
const claudeOk: FakeBehaviour = {
  replies: [ok({ toolCalls: [{ name: "click", input: { ref: "e5" } }], text: "clicking" })],
};

function config(models: Record<string, unknown>) {
  const result = resolveConfig({
    project: {
      version: 1,
      project: { name: "T", target: "web" },
      environments: { local: { baseUrl: "http://127.0.0.1:1" } },
      models,
    },
    env: {},
  });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(JSON.stringify(errors));
  return result.config;
}

/** Parent env with things that must never reach the CLI. */
const parentEnv = (extra: Record<string, string> = {}) => ({
  HOME: process.env.HOME ?? "/tmp",
  PATH: process.env.PATH ?? "",
  USERPROFILE: process.env.USERPROFILE ?? "",
  SYSTEMROOT: process.env.SYSTEMROOT ?? "",
  ANTHROPIC_API_KEY: "sk-ant-must-not-leak-1111",
  OPENAI_API_KEY: "sk-openai-must-not-leak-2222",
  SHOP_PASSWORD: "shop-demo-pass",
  AWS_SECRET_ACCESS_KEY: "aws-must-not-leak",
  ...extra,
});

function client(
  pool: Array<{ provider: string; model: string }>,
  providers: Record<string, unknown>,
  extra: {
    cap?: number;
    env?: Record<string, string>;
    allowDelegated?: boolean;
    timeoutSeconds?: number;
  } = {},
) {
  const records: unknown[] = [];
  const meter = new BudgetMeter("run", extra.cap ?? null);
  const models = createModels({
    config: config({
      providers,
      roles: { planner: pool, fixer: pool },
      ...(extra.allowDelegated === false ? { allowDelegated: false } : {}),
      ...(extra.timeoutSeconds ? { timeoutSeconds: extra.timeoutSeconds } : {}),
    }),
    sources: [],
    env: parentEnv(extra.env),
    budgets: [meter],
    redactor: new Redactor(),
    backoffMs: 1,
    onCall: (r) => records.push(r),
  });
  return { models, records, meter };
}

describe("locked-down argument lists (pinned)", () => {
  it("claude: headless, restricted, no tools, no MCP, no settings, no history", () => {
    expect(claudeArgs({ model: "sonnet", system: "SYS", schema: "{}" })).toEqual([
      "-p",
      "--restricted",
      "--tools",
      "",
      "--disallowedTools",
      "mcp__*",
      "--strict-mcp-config",
      "--mcp-config",
      EMPTY_MCP_CONFIG,
      "--disable-slash-commands",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--system-prompt",
      "SYS",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      "{}",
      "--model",
      "sonnet",
    ]);
    expect(claudeArgs({ model: "default", system: "S", schema: "{}" })).not.toContain("--model");
    expect(CLAUDE_MIN_VERSION).toBe("2.1.259");
  });

  it("codex: exec, read-only, every tool feature off, no user config, ephemeral", () => {
    expect(
      codexArgs({
        model: "default",
        schemaFile: "/t/s.json",
        lastMessageFile: "/t/l.json",
        workdir: "/t",
        images: ["/t/i.png"],
      }),
    ).toEqual([
      "exec",
      "--json",
      "--output-schema",
      "/t/s.json",
      "--output-last-message",
      "/t/l.json",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--cd",
      "/t",
      "-c",
      "features.shell_tool=false",
      "-c",
      "features.unified_exec=false",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.apps=false",
      "-c",
      "features.hooks=false",
      "-c",
      "features.memories=false",
      "-c",
      'web_search="disabled"',
      "-c",
      "tools.view_image=false",
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      'history.persistence="none"',
      "--image",
      "/t/i.png",
      "-",
    ]);
  });

  it("passes only a minimal environment plus the lock-down switches", () => {
    const env = delegatedEnv(
      "claude-code",
      { ...parentEnv(), CLAUDE_CONFIG_DIR: "/home/u/.claude-alt" },
      "/tmp/x",
    );
    expect(Object.keys(env).sort()).toEqual(
      [
        "CLAUDE_CODE_DISABLE_ATTACHMENTS",
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
        "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS",
        "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "CLAUDE_CODE_DISABLE_WORKFLOWS",
        "CLAUDE_CODE_SKIP_PROMPT_HISTORY",
        "CLAUDE_CONFIG_DIR",
        "DISABLE_AUTOUPDATER",
        "HOME",
        "NO_COLOR",
        "PATH",
        "TEMP",
        "TERM",
        "TMP",
        "TMPDIR",
        ...(parentEnv().SYSTEMROOT ? ["SYSTEMROOT"] : []),
        ...(parentEnv().USERPROFILE ? ["USERPROFILE"] : []),
      ].sort(),
    );
    expect(JSON.stringify(env)).not.toMatch(/must-not-leak|shop-demo-pass/);
  });
});

describe("claude-code provider (fake CLI)", () => {
  it("round-trips tool calls through the JSON schema, in an empty folder, with none of our secrets", async () => {
    const fake = fakeCli("claude", claudeOk);
    const { models, records } = client([{ provider: "cc", model: "sonnet" }], {
      cc: { kind: "claude-code", binary: fake.path },
    });
    const result = await models.complete("planner", {
      system: "You are a planner.",
      messages: [{ role: "user", content: "Log in" }],
      tools: TOOLS,
    });
    expect(result.ok && result.toolCalls).toEqual([
      { id: "call-1", name: "click", input: { ref: "e5" } },
    ]);
    expect(result.ok && result.text).toBe("clicking");
    const [call] = fake.calls();
    expect(call?.argv[0]).toBe("-p");
    const schema = JSON.parse(call?.argv[call.argv.indexOf("--json-schema") + 1] ?? "{}");
    expect(
      schema.properties.toolCalls.items.anyOf.map(
        (t: { properties: { name: { const: string } } }) => t.properties.name.const,
      ),
    ).toEqual(["click", "step_done"]);
    expect(call?.argv[call.argv.indexOf("--system-prompt") + 1]).toContain("You are a planner.");
    const message = JSON.parse(call?.stdin ?? "{}");
    expect(message).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Log in" }] },
    });
    expect(call?.filesInCwd).toEqual([]);
    expect(call?.cwd).not.toBe(process.cwd());
    expect(existsSync(call?.cwd ?? "/")).toBe(false); // removed afterwards
    expect(JSON.stringify(call?.env)).not.toMatch(
      /must-not-leak|shop-demo-pass|ANTHROPIC_API_KEY|OPENAI_API_KEY/,
    );
    expect(call?.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    // Recorded as subscription use: cost 0, tokens kept, the tool's own estimate for information.
    const record = result.ok ? result.record : undefined;
    expect(record).toMatchObject({
      billing: "subscription",
      costUsd: 0,
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    expect(record?.attempts.at(-1)).toMatchObject({
      billing: "subscription",
      reportedCostUsd: 0.0123,
    });
    expect(toModelCall(record as never)).toMatchObject({ billing: "subscription", costUsd: 0 });
    expect(JSON.stringify(records)).not.toContain("private@example.com");
  });

  it("passes images through the CLI's own stream-json image input", async () => {
    const fake = fakeCli("claude", claudeOk);
    const { models } = client([{ provider: "cc", model: "sonnet" }], {
      cc: { kind: "claude-code", binary: fake.path },
    });
    await models.complete("planner", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" },
          ],
        },
      ],
      tools: TOOLS,
    });
    const content = JSON.parse(fake.calls()[0]?.stdin ?? "{}").message.content;
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AQID" },
    });
  });

  it("supports structured output (object) and plain text", async () => {
    const fake = fakeCli("claude", { replies: [ok({ verdict: "yes", score: 2 })] });
    const { models } = client([{ provider: "cc", model: "haiku" }], {
      cc: { kind: "claude-code", binary: fake.path },
    });
    const result = await models.complete("fixer", {
      messages: [{ role: "user", content: "q" }],
      output: z.object({ verdict: z.string(), score: z.number() }),
    });
    expect(result.ok && result.object).toEqual({ verdict: "yes", score: 2 });
  });

  it("not signed in → auth_failed; the provider is disabled for the run", async () => {
    const fake = fakeCli("claude", { replies: [{ kind: "auth" }] });
    const { models } = client([{ provider: "cc", model: "sonnet" }], {
      cc: { kind: "claude-code", binary: fake.path },
    });
    const result = await models.complete("planner", {
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
    });
    expect(result).toMatchObject({ ok: false, reason: "auth_failed" });
    expect(!result.ok && result.fix).toContain("claude auth login");
    const again = await models.complete("planner", {
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
    });
    expect(again.ok).toBe(false);
    expect(fake.calls()).toHaveLength(1);
  });

  it("plan limit → typed failure, and failover to the next pool entry", async () => {
    const limited = fakeCli("claude", { replies: [{ kind: "plan" }] });
    const codex = fakeCli("codex", {
      helpFlags: CODEX_HELP,
      replies: [
        ok({ toolCalls: [{ name: "step_done", input: { visible_effect: "ok" } }], text: null }),
      ],
    });
    const { models } = client(
      [
        { provider: "cc", model: "sonnet" },
        { provider: "cx", model: "default" },
      ],
      {
        cc: { kind: "claude-code", binary: limited.path },
        cx: { kind: "codex", binary: codex.path },
      },
    );
    const result = await models.complete("planner", {
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
    });
    expect(result.ok && result.provider).toBe("cx");
    expect(result.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ["cc", "plan_limit"],
      ["cx", "ok"],
    ]);
    const alone = client([{ provider: "cc", model: "sonnet" }], {
      cc: { kind: "claude-code", binary: limited.path },
    });
    const failed = await alone.models.complete("planner", {
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
    });
    expect(failed).toMatchObject({ ok: false, reason: "all_providers_failed" });
    expect(!failed.ok && failed.message).toContain("Plan limit reached");
  });

  it("malformed output → one retry, then invalid_output", async () => {
    const fake = fakeCli("claude", { replies: [{ kind: "malformed" }] });
    const { models } = client([{ provider: "cc", model: "sonnet" }], {
      cc: { kind: "claude-code", binary: fake.path },
    });
    const result = await models.complete("planner", {
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid_output" });
    expect(fake.calls()).toHaveLength(2);
    expect(fake.calls()[1]?.stdin).toContain("Reply again with only a valid object");
  });

  it("timeout and abort stop the process", async () => {
    const fake = fakeCli("claude", { replies: [{ kind: "hang" }] });
    const { models } = client([{ provider: "cc", model: "sonnet" }], {
      cc: { kind: "claude-code", binary: fake.path },
    });
    const timed = await models.complete("planner", {
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
      timeoutMs: 800,
    });
    expect(timed.ok).toBe(false);
    expect(timed.attempts[0]?.outcome).toBe("timeout");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const aborted = await models.complete("planner", {
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
      signal: controller.signal,
    });
    expect(aborted).toMatchObject({ ok: false, reason: "aborted" });
    await new Promise((r) => setTimeout(r, 2500));
    for (const call of fake.calls()) {
      expect(() => process.kill(call.pid, 0), `pid ${call.pid} still running`).toThrow();
    }
  }, 30_000);

  it("refuses a version below the minimum", async () => {
    const fake = fakeCli("claude", { version: "2.1.100", ...claudeOk });
    const { models } = client([{ provider: "cc", model: "sonnet" }], {
      cc: { kind: "claude-code", binary: fake.path },
    });
    const result = await models.complete("planner", {
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts[0]).toMatchObject({ outcome: "cli_unavailable" });
    expect(result.attempts[0]?.message).toContain("older than 2.1.259");
    expect(fake.calls()).toHaveLength(0);
  });

  it("allowDelegated: false (the cloud) skips subscription entries with a reason", async () => {
    const fake = fakeCli("claude", claudeOk);
    const { models } = client(
      [{ provider: "cc", model: "sonnet" }],
      { cc: { kind: "claude-code", binary: fake.path } },
      { allowDelegated: false },
    );
    const result = await models.complete("planner", {
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
    });
    expect(result).toMatchObject({ ok: false, reason: "no_provider" });
    expect(result.attempts[0]).toMatchObject({
      outcome: "skipped_unusable",
      message: expect.stringContaining("allowDelegated: false"),
    });
    expect(fake.calls()).toHaveLength(0);
  });

  it("stops at the per-run call cap and charges nothing to the budget", async () => {
    const fake = fakeCli("claude", claudeOk);
    const c = config({
      providers: { cc: { kind: "claude-code", binary: fake.path } },
      roles: { planner: [{ provider: "cc", model: "sonnet" }], fixer: [] },
      delegatedCallsPerRun: 2,
    });
    const meter = new BudgetMeter("run", 0.000001);
    const models = createModels({
      config: c,
      sources: [],
      env: parentEnv(),
      budgets: [meter],
      backoffMs: 1,
    });
    const ask = () =>
      models.complete("planner", { messages: [{ role: "user", content: "x" }], tools: TOOLS });
    expect((await ask()).ok).toBe(true);
    expect((await ask()).ok).toBe(true);
    expect(meter.spentUsd).toBe(0);
    const third = await ask();
    expect(third.ok).toBe(false);
    expect(third.attempts[0]).toMatchObject({ outcome: "skipped_call_cap" });
  });
});

describe("codex provider (fake CLI)", () => {
  it("round-trips tool calls with a strict schema file and images as files", async () => {
    const fake = fakeCli("codex", {
      helpFlags: CODEX_HELP,
      replies: [ok({ toolCalls: [{ name: "click", input: { ref: "e2" } }], text: null })],
    });
    const { models } = client([{ provider: "cx", model: "default" }], {
      cx: { kind: "codex", binary: fake.path },
    });
    const result = await models.complete("planner", {
      system: "SYS",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "go" },
            { type: "image", data: new Uint8Array([9]), mediaType: "image/png" },
          ],
        },
      ],
      tools: TOOLS,
    });
    expect(result.ok && result.toolCalls).toEqual([
      { id: "call-1", name: "click", input: { ref: "e2" } },
    ]);
    expect(result.ok && result.record.billing).toBe("subscription");
    const call = fake.calls()[0];
    expect(call?.argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(call?.argv).toContain("features.shell_tool=false");
    expect(call?.argv.at(-1)).toBe("-");
    expect(call?.argv[call.argv.indexOf("--image") + 1]).toMatch(/image-1\.png$/);
    expect(call?.filesInCwd.sort()).toEqual(["image-1.png", "schema.json"]);
    expect(call?.stdin.startsWith("SYS")).toBe(true);
    expect(JSON.stringify(call?.env)).not.toMatch(/must-not-leak|shop-demo-pass/);
  });

  it("refuses a Codex without the lock-down flags", async () => {
    const fake = fakeCli("codex", { helpFlags: ["--json"], replies: [ok({ toolCalls: [] })] });
    const { models } = client([{ provider: "cx", model: "default" }], {
      cx: { kind: "codex", binary: fake.path },
    });
    const result = await models.complete("planner", {
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
    });
    expect(result.attempts[0]?.outcome).toBe("cli_unavailable");
    expect(result.attempts[0]?.message).toContain("--ignore-user-config");
    expect(fake.calls()).toHaveLength(0);
  });

  it("maps codex errors: not signed in and plan limit", async () => {
    const fake = fakeCli("codex", { helpFlags: CODEX_HELP, replies: [{ kind: "auth" }] });
    const first = client([{ provider: "cx", model: "default" }], {
      cx: { kind: "codex", binary: fake.path },
    });
    expect(
      await first.models.complete("planner", {
        messages: [{ role: "user", content: "x" }],
        tools: TOOLS,
      }),
    ).toMatchObject({ reason: "auth_failed" });
    fake.setBehaviour({ helpFlags: CODEX_HELP, replies: [{ kind: "plan" }] });
    const second = client([{ provider: "cx", model: "default" }], {
      cx: { kind: "codex", binary: fake.path },
    });
    const result = await second.models.complete("planner", {
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
    });
    expect(result.attempts[0]?.outcome).toBe("plan_limit");
  });

  it("makes optional properties nullable for strict schemas", () => {
    expect(
      strictSchema({
        type: "object",
        properties: { key: { type: "string" }, ref: { type: "string" } },
        required: ["key"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        key: { type: "string" },
        ref: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["key", "ref"],
      additionalProperties: false,
    });
  });
});

describe("detection and checks", () => {
  it.skipIf(process.platform === "win32")(
    "finds a signed-in claude on PATH after the API-key entries",
    async () => {
      const fake = fakeCli("claude", claudeOk, { asExecutable: true });
      const env = parentEnv({ PATH: `${fake.dir}:${process.env.PATH}` });
      delete (env as Record<string, string>).ANTHROPIC_API_KEY;
      const c = config({
        providers: {
          anthropic: { kind: "anthropic", keySecret: "ANTHROPIC_API_KEY" },
          "claude-code": { kind: "claude-code" },
        },
        roles: {
          planner: [
            { provider: "anthropic", model: "claude-sonnet-5" },
            { provider: "claude-code", model: "sonnet" },
          ],
          fixer: [],
        },
      });
      const pools = resolvePools(c, resolveProviders(c, [], undefined, env));
      expect(pools.planner.map((e) => [e.provider, e.usable])).toEqual([
        ["anthropic", false],
        ["claude-code", true],
      ]);
      const checks = await checkProviders(c, { sources: [], env });
      expect(checks.find((ch) => ch.provider === "claude-code")).toMatchObject({
        status: "valid",
        version: "2.1.300",
      });
      fake.setBehaviour({ ...claudeOk, signedIn: false });
      const again = await checkProviders(c, { sources: [], env });
      expect(again.find((ch) => ch.provider === "claude-code")).toMatchObject({
        status: "not_signed_in",
        fix: expect.stringContaining("claude auth login"),
      });
      const missing = resolveProviders(c, [], undefined, { ...env, PATH: "/nonexistent" });
      expect(missing.get("claude-code")?.problem).toContain("not installed");
    },
  );
});
