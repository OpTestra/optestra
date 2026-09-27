import type { RunningShop } from "./server.js";

// A test inbox over the shop's own outbox, read in process (no network): for the
// engine's e2e tests and the Bench when Mailpit isn't running. It has the shape of
// @testament/auth's Inbox (the Mailpit adapter's), so a run can't tell the
// difference; the fixture doesn't import the engine. `hold` never delivers, for
// the "no message in time" tests.

/** Messages this long before `since` still count (as in @testament/auth). */
const CLOCK_SKEW_MS = 2000;

interface OutboxMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  receivedAt: string;
}
type Failure = { ok: false; reason: "timeout" | "aborted"; message: string };

export interface OutboxInbox {
  readonly provider: "mailpit";
  readonly host: string;
  readonly emailDomain: string;
  address(hint?: string): Promise<{ ok: true; address: string }>;
  waitForMessage(options: {
    to: string;
    since: Date;
    timeoutMs: number;
    subjectContains?: string;
    signal?: AbortSignal;
  }): Promise<{ ok: true; message: OutboxMessage } | Failure>;
  check(): Promise<{
    ok: boolean;
    provider: string;
    host: string;
    status: "ok";
    message: string;
  }>;
}

export function shopInbox(
  shop: Pick<RunningShop, "outbox">,
  options: { domain?: string; pollMs?: number; hold?: boolean } = {},
): OutboxInbox {
  const pollMs = options.pollMs ?? 100;
  return {
    provider: "mailpit",
    host: "shop-outbox.local",
    emailDomain: options.domain ?? "example.test",
    async address(hint) {
      return { ok: true, address: `${hint ?? "test"}@${options.domain ?? "example.test"}` };
    },
    async waitForMessage({ to, since, timeoutMs, signal, subjectContains }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (signal?.aborted) return { ok: false, reason: "aborted", message: "Cancelled." };
        const found = options.hold
          ? undefined
          : [...shop.outbox()]
              .reverse()
              .find(
                (mail) =>
                  mail.to.toLowerCase() === to.toLowerCase() &&
                  Date.parse(mail.sentAt) >= since.getTime() - CLOCK_SKEW_MS &&
                  (!subjectContains || mail.subject.includes(subjectContains)),
              );
        if (found)
          return {
            ok: true,
            message: {
              id: `${found.to}-${found.sentAt}`,
              from: "no-reply@acme-shop.localhost",
              to: [found.to],
              subject: found.subject,
              text: found.text,
              html: "",
              receivedAt: found.sentAt,
            },
          };
        if (Date.now() >= deadline)
          return { ok: false, reason: "timeout", message: `No email to ${to} arrived in time.` };
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
    async check() {
      return {
        ok: true,
        provider: "mailpit",
        host: "shop-outbox.local",
        status: "ok",
        message: "the shop's outbox",
      };
    },
  };
}
