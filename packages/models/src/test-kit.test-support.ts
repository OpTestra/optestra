import { type Config, resolveConfig } from "@testament/config";
import { createLogger, memorySource } from "@testament/config/node";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import "./config.js";

export const KEYS = { A_KEY: "key-a-7c1e9f3b", B_KEY: "key-b-2d8a6e4c" };

export function usage(input = 100, output = 20) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

type Step = (options: { prompt: unknown }) => unknown;

export const text =
  (value: string, u = usage()) =>
  () => ({
    content: [{ type: "text", text: value }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: u,
    warnings: [],
  });

export const fails =
  (status: number, body = "") =>
  () => {
    throw new APICallError({
      message: `HTTP ${status}`,
      url: "https://provider.test",
      requestBodyValues: {},
      statusCode: status,
      responseBody: body,
      isRetryable: status === 429 || status >= 500,
    });
  };

export const hangs = () => () => new Promise(() => {});

/** A mock model that plays `steps` in order (the last one repeats) and counts calls. */
export function scripted(...steps: Step[]) {
  const calls: { prompt: unknown }[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options as { prompt: unknown });
      const step = steps[Math.min(calls.length - 1, steps.length - 1)] as Step;
      return step(options as { prompt: unknown }) as never;
    },
  });
  return { model, calls };
}

export function testConfig(
  models: Record<string, unknown> = {},
  run?: Record<string, unknown>,
): Config {
  const result = resolveConfig({
    project: {
      version: 1,
      project: { name: "T", target: "web" },
      environments: { local: { baseUrl: "http://localhost:3000" } },
      ...(run && { run }),
      models: {
        providers: {
          a: { kind: "openai-compatible", baseUrl: "https://a.test/v1", keySecret: "A_KEY" },
          b: { kind: "openai-compatible", baseUrl: "https://b.test/v1", keySecret: "B_KEY" },
        },
        roles: {
          planner: [
            { provider: "a", model: "claude-sonnet-5" },
            { provider: "b", model: "gpt-6-sol" },
          ],
          fixer: [{ provider: "b", model: "mystery-model" }],
        },
        ...models,
      },
    },
    env: {},
  });
  if (result.diagnostics.length) throw new Error(JSON.stringify(result.diagnostics));
  return result.config;
}

export const keySources = (keys: Record<string, string> = KEYS) => [memorySource(keys)];

export function captureLogs() {
  const lines: string[] = [];
  return { lines, logger: createLogger({ level: "debug", sink: (line) => lines.push(line) }) };
}
