import {
  INBOX_SECRET_NAMES,
  type InboxLookup,
  type InboxMember,
  type InboxValues,
  inboxSecret,
} from "@optestra/auth";
import type { BlockedReason } from "@optestra/contract";
import type { Redactor, SecretValue } from "@optestra/config/node";
import type { BoundSegment, ExpandedStep, ExpandedTest } from "@optestra/spec";

// The test inbox in one attempt (SEC-5, AUTH-1). The agent's read_inbox tool and
// the replayer ask it for {{inbox.code}} / {{inbox.link}}; the value never leaves
// the harness: the session is opened with INBOX_CODE / INBOX_LINK secrets whose
// value is read from the same (cached) email at the moment of typing. The model
// and the recording only ever see the template.

export type { InboxMember };

/** The secret each inbox member is typed under (`[secret:INBOX_CODE]` in logs). */
export const INBOX_SECRETS: Record<"code" | "link", string> = INBOX_SECRET_NAMES;

export type InboxRead =
  | { ok: true; member: InboxMember; subject: string; receivedAt: string; to: string }
  | {
      ok: false;
      /** Blocked (our inbox, or config) or failed (the app's email is wrong). */
      outcome: "blocked" | "failed";
      reason: BlockedReason | "no_code" | "no_link";
      message: string;
    };

export interface TestInbox {
  /** Provider name, for messages. */
  readonly provider: string;
  /** INBOX_CODE and INBOX_LINK, for `openSession({ secrets })`. */
  readonly secrets: Readonly<Record<string, SecretValue>>;
  /**
   * The address this test's email goes to, as of `step`: the latest address the
   * test generated ({{unique.email}}, directly or through its data), else the
   * latest email address among its values. Same rule as the generated spec's
   * inbox helper, so both read the same email.
   */
  addressFor(test: ExpandedTest, step: ExpandedStep): string | null;
  /** Waits for the email to `to` and reads `member`. Codes and links stay in the harness. */
  read(member: InboxMember, to: string, signal?: AbortSignal): Promise<InboxRead>;
}

export interface TestInboxOptions {
  values: InboxValues;
  provider: string;
  /** The environment's allowedDomains (codes and links are typed / opened only there). */
  allowedDomains: readonly string[];
  /** When the attempt began: emails from then on count (addresses are fresh per attempt). */
  since: Date;
  redactor?: Redactor;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const generated = (segments: readonly BoundSegment[]) =>
  segments.filter(
    (s): s is Extract<BoundSegment, { kind: "value" }> =>
      s.kind === "value" && s.ref.startsWith("unique.email"),
  );
const emailValues = (segments: readonly BoundSegment[]) =>
  segments.filter(
    (s): s is Extract<BoundSegment, { kind: "value" }> =>
      s.kind === "value" && EMAIL.test(s.text.trim()),
  );

export function inboxAddressFor(test: ExpandedTest, step: ExpandedStep): string | null {
  const seen = (pick: (segments: readonly BoundSegment[]) => { text: string }[]) => {
    const found: string[] = [];
    for (const bound of Object.values(test.data))
      found.push(...pick(bound.segments).map((s) => s.text));
    for (const other of test.steps) {
      if (other.index > step.index) break;
      found.push(...pick(other.bound).map((s) => s.text));
    }
    return found.at(-1)?.trim() ?? null;
  };
  return seen(generated) ?? seen(emailValues);
}

export function createTestInbox(options: TestInboxOptions): TestInbox {
  let current: InboxLookup = { to: "", since: options.since };
  const lookup = () => current;
  const secret = (member: "code" | "link") =>
    inboxSecret(options.values, member, lookup, {
      allowedDomains: options.allowedDomains,
      ...(options.redactor && { redactor: options.redactor }),
    });
  return {
    provider: options.provider,
    secrets: { [INBOX_SECRETS.code]: secret("code"), [INBOX_SECRETS.link]: secret("link") },
    addressFor: inboxAddressFor,
    async read(member, to, signal) {
      current = { to, since: options.since, ...(signal && { signal }) };
      const value = await options.values.get(member, current);
      if (value.ok)
        return { ok: true, member, subject: value.subject, receivedAt: value.receivedAt, to };
      switch (value.reason) {
        case "no_code":
        case "no_link":
          // An email came, but without what the step needs: the app's email is wrong.
          return { ok: false, outcome: "failed", reason: value.reason, message: value.message };
        case "link_not_allowed":
          return {
            ok: false,
            outcome: "blocked",
            reason: "disallowed_domain",
            message: `${value.message}${value.fix ? ` ${value.fix}` : ""}`,
          };
        case "unknown_member":
          return { ok: false, outcome: "blocked", reason: "config_error", message: value.message };
        default:
          // timeout, unavailable, unauthorized, bad_response, not_configured, aborted: our inbox.
          return {
            ok: false,
            outcome: "blocked",
            reason: "inbox_unavailable",
            message: `${value.reason === "timeout" ? `No email to ${to} arrived in time` : `The test inbox (${options.provider}) couldn't be read`}: ${value.message}${value.fix ? ` ${value.fix}` : ""}`,
          };
      }
    },
  };
}

export type InboxPrepared =
  | { ok: true; to: string; subject: string }
  | Extract<InboxRead, { ok: false }>;

/**
 * Reads `member` for the test at `step` before it is typed or opened: from its
 * address (see `addressFor`), or `to` when the caller names one. A missing inbox
 * or address is blocked (we can't read, the app may be fine).
 */
export async function prepareInbox(
  inbox: TestInbox | undefined,
  test: ExpandedTest,
  step: ExpandedStep,
  member: InboxMember,
  options: { to?: string; signal?: AbortSignal } = {},
): Promise<InboxPrepared> {
  if (!inbox)
    return {
      ok: false,
      outcome: "blocked",
      reason: "inbox_unavailable",
      message:
        "This step reads an email, but no test inbox is configured (inbox.provider: none). Set one up in the project file's inbox section (Mailpit, Mailosaur or MailSlurp).",
    };
  const to = options.to ?? inbox.addressFor(test, step);
  if (!to)
    return {
      ok: false,
      outcome: "blocked",
      reason: "inbox_unavailable",
      message:
        'This step reads an email, but the test has no email address to read it for. Sign up with a generated address, e.g. data: { email: "{{unique.email}}" }.',
    };
  const read = await inbox.read(member, to, options.signal);
  return read.ok ? { ok: true, to, subject: read.subject } : read;
}

/** The inbox member a harness action types or opens, if any (`{ secret: INBOX_CODE }`). */
export function inboxMemberOfAction(action: {
  type: string;
  value?: unknown;
  url?: unknown;
}): "code" | "link" | null {
  const secret =
    action.type === "fill" && typeof action.value === "object" && action.value
      ? (action.value as { secret?: string }).secret
      : action.type === "goto" && typeof action.url === "object" && action.url
        ? (action.url as { secret?: string }).secret
        : undefined;
  if (secret === INBOX_SECRETS.code) return "code";
  if (secret === INBOX_SECRETS.link) return "link";
  return null;
}
