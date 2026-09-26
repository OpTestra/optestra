// Generated from defaults.yaml by scripts/gen-defaults.ts. Do not edit.
export const BUILT_IN_DEFAULTS: Readonly<Record<string, unknown>> = {
  environments: {
    "*": {
      production: false,
      vars: {},
    },
  },
  secrets: {},
  run: {
    timeoutSeconds: 300,
    retries: 1,
    healPolicy: "review",
    mode: "normal",
    budget: {
      maxPerRunUsd: 1,
      maxPerSuiteUsd: 10,
    },
  },
  tests: {
    dir: "tests",
    include: ["**/*.test.md"],
  },
  lint: {
    rules: {},
    strict: false,
  },
  models: {
    providers: {
      anthropic: {
        kind: "anthropic",
        keySecret: "ANTHROPIC_API_KEY",
      },
      openai: {
        kind: "openai",
        keySecret: "OPENAI_API_KEY",
      },
      google: {
        kind: "google",
        keySecret: "GEMINI_API_KEY",
      },
      "claude-code": {
        kind: "claude-code",
      },
      codex: {
        kind: "codex",
      },
    },
    roles: {
      planner: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
        },
        {
          provider: "openai",
          model: "gpt-6-sol",
        },
        {
          provider: "google",
          model: "gemini-3.8-flash",
        },
        {
          provider: "claude-code",
          model: "sonnet",
        },
        {
          provider: "codex",
          model: "default",
        },
      ],
      fixer: [
        {
          provider: "anthropic",
          model: "claude-haiku-4-5",
        },
        {
          provider: "openai",
          model: "gpt-6-luna",
        },
        {
          provider: "google",
          model: "gemini-3.5-flash-lite",
        },
        {
          provider: "claude-code",
          model: "haiku",
        },
        {
          provider: "codex",
          model: "default",
        },
      ],
    },
    prices: {},
    timeoutSeconds: 120,
    allowDelegated: true,
    delegatedCallsPerRun: 300,
  },
  decisions: {
    backend: "auto",
    jev: {
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      keySecret: "JEV_API_KEY",
      priceUsdPerMillionInputTokens: 0.042,
    },
    kev: {
      baseUrl: "http://127.0.0.1:8009",
      model: "kev-latest",
      priceUsdPerMillionInputTokens: 0,
    },
    laya: {
      baseUrl: "http://127.0.0.1:11435",
      model: "laya:typed-decisions",
      priceUsdPerMillionInputTokens: 0,
      keepAlive: "30m",
      warmUpTimeoutMs: 15000,
    },
    threshold: 0.8,
    tasks: {},
    cache: {
      enabled: true,
      ttlSeconds: 604800,
    },
  },
};
