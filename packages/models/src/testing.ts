import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { PoolEntry } from "./keys.js";

// Test support for engines that call models: a scripted model that replays
// pre-written replies (text and tool calls) through the real client, so budgets,
// records and failover behave exactly as in production. No network, no AI.
// Pass the result's `languageModel` to `createModels`.

export interface ScriptedReply {
  text?: string;
  toolCalls?: Array<{ name: string; input: unknown }>;
  /** Default 100 input / 20 output tokens. */
  usage?: { input: number; output: number };
}

/** What the model was asked, for assertions (system prompt, messages, tool names). */
export interface ScriptedCall {
  prompt: unknown;
  tools: string[];
}

export type ScriptStep = ScriptedReply | ((call: ScriptedCall, index: number) => ScriptedReply);

export interface ScriptedModel {
  /** Pass as `createModels({ languageModel })`. */
  languageModel: (entry: PoolEntry, apiKey: string | undefined) => LanguageModel;
  /** Every call made so far. */
  calls: ScriptedCall[];
}

/** Plays `steps` in order; after the last one, keeps repeating it. */
export function scriptedModel(...steps: ScriptStep[]): ScriptedModel {
  const calls: ScriptedCall[] = [];
  let ids = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const call: ScriptedCall = {
        prompt: options.prompt,
        tools: (options.tools ?? []).map((tool) => tool.name),
      };
      calls.push(call);
      const index = calls.length - 1;
      const step = steps[Math.min(index, steps.length - 1)];
      if (!step) throw new Error("scriptedModel: no steps");
      const reply = typeof step === "function" ? step(call, index) : step;
      const content = [
        ...(reply.text ? [{ type: "text" as const, text: reply.text }] : []),
        ...(reply.toolCalls ?? []).map((tool) => ({
          type: "tool-call" as const,
          toolCallId: `call-${++ids}`,
          toolName: tool.name,
          input: JSON.stringify(tool.input ?? {}),
        })),
      ];
      const input = reply.usage?.input ?? 100;
      const output = reply.usage?.output ?? 20;
      return {
        content,
        finishReason: reply.toolCalls?.length
          ? { unified: "tool-calls", raw: "tool_calls" }
          : { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: output, text: output, reasoning: 0 },
        },
        warnings: [],
      } as never;
    },
  });
  return { languageModel: () => model, calls };
}
