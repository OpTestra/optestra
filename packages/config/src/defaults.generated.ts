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
      ],
    },
    prices: {},
    timeoutSeconds: 120,
  },
  decisions: {
    backend: "none",
    threshold: 0.8,
    tasks: {},
    cache: {
      enabled: true,
      ttlSeconds: 604800,
    },
  },
};
