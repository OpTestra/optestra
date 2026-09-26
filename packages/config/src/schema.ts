import { z } from "zod";

/** Secret names: UPPER_SNAKE_CASE, e.g. TEST_PASSWORD. */
export const SECRET_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

export const domainSchema = z
  .string()
  .regex(
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i,
    "expected a host name like example.com or *.example.com",
  );

export const httpUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}, "expected an http:// or https:// URL");

export const projectSchema = z
  .strictObject({
    name: z.string().min(1).describe("Project name shown in the apps."),
    target: z.enum(["web", "android"]).describe("What this project tests: web or android."),
  })
  .describe("The project.");

export const secretDeclarationSchema = z.strictObject({
  domains: z
    .array(domainSchema)
    .describe("Domains this secret may be typed into. Typing it anywhere else is refused."),
  description: z.string().optional().describe("What the secret is for."),
  type: z
    .enum(["text", "totp"])
    .optional()
    .describe(
      "text (default): typed as it is. totp: the value is a TOTP seed (base32 or an otpauth:// URI); typing it types the current one-time code.",
    ),
});

export const secretsSchema = z
  .record(z.string().min(1), secretDeclarationSchema)
  .describe("Secrets the tests may use, by NAME. Values never live in this file.");

export const runSchema = z
  .strictObject({
    timeoutSeconds: z.number().int().positive().describe("Maximum time for one test, in seconds."),
    retries: z
      .number()
      .int()
      .min(0)
      .max(10)
      .describe("Extra attempts after a failure before the test is reported as failed."),
    healPolicy: z
      .enum(["strict", "review", "auto"])
      .describe("strict: never heal; review: propose fixes for approval; auto: apply and flag."),
    mode: z
      .enum(["replay-only", "normal", "rerecord"])
      .describe(
        "replay-only: never call AI; normal: AI only when a step breaks; rerecord: record again.",
      ),
    budget: z
      .strictObject({
        maxPerRunUsd: z.number().nonnegative().describe("AI spend cap for one test run, in USD."),
        maxPerSuiteUsd: z
          .number()
          .nonnegative()
          .describe("AI spend cap for one suite run, in USD."),
      })
      .describe("AI budget caps."),
  })
  .describe("How tests run.");

/** Fields every environment has. Section overrides (run, secrets, ...) are added per registry. */
export const environmentBaseShape = {
  baseUrl: httpUrlSchema.optional().describe("Web: the site's base URL."),
  app: z.string().min(1).optional().describe("Android: path to the APK or an upload reference."),
  allowedDomains: z
    .array(domainSchema)
    .optional()
    .describe("Domains tests may visit. Default: the host of baseUrl."),
  production: z
    .boolean()
    .describe("Production mode: destructive actions are blocked unless a test declares them."),
  vars: z.record(z.string(), z.string()).describe("Plain values tests can use, by name."),
};

export const defaultEnvironmentSchema = z
  .string()
  .min(1)
  .describe("Environment used when none is chosen.");

export type ProjectSettings = z.infer<typeof projectSchema>;
export type SecretDeclaration = z.infer<typeof secretDeclarationSchema>;
export type RunSettings = z.infer<typeof runSchema>;

export interface EnvironmentSettings {
  baseUrl?: string;
  app?: string;
  /** Always set after resolution (defaults to the host of baseUrl). */
  allowedDomains: string[];
  production: boolean;
  vars: Record<string, string>;
  /** Overrides of the top-level `run` section for this environment. */
  run?: Partial<RunSettings>;
  /** Overrides of declared secrets (e.g. other domains) for this environment. */
  secrets?: Record<string, SecretDeclaration>;
}

/**
 * Top-level sections. Phases that register a section extend this interface:
 * `declare module "@testament/config" { interface ConfigSections { models: ModelSettings } }`
 */
export interface ConfigSections {
  project: ProjectSettings;
  defaultEnvironment?: string;
  environments: Record<string, EnvironmentSettings>;
  secrets: Record<string, SecretDeclaration>;
  run: RunSettings;
}

export const CONFIG_VERSION = 1;

export type Config = { version: typeof CONFIG_VERSION } & ConfigSections;

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> | null }
    : T;

/** Values the caller (CLI flags, app) passes in; the highest-precedence layer. */
export type RunOptions = DeepPartial<ConfigSections>;

/** A change to the project file. `null` removes a key. */
export type ConfigPatch = DeepPartial<ConfigSections>;
