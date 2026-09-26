import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BUILT_IN_DEFAULTS } from "./defaults.generated.js";
import type { DiagnosticCode } from "./diagnostics.js";
import { ENV_PREFIX } from "./env-vars.js";
import { configJsonSchema } from "./json-schema.js";
import { createConfigRegistry } from "./registry.js";
import { resolveConfig } from "./resolve.js";

const base = () => ({
  version: 1,
  project: { name: "Shop", target: "web" },
  defaultEnvironment: "local",
  environments: {
    local: { baseUrl: "http://localhost:3000" },
    staging: { baseUrl: "https://staging.shop.test", run: { retries: 3 } },
  },
  secrets: { TEST_PASSWORD: { domains: ["localhost"] } },
});

const codes = (project: unknown, options: Parameters<typeof resolveConfig>[0] = {}) =>
  resolveConfig({ project, ...options }).diagnostics.map((d) => d.code);

describe("resolveConfig", () => {
  it("resolves a valid project with defaults and no diagnostics", () => {
    const result = resolveConfig({ project: base() });
    expect(result.diagnostics).toEqual([]);
    expect(result.config.run).toEqual(BUILT_IN_DEFAULTS.run);
    expect(result.environment?.name).toBe("local");
    expect(result.config.environments.local?.allowedDomains).toEqual(["localhost"]);
    expect(result.provenance["environments.local.allowedDomains"]).toEqual({
      source: "default",
      note: "host of baseUrl",
    });
  });

  it("merges in order: defaults < project < environment < env var < run option", () => {
    const project = { ...base(), run: { retries: 2, mode: "replay-only", timeoutSeconds: 60 } };
    const result = resolveConfig({
      project,
      environment: "staging",
      env: { [`${ENV_PREFIX}RUN_MODE`]: "rerecord", [`${ENV_PREFIX}RUN_TIMEOUT_SECONDS`]: "90" },
      runOptions: { run: { timeoutSeconds: 120 } },
    });
    expect(result.config.run).toMatchObject({
      retries: 3,
      mode: "rerecord",
      timeoutSeconds: 120,
      healPolicy: "review",
    });
    expect(result.provenance["run.healPolicy"]?.source).toBe("default");
    expect(result.provenance["run.retries"]).toMatchObject({
      source: "environment",
      environment: "staging",
    });
    expect(result.provenance["run.mode"]).toEqual({
      source: "envVar",
      envVar: `${ENV_PREFIX}RUN_MODE`,
    });
    expect(result.provenance["run.timeoutSeconds"]).toEqual({ source: "runOption" });
    expect(result.environment?.selectedBy).toEqual({ source: "runOption" });
  });

  it("selects the environment from the env var and overrides its base URL", () => {
    const result = resolveConfig({
      project: base(),
      env: {
        [`${ENV_PREFIX}ENVIRONMENT`]: "staging",
        [`${ENV_PREFIX}BASE_URL`]: "https://pr-42.shop.test",
      },
    });
    expect(result.environment?.name).toBe("staging");
    expect(result.environment?.settings.baseUrl).toBe("https://pr-42.shop.test");
    expect(result.environment?.settings.allowedDomains).toEqual(["pr-42.shop.test"]);
  });

  it("never throws on garbage input", () => {
    for (const project of [null, 42, "text", [], { version: "x", project: 5, environments: [] }]) {
      expect(() => resolveConfig({ project })).not.toThrow();
    }
  });

  const cases: [DiagnosticCode, unknown, Parameters<typeof resolveConfig>[0]?][] = [
    ["CONFIG_NOT_OBJECT", "just text"],
    ["VERSION_MISSING", { ...base(), version: undefined }],
    ["VERSION_UNSUPPORTED", { ...base(), version: 2 }],
    ["UNKNOWN_KEY", { ...base(), extra: true }],
    ["UNKNOWN_KEY", { ...base(), run: { retrys: 2 } }],
    ["REQUIRED_MISSING", { ...base(), project: { target: "web" } }],
    ["INVALID_VALUE", { ...base(), run: { retries: "lots" } }],
    ["ENV_NONE_DEFINED", { ...base(), environments: {}, defaultEnvironment: undefined }],
    ["ENV_NOT_SELECTED", { ...base(), defaultEnvironment: undefined }],
    ["ENV_NOT_FOUND", base(), { environment: "qa" }],
    ["ENV_DEFAULT_UNKNOWN", { ...base(), defaultEnvironment: "qa" }],
    ["ENV_BASE_URL_MISSING", { ...base(), environments: { local: {} } }],
    ["ENV_APP_MISSING", { ...base(), project: { name: "App", target: "android" } }],
    ["SECRET_NAME_INVALID", { ...base(), secrets: { testPassword: { domains: ["localhost"] } } }],
    ["SECRET_NO_DOMAINS", { ...base(), secrets: { TEST_PASSWORD: { domains: [] } } }],
    ["SECRET_NO_DOMAINS", { ...base(), secrets: { TEST_PASSWORD: { description: "x" } } }],
    [
      "SECRET_UNDECLARED",
      {
        ...base(),
        environments: {
          local: { baseUrl: "http://localhost", secrets: { OTHER: { domains: ["x.test"] } } },
        },
      },
    ],
    ["ENV_VAR_INVALID", base(), { env: { [`${ENV_PREFIX}RUN_RETRIES`]: "many" } }],
    ["ENV_VAR_UNKNOWN", base(), { env: { [`${ENV_PREFIX}RUN_RETRYS`]: "2" } }],
    ["RUN_OPTION_INVALID", base(), { runOptions: "fast" }],
  ];

  it.each(cases)("reports %s", (code, project, options) => {
    const result = resolveConfig({ project, ...options });
    const diagnostic = result.diagnostics.find((d) => d.code === code);
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.fix.length).toBeGreaterThan(10);
  });

  it("falls back to the default for an invalid value and says where it was set", () => {
    const result = resolveConfig({
      project: { ...base(), run: { retries: -1 } },
      projectFile: "/p/app.config.yaml",
      lineOf: (path) => (path.join(".") === "run.retries" ? 14 : undefined),
    });
    expect(result.config.run.retries).toBe(1);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "INVALID_VALUE",
        path: "run.retries",
        file: "/p/app.config.yaml",
        line: 14,
      }),
    );
  });

  it("does not warn about env vars that are declared secret names", () => {
    const project = { ...base(), secrets: { [`${ENV_PREFIX}TOKEN`]: { domains: ["localhost"] } } };
    expect(codes(project, { env: { [`${ENV_PREFIX}TOKEN`]: "x" } })).not.toContain(
      "ENV_VAR_UNKNOWN",
    );
  });

  it("applies per-environment secret domain overrides", () => {
    const project = base();
    project.environments.staging = {
      ...project.environments.staging,
      secrets: { TEST_PASSWORD: { domains: ["auth.shop.test"] } },
    } as typeof project.environments.staging;
    const result = resolveConfig({ project, environment: "staging" });
    expect(result.config.secrets.TEST_PASSWORD?.domains).toEqual(["auth.shop.test"]);
  });
});

