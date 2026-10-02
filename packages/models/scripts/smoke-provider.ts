// Manual check of a named provider with a REAL key (never run in CI). From the
// engine root, after `pnpm build`, with the key in the environment or .env:
//   node packages/models/scripts/smoke-provider.ts openrouter anthropic/claude-sonnet-5.5
//   node packages/models/scripts/smoke-provider.ts ollama-cloud kimi-k3
// Makes exactly 3 calls: the planner's tool path twice (the second should read
// the system prompt from the cache) and one structured-output (decision JSON)
// call as the fixer. Prints the key check (free) and, per call, the tool call,
// tokens, cost charged, list price and the gap between them. Never prints a key.
import { existsSync } from "node:fs";
import { resolveConfig } from "@optestra/config";
import { z } from "zod";
import { checkProviders, createModels, type ModelCallRecord } from "../dist/index.js";

const [kind, model] = process.argv.slice(2);
if ((kind !== "openrouter" && kind !== "ollama-cloud") || !model) {
  console.error("usage: smoke-provider.ts <openrouter|ollama-cloud> <model>");
  process.exit(2);
}
if (existsSync(".env")) process.loadEnvFile(".env");

const { config } = resolveConfig({
  project: {
    version: 1,
    project: { name: "smoke", target: "web" },
    environments: { local: { baseUrl: "http://localhost" } },
    models: {
      providers: { smoke: { kind } },
      roles: { planner: [{ provider: "smoke", model }], fixer: [{ provider: "smoke", model }] },
    },
  },
  env: process.env,
});

const [check] = (await checkProviders(config)).filter((c) => c.provider === "smoke");
console.log(JSON.stringify({ check }, null, 2));
if (check?.status !== "valid") process.exit(1);

const records: ModelCallRecord[] = [];
const models = createModels({ config, onCall: (r) => records.push(r) });

// A planner-shaped request: a long, stable system prompt (over Anthropic's
// 1,024-token cache minimum), the page as a snapshot, and the action tools.
const rules = Array.from(
  { length: 60 },
  (_, i) =>
    `Rule ${i + 1}: act only on elements in the snapshot, by their ref; never invent a ref, a URL or a value; one step at a time.`,
).join("\n");
const system = `You are the planner of an end-to-end test runner. You turn one plain-English test step into tool calls on the page.\n${rules}\nCall exactly the tools the step needs, then step_done.`;
const tools = [
  {
    name: "click",
    description: "Click an element by its ref from the page snapshot.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string", description: "e.g. e3" } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "fill",
    description: "Type a value into a field by its ref.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" }, value: { type: "string" } },
      required: ["ref", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "step_done",
    description: "The step is complete.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];
const page = `Page: Acme Shop, /login\n- heading "Sign in" [e1]\n- textbox "Email" [e2]\n- textbox "Password" [e3]\n- button "Sign in" [e4]\n- link "Forgot password?" [e5]`;

const toolCalls: unknown[] = [];
for (const step of ['Fill "Email" with ada@example.com', 'Click "Sign in"']) {
  const reply = await models.complete("planner", {
    system,
    messages: [{ role: "user", content: `Current step: ${step}\n\n${page}` }],
    tools,
    cache: true,
    maxOutputTokens: 300,
    tags: { smoke: step },
  });
  toolCalls.push(reply.ok ? reply.toolCalls : { failed: reply.reason, message: reply.message });
}
const decision = await models.complete("fixer", {
  system: "You answer with JSON only.",
  messages: [
    {
      role: "user",
      content:
        'Recorded: button "Sign in" in the login form. Now: button "Log in" in the same place. Same element? Give same (true/false) and confidence (0-1).',
    },
  ],
  output: z.object({ same: z.boolean(), confidence: z.number() }),
  maxOutputTokens: 200,
});

const rows = records.map((r) => ({
  role: r.role,
  outcome: r.outcome,
  model: r.model,
  latencyMs: r.latencyMs,
  waitMs: r.waitMs,
  tokens: r.usage,
  costUsd: r.costUsd,
  listCostUsd: r.listCostUsd,
  reportedCostUsd: r.reportedCostUsd,
  gapPct:
    r.reportedCostUsd && r.listCostUsd
      ? Number((((r.listCostUsd - r.reportedCostUsd) / r.reportedCostUsd) * 100).toFixed(2))
      : null,
  attempts: r.attempts.map((a) => `${a.attempt}:${a.outcome}${a.status ? `(${a.status})` : ""}`),
}));
console.log(
  JSON.stringify(
    { toolCalls, decision: decision.ok ? decision.object : decision.reason, calls: rows },
    null,
    2,
  ),
);
const total = records.reduce((n, r) => n + (r.costUsd ?? 0), 0);
console.log(
  `${records.length} calls, ${records.reduce((n, r) => n + r.attempts.filter((a) => a.attempt > 0).length, 0)} requests, $${total.toFixed(6)} charged`,
);
process.exitCode = records.every((r) => r.outcome === "ok") ? 0 : 1;
