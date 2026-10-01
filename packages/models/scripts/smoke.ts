// Manual check with a REAL key (never run in CI). From engine/, after `pnpm build`:
//   ANTHROPIC_API_KEY=... node packages/models/scripts/smoke.ts [planner|fixer]
// Makes one small structured-output request and prints the result, usage and cost.
import { resolveConfig } from "@optestra/config";
import { z } from "zod";
import { createModels } from "../dist/index.js";

const role = process.argv[2] === "fixer" ? "fixer" : "planner";
const { config } = resolveConfig({
  project: {
    version: 1,
    project: { name: "smoke", target: "web" },
    environments: { local: { baseUrl: "http://localhost" } },
  },
  env: process.env,
});
const models = createModels({ config });
const result = await models.complete(role, {
  system: "You answer with JSON only.",
  messages: [{ role: "user", content: "Name one primary colour and how sure you are (0-1)." }],
  output: z.object({ colour: z.string(), confidence: z.number() }),
  maxOutputTokens: 100,
});
console.log(
  JSON.stringify(
    result.ok
      ? {
          ok: true,
          provider: result.provider,
          model: result.model,
          object: result.object,
          usage: result.usage,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
        }
      : {
          ok: false,
          reason: result.reason,
          message: result.message,
          fix: result.fix,
          attempts: result.attempts,
        },
    null,
    2,
  ),
);
process.exitCode = result.ok ? 0 : 1;
