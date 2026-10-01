import {
  asDynamicSecret,
  createSecretValue,
  type Redactor,
  type SecretValue,
} from "@optestra/config/node";
import { extractCode, extractLinks, pickLink } from "./extract.js";
import { INBOX_MEMBERS, type InboxMember } from "@optestra/spec";
import type { Inbox, InboxFailureReason, InboxMessage, InboxResult } from "./types.js";

// Run-time values for the `inbox` template namespace: {{inbox.code}}, {{inbox.link}},
// {{inbox.subject}}. The spec binds them as `unresolved`; the agent / replayer
// (AUTH-1) asks this provider when a step needs one. Codes and links come back as
// SecretValues: the browser types them like secrets, the AI never sees them, and a
// recording keeps the template, never the one-time value.

// The member list is the spec's, so the template namespace and this provider can't drift.
export { INBOX_MEMBERS, type InboxMember } from "@optestra/spec";

/** Secret names the values are typed under (labels `[secret:INBOX_CODE]`, …). */
export const INBOX_SECRET_NAMES = { code: "INBOX_CODE", link: "INBOX_LINK" } as const;

export interface InboxLookup {
  /** The address the app sent to (e.g. the test's {{data.email}}). */
  to: string;
  /** When the step that triggers the email started. */
  since: Date;
  subjectContains?: string;
  /** Default: the provider's `timeoutMs`. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type InboxValueFailureReason =
  | InboxFailureReason
  | "no_code"
  | "no_link"
  | "link_not_allowed"
  | "unknown_member";

interface Found {
  ok: true;
  subject: string;
  receivedAt: string;
}

export type InboxValue =
  | (Found & { member: "code" | "link"; value: SecretValue })
  | (Found & { member: "subject"; value: string })
  | { ok: false; reason: InboxValueFailureReason; message: string; fix?: string };

export interface InboxValuesOptions {
  inbox: Inbox;
  /** The environment's allowedDomains: a link elsewhere is never returned. */
  allowedDomains: readonly string[];
  /** How long to wait for the email (config `inbox.timeoutSeconds` × 1000). */
  timeoutMs: number;
  /** Codes and links are registered here (default: the config's defaultRedactor). */
  redactor?: Redactor;
}

export interface InboxValues {
  get(member: string, lookup: InboxLookup): Promise<InboxValue>;
  /** Forget the cached message(s), so the next `get` waits for a new email. */
  forget(to?: string): void;
}

type RawValue =
  | { ok: true; member: InboxMember; value: string; subject: string; receivedAt: string }
  | Extract<InboxValue, { ok: false }>;

// The plain values behind an InboxValues' secrets, for `inboxSecret` only (never exported).
const rawGetters = new WeakMap<
  InboxValues,
  (member: string, lookup: InboxLookup) => Promise<RawValue>
>();

export function createInboxValues(options: InboxValuesOptions): InboxValues {
  // One message per lookup, so {{inbox.code}} and {{inbox.link}} come from the same email.
  const cache = new Map<string, Promise<InboxResult<{ message: InboxMessage }>>>();
  const cacheKey = (l: InboxLookup) =>
    `${l.to.toLowerCase()}|${l.since.toISOString()}|${l.subjectContains ?? ""}`;
  const origin = `inbox (${options.inbox.provider})`;
  const secret = (name: string, value: string) =>
    createSecretValue(name, value, {
      domains: options.allowedDomains,
      origin,
      ...(options.redactor && { redactor: options.redactor }),
    });

  async function raw(member: string, lookup: InboxLookup): Promise<RawValue> {
    if (!(INBOX_MEMBERS as readonly string[]).includes(member)) {
      return {
        ok: false,
        reason: "unknown_member",
        message: `{{inbox.${member}}} is not an inbox value.`,
        fix: `Use {{inbox.code}}, {{inbox.link}} or {{inbox.subject}}.`,
      };
    }
    const key = cacheKey(lookup);
    let pending = cache.get(key);
    if (!pending) {
      pending = options.inbox.waitForMessage({
        to: lookup.to,
        since: lookup.since,
        timeoutMs: lookup.timeoutMs ?? options.timeoutMs,
        ...(lookup.subjectContains && { subjectContains: lookup.subjectContains }),
        ...(lookup.signal && { signal: lookup.signal }),
      });
      cache.set(key, pending);
    }
    const result = await pending;
    if (!result.ok) {
      cache.delete(key); // a miss is retried on the next get
      return result;
    }
    const { message } = result;
    const found = { ok: true as const, subject: message.subject, receivedAt: message.receivedAt };
    if (member === "subject") return { ...found, member: "subject", value: message.subject };
    if (member === "code") {
      const code = extractCode(message);
      if (!code) {
        return {
          ok: false,
          reason: "no_code",
          message: `The email "${message.subject}" to ${lookup.to} has no code that could be read.`,
          fix: "Check the email's wording, or use {{inbox.link}} if it contains a link instead.",
        };
      }
      return { ...found, member: "code", value: code };
    }
    const links = extractLinks(message, options.allowedDomains);
    const link = pickLink(links);
    if (!link) {
      const refused = links.refused[0];
      return refused
        ? {
            ok: false,
            reason: "link_not_allowed",
            message: `The email "${message.subject}" links to ${refused.host}, which is not in the environment's allowed domains; it was not followed.`,
            fix: `Add ${refused.host.replace(/:\d+$/, "")} to the environment's allowedDomains if the test may go there.`,
          }
        : {
            ok: false,
            reason: "no_link",
            message: `The email "${message.subject}" to ${lookup.to} has no link to follow.`,
          };
    }
    return { ...found, member: "link", value: link.url };
  }

  const values: InboxValues = {
    async get(member, lookup) {
      const result = await raw(member, lookup);
      if (!result.ok || result.member === "subject") return result as InboxValue;
      const name = INBOX_SECRET_NAMES[result.member];
      return { ...result, member: result.member, value: secret(name, result.value) };
    },
    forget(to) {
      if (to === undefined) cache.clear();
      else
        for (const key of cache.keys())
          if (key.startsWith(`${to.toLowerCase()}|`)) cache.delete(key);
    },
  };
  rawGetters.set(values, raw);
  return values;
}

/** Thrown by an `inboxSecret` producer when the inbox has no value; carries the typed miss. */
export class InboxValueError extends Error {
  constructor(readonly failure: Extract<InboxValue, { ok: false }>) {
    super(failure.message);
    this.name = "InboxValueError";
  }
}

/**
 * {{inbox.code}} / {{inbox.link}} as a secret a browser session can be opened with
 * before the email exists: its value is read from the inbox at the moment of typing
 * (the browser's `prepareSecret`), for the lookup `lookup()` returns then. A miss
 * makes the fill fail with the typed reason's message (InboxValueError).
 */
export function inboxSecret(
  values: InboxValues,
  member: "code" | "link",
  lookup: () => InboxLookup,
  options: { allowedDomains: readonly string[]; redactor?: Redactor },
): SecretValue {
  const name = INBOX_SECRET_NAMES[member];
  const placeholder = createSecretValue(name, "", {
    domains: options.allowedDomains,
    origin: "inbox",
    ...(options.redactor && { redactor: options.redactor }),
  });
  return asDynamicSecret(
    placeholder,
    "inbox",
    async () => {
      const raw = rawGetters.get(values);
      if (!raw) throw new Error("inboxSecret needs values from createInboxValues");
      const value = await raw(member, lookup());
      if (!value.ok) throw new InboxValueError(value);
      return value.value;
    },
    ...(options.redactor ? [options.redactor] : []),
  );
}
