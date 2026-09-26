import { ModelCallSchema } from "@testament/contract";
import { describe, expect, it } from "vitest";
import { createModels } from "./client.js";
import { toModelCall } from "./contract.js";
import { fails, keySources, scripted, testConfig, text } from "./test-kit.test-support.js";
import type { ModelCallRecord } from "./types.js";

function setup(models: Record<string, ReturnType<typeof scripted>>) {
  const records: ModelCallRecord[] = [];
  const client = createModels({
    config: testConfig(),
    sources: keySources(),
    backoffMs: 0,
    onCall: (record) => records.push(record),
    languageModel: (entry) => {
      const found = models[entry.provider];
      if (!found) throw new Error(`no mock for ${entry.provider}`);
      return found.model;
    },
  });
  return { client, records };
}

const ask = { messages: [{ role: "user" as const, content: "hello" }] };

describe("toModelCall", () => {
  it("produces a valid contract ModelCall for a successful call", async () => {
    const { client, records } = setup({ a: scripted(text("hi")) });
    await client.complete("planner", ask);
    const call = toModelCall(records[0] as ModelCallRecord);
    expect(ModelCallSchema.parse(call)).toEqual(call);
    expect(call).toMatchObject({ role: "planner", provider: "a", outcome: "ok", attempts: 1 });
    expect(call.tokens).toEqual({ input: 100, output: 20, cached: 0, cacheWrite: 0 });
  });

  it("produces a valid contract ModelCall for a failed call", async () => {
    const { client, records } = setup({ a: scripted(fails(401)), b: scripted(fails(401)) });
    await client.complete("planner", ask);
    const call = toModelCall(records[0] as ModelCallRecord);
    expect(ModelCallSchema.parse(call)).toEqual(call);
    expect(call.outcome).not.toBe("ok");
    expect(call.attempts).toBeGreaterThan(0);
  });
});
