import { resolveConfig } from "@testament/config";
import { memorySource } from "@testament/config/node";
import { describe, expect, it } from "vitest";
import { resolvePools, resolveProviders } from "./keys.js";
import { testConfig } from "./test-kit.test-support.js";
import "./config.js";

const defaults = () =>
  resolveConfig({
    project: {
      version: 1,
      project: { name: "T", target: "web" },
      environments: { local: { baseUrl: "http://localhost" } },
    },
    env: {},
  }).config;

describe("pools", () => {
  it("resolves the default pools; only providers with a key are usable", () => {
    const config = defaults();
    const pools = resolvePools(
      config,
      resolveProviders(config, [memorySource({ ANTHROPIC_API_KEY: "sk-ant-test-1" })]),
    );
    expect(pools.planner.map((e) => [e.provider, e.model, e.usable])).toEqual([
      ["anthropic", "claude-sonnet-5", true],
      ["openai", "gpt-6-sol", false],
      ["google", "gemini-3.8-flash", false],
    ]);
    expect(pools.fixer.map((e) => [e.provider, e.model, e.usable])).toEqual([
      ["anthropic", "claude-haiku-4-5", true],
      ["openai", "gpt-6-luna", false],
      ["google", "gemini-3.5-flash-lite", false],
    ]);
  });

  it("declares keySecret implicitly for the provider host, and honours declared domains", () => {
    const implicit = resolveProviders(defaults(), [
      memorySource({ ANTHROPIC_API_KEY: "sk-ant-test-2" }),
    ]);
    expect(implicit.get("anthropic")).toMatchObject({
      keyStatus: "set",
      host: "api.anthropic.com",
    });

    const declared = resolveConfig({
      project: {
        version: 1,
        project: { name: "T", target: "web" },
        environments: { local: { baseUrl: "http://localhost" } },
        secrets: { ANTHROPIC_API_KEY: { domains: ["proxy.internal.test"] } },
      },
      env: {},
    }).config;
    const refused = resolveProviders(declared, [
      memorySource({ ANTHROPIC_API_KEY: "sk-ant-test-3" }),
    ]).get("anthropic");
    expect(refused).toMatchObject({ keyStatus: "not_allowed", key: undefined });
    expect(refused?.problem).toContain("may not be sent to api.anthropic.com");
  });

  it("flags unknown providers and allows keyless local servers", () => {
    const config = testConfig({
      providers: { ollama: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" } },
      roles: {
        planner: [{ provider: "ollama", model: "qwen3" }],
        fixer: [{ provider: "nope", model: "x" }],
      },
    });
    const pools = resolvePools(config, resolveProviders(config, []));
    expect(pools.planner[0]).toMatchObject({ usable: true, keyStatus: "not_needed" });
    expect(pools.fixer[0]).toMatchObject({ usable: false, keyStatus: "unknown_provider" });
  });
});