describe("registering a section", () => {
  const registry = createConfigRegistry().register({
    key: "demo",
    schema: z.strictObject({ level: z.number().int(), label: z.string() }),
    defaults: { level: 3, label: "demo" },
    environmentOverride: true,
  });

  it("adds schema, defaults, env vars and environment overrides with no loader change", () => {
    const project = {
      ...base(),
      demo: { label: "custom" },
      environments: { local: { baseUrl: "http://localhost:3000", demo: { level: 7 } } },
    };
    const result = resolveConfig({
      project,
      registry,
      env: { [`${ENV_PREFIX}DEMO_LABEL`]: "from-env" },
    });
    expect(result.diagnostics).toEqual([]);
    expect((result.config as unknown as { demo: unknown }).demo).toEqual({
      level: 7,
      label: "from-env",
    });
    expect(registry.defaults().demo).toEqual({ level: 3, label: "demo" });
  });

  it("appears in the JSON Schema, optional where it has defaults", () => {
    const schema = configJsonSchema(registry) as {
      properties: Record<string, { properties?: object; required?: string[] }>;
    };
    expect(schema.properties.demo?.properties).toHaveProperty("level");
    expect(schema.properties.demo?.required).toBeUndefined();
  });

  it("is unknown to registries that did not register it", () => {
    expect(codes({ ...base(), demo: {} })).toContain("UNKNOWN_KEY");
  });
});
