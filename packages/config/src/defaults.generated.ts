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
};
