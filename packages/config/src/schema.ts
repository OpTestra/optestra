import { z } from "zod";

/** Secret names: UPPER_SNAKE_CASE, e.g. TEST_PASSWORD. */
export const SECRET_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

export const domainSchema = z
  .string()
  .regex(
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::(?:6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|[1-9]\d{0,3}))?$/i,
    "expected a host name like example.com, *.example.com or 10.0.2.2:4180 (a port limits it to that port)",
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
    evidence: z
      .enum(["full", "failures", "minimal"])
      .optional()
      .describe(
        "full: trace, network log and a screenshot per step for every test. failures: the same is recorded, but a clean pass keeps only its screenshots, video and console. minimal: no trace or network log, screenshots only where a step failed (a retry records full evidence). Default: full in CI, failures elsewhere.",
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

const secretRef = z
  .string()
  .regex(SECRET_NAME, "expected the NAME of a declared secret, like PREVIEW_TOKEN");

/** HTTP header names a test may add; never ones the browser owns. */
const RESERVED_HEADERS = /^(host|cookie|content-length|transfer-encoding|connection|upgrade)$/i;
export const headerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "expected an HTTP header name like X-Preview-Token")
  .refine((name) => !RESERVED_HEADERS.test(name), "this header is set by the browser itself");

/**
 * Protected previews (SEC-8): extra request headers whose values are secrets.
 * Each header goes only to hosts that are both allowed (allowedDomains) and in
 * its secret's `domains`; never anywhere else.
 */
export const protectionSchema = z
  .strictObject({
    vercelBypass: secretRef
      .optional()
      .describe(
        "Vercel Deployment Protection: the secret holding the Protection Bypass for Automation token (sent as x-vercel-protection-bypass).",
      ),
    cloudflareAccess: z
      .strictObject({
        clientId: secretRef.describe("Secret with the service token's Client ID."),
        clientSecret: secretRef.describe("Secret with the service token's Client Secret."),
      })
      .optional()
      .describe("Cloudflare Access service token (CF-Access-Client-Id / CF-Access-Client-Secret)."),
    basicAuth: z
      .strictObject({
        username: secretRef.describe("Secret with the user name."),
        password: secretRef.describe("Secret with the password."),
      })
      .optional()
      .describe("HTTP basic auth (Authorization: Basic …), unless a request sets its own."),
    headers: z
      .record(headerNameSchema, secretRef)
      .optional()
      .describe("Any other headers: header name → the secret holding its value."),
  })
  .describe(
    "Protected preview environments: headers sent only to allowed hosts in each secret's domains.",
  );

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
  protection: protectionSchema.optional(),
};

export const defaultEnvironmentSchema = z
  .string()
  .min(1)
  .describe("Environment used when none is chosen.");

export type ProjectSettings = z.infer<typeof projectSchema>;
export type SecretDeclaration = z.infer<typeof secretDeclarationSchema>;
export type RunSettings = z.infer<typeof runSchema>;
export type ProtectionSettings = z.infer<typeof protectionSchema>;

export interface EnvironmentSettings {
  baseUrl?: string;
  app?: string;
  /** Always set after resolution (defaults to the host of baseUrl). */
  allowedDomains: string[];
  production: boolean;
  vars: Record<string, string>;
  /** Protected previews (SEC-8): secret headers for the allowed hosts. */
  protection?: ProtectionSettings;
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

/** A protected-preview header (SEC-8) with its value still a secret reference. */
export type ProtectedHeaderSpec =
  | { name: string; secret: string }
  | { name: "Authorization"; basic: { username: string; password: string } };

/** The headers an environment's `protection` asks for, values as secret names. */
export function protectedHeaderSpecs(
  protection: ProtectionSettings | undefined,
): ProtectedHeaderSpec[] {
  if (!protection) return [];
  const specs: ProtectedHeaderSpec[] = [];
  if (protection.vercelBypass)
    specs.push({ name: "x-vercel-protection-bypass", secret: protection.vercelBypass });
  if (protection.cloudflareAccess)
    specs.push(
      { name: "CF-Access-Client-Id", secret: protection.cloudflareAccess.clientId },
      { name: "CF-Access-Client-Secret", secret: protection.cloudflareAccess.clientSecret },
    );
  if (protection.basicAuth) specs.push({ name: "Authorization", basic: protection.basicAuth });
  for (const [name, secret] of Object.entries(protection.headers ?? {}))
    specs.push({ name, secret });
  return specs;
}

/** Every secret name a (possibly not yet validated) `protection` block refers to. */
export function protectionSecretNames(protection: unknown): string[] {
  const names: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") names.push(value);
    else if (value && typeof value === "object") for (const v of Object.values(value)) visit(v);
  };
  visit(protection);
  return [...new Set(names.filter((name) => SECRET_NAME.test(name)))];
}
