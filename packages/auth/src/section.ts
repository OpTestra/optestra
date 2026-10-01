import { defaultRegistry, SECRET_NAME } from "@optestra/config";
import { z } from "zod";

// The `auth` and `inbox` config sections (SEC-3, SEC-4, SEC-5). Defaults live in
// packages/config/defaults.yaml, like every other section's.

export const REUSE_MODES = ["per-worker", "shared"] as const;
export type ReuseMode = (typeof REUSE_MODES)[number];

export interface ProfileCheck {
  /** A path (or URL on an allowed host) that only a logged-in user can open. */
  url: string;
  /** Text that must be on that page (optional). */
  text?: string;
}

export interface AuthProfile {
  /** The flow that logs in, relative to `tests.dir`, e.g. `flows/login-admin.test.md`. */
  flow: string;
  /** Params for the flow; templates like `{{data.admin_email}}`. */
  params: Record<string, string>;
  /** How to tell a saved session still works. Without it a saved session is trusted until it expires. */
  check?: ProfileCheck;
  /** per-worker: one saved session per parallel worker; shared: one for all. */
  reuse: ReuseMode;
  /** A saved session is used for at most this many minutes. */
  ttlMinutes: number;
}

export interface AuthSettings {
  profiles: Record<string, AuthProfile>;
  totp: { minRemainingSeconds: number };
}

export const INBOX_PROVIDERS = ["none", "mailpit", "mailosaur", "mailslurp"] as const;
export type InboxProvider = (typeof INBOX_PROVIDERS)[number];

export interface InboxSettings {
  provider: InboxProvider;
  timeoutSeconds: number;
  mailpit: { url: string; domain: string };
  mailosaur: { baseUrl: string; serverId?: string; keySecret: string };
  mailslurp: { baseUrl: string; inboxId?: string; keySecret: string };
}

/** Profile names: what a test writes after `auth:`. `none` is reserved (start logged out). */
export const PROFILE_NAME = /^[a-z][a-z0-9_-]*$/i;

const origin = (example: string) =>
  z.string().refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/";
    } catch {
      return false;
    }
  }, `must be an http(s) URL with no path, e.g. ${example}`);

const secretName = z
  .string()
  .regex(SECRET_NAME, "must be an UPPER_SNAKE secret name")
  .describe("Secret holding the API key. Sent only to this provider's host.");

const profileSchema = z
  .strictObject({
    flow: z
      .string()
      .min(1)
      .regex(/\.test\.md$/, "must be a .test.md flow file")
      .describe("The flow that logs in, relative to tests.dir."),
    params: z.record(z.string(), z.string()).describe("Params passed to the flow."),
    check: z
      .strictObject({
        url: z.string().min(1).describe("A page only a logged-in user can open."),
        text: z.string().min(1).optional().describe("Text that must be on that page."),
      })
      .optional()
      .describe("How to tell a saved session still works."),
    reuse: z
      .enum(REUSE_MODES)
      .describe("per-worker: one saved session per parallel worker; shared: one for all."),
    ttlMinutes: z
      .number()
      .int()
      .positive()
      .describe("A saved session is used for at most this many minutes."),
  })
  .describe("A named login.");

export const authSchema = z
  .strictObject({
    profiles: z
      .record(
        z
          .string()
          .regex(PROFILE_NAME, "profile names are letters, digits, - and _")
          .refine((name) => name !== "none", "none is reserved: it means start logged out"),
        profileSchema,
      )
      .describe("Named logins a test picks with auth: <name>."),
    totp: z
      .strictObject({
        minRemainingSeconds: z
          .number()
          .int()
          .min(0)
          .max(25)
          .describe("Wait for the next code when the current one expires sooner than this."),
      })
      .describe("TOTP secrets (type: totp)."),
  })
  .describe("Login profiles and saved sessions.");

export const inboxSchema = z
  .strictObject({
    provider: z.enum(INBOX_PROVIDERS).describe("Where test emails arrive."),
    timeoutSeconds: z
      .number()
      .positive()
      .max(600)
      .describe("How long a test waits for an email, in seconds."),
    mailpit: z
      .strictObject({
        url: origin("http://127.0.0.1:8025").describe("Mailpit's web/API address."),
        domain: z.string().min(1).describe("Domain for generated addresses."),
      })
      .describe("Mailpit (local or CI)."),
    mailosaur: z
      .strictObject({
        baseUrl: origin("https://mailosaur.com"),
        serverId: z.string().min(1).optional().describe("Your Mailosaur server id."),
        keySecret: secretName,
      })
      .describe("Mailosaur (hosted)."),
    mailslurp: z
      .strictObject({
        baseUrl: origin("https://api.mailslurp.com"),
        inboxId: z.string().min(1).optional().describe("An existing inbox to reuse."),
        keySecret: secretName,
      })
      .describe("MailSlurp (hosted)."),
  })
  .describe("Test email inboxes.");

if (!defaultRegistry.has("auth")) defaultRegistry.register({ key: "auth", schema: authSchema });
if (!defaultRegistry.has("inbox")) defaultRegistry.register({ key: "inbox", schema: inboxSchema });

declare module "@optestra/config" {
  interface ConfigSections {
    auth: AuthSettings;
    inbox: InboxSettings;
  }
}
