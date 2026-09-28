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
  android: {
    version: "16",
    device: "pixel-8",
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
          model: "claude-sonnet-4-6",
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
          model: "claude-sonnet-4-6",
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
          model: "claude-haiku-4-5",
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
    delegatedCallsPerRun: 60,
  },
  decisions: {
    backend: "auto",
    during: "auto",
    after: "auto",
    skipAfterTimeouts: 3,
    jev: {
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      keySecret: "JEV_API_KEY",
      priceUsdPerMillionInputTokens: 0.042,
      expectedLatencyMs: 400,
    },
    kev: {
      baseUrl: "http://127.0.0.1:8009",
      model: "kev-latest",
      priceUsdPerMillionInputTokens: 0,
      expectedLatencyMs: 500,
    },
    laya: {
      baseUrl: "http://127.0.0.1:11435",
      model: "laya:typed-decisions",
      priceUsdPerMillionInputTokens: 0,
      expectedLatencyMs: 90,
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
  auth: {
    profiles: {
      "*": {
        params: {},
        reuse: "per-worker",
        ttlMinutes: 60,
      },
    },
    totp: {
      minRemainingSeconds: 5,
    },
  },
  inbox: {
    provider: "none",
    timeoutSeconds: 60,
    mailpit: {
      url: "http://127.0.0.1:8025",
      domain: "example.test",
    },
    mailosaur: {
      baseUrl: "https://mailosaur.com",
      keySecret: "MAILOSAUR_API_KEY",
    },
    mailslurp: {
      baseUrl: "https://api.mailslurp.com",
      keySecret: "MAILSLURP_API_KEY",
    },
  },
};
