import { randomBytes } from "node:crypto";
import {
  arr,
  failure,
  httpFailure,
  localPart,
  obj,
  pause,
  receivedSince,
  sameAddress,
  str,
  subjectMatches,
} from "./common.js";
import { createInboxTransport, type FetchLike } from "./transport.js";
import type { Inbox, InboxMessage } from "./types.js";

// Mailpit (mailpit.axllent.org): a local SMTP server with an HTTP API. It catches
// every address, so any address at the configured domain works. API used:
// GET /api/v1/info, GET /api/v1/search?query=to:<address>, GET /api/v1/message/<id>.

export interface MailpitOptions {
  url: string;
  domain: string;
  fetch?: FetchLike;
  /** How often to look for new mail (default 500 ms). */
  pollMs?: number;
}

const NAME = "Mailpit";

function address(value: unknown): string {
  return str(obj(value).Address);
}

export function createMailpitInbox(options: MailpitOptions): Inbox {
  const transport = createInboxTransport(
    options.url,
    options.fetch ? { fetch: options.fetch } : {},
  );
  const pollMs = options.pollMs ?? 500;
  const unreachableFix = `Start Mailpit (docker run -p 8025:8025 -p 1025:1025 axllent/mailpit) or fix inbox.mailpit.url (${options.url}).`;

  return {
    provider: "mailpit",
    host: transport.host,
    emailDomain: options.domain,

    async address(hint) {
      return {
        ok: true,
        address: `${localPart(hint, () => randomBytes(5).toString("hex"))}@${options.domain}`,
      };
    },

    async waitForMessage({ to, subjectContains, since, timeoutMs, signal }) {
      const deadline = Date.now() + timeoutMs;
      const query = encodeURIComponent(`to:"${to}"`);
      for (;;) {
        const left = deadline - Date.now();
        const search = await transport.request({
          method: "GET",
          path: `/api/v1/search?query=${query}&limit=50`,
          timeoutMs: Math.max(1000, Math.min(left, 10_000)),
          ...(signal && { signal }),
        });
        if (search.kind === "error" || search.status !== 200) {
          const problem = httpFailure(NAME, search);
          return problem.reason === "unavailable" ? { ...problem, fix: unreachableFix } : problem;
        }
        // Newest first.
        const match = arr(obj(search.json).messages)
          .map(obj)
          .find(
            (m) =>
              arr(m.To).some((a) => sameAddress(address(a), to)) &&
              subjectMatches(str(m.Subject), subjectContains) &&
              receivedSince({ receivedAt: str(m.Created) }, since),
          );
        if (match) {
          const id = str(match.ID);
          const read = await transport.request({
            method: "GET",
            path: `/api/v1/message/${encodeURIComponent(id)}`,
            timeoutMs: 10_000,
            ...(signal && { signal }),
          });
          if (read.kind === "error" || read.status !== 200) return httpFailure(NAME, read);
          const m = obj(read.json);
          const message: InboxMessage = {
            id,
            from: address(m.From),
            to: arr(m.To).map(address),
            subject: str(m.Subject),
            text: str(m.Text),
            html: str(m.HTML),
            receivedAt: str(m.Date) || str(match.Created),
          };
          return { ok: true, message };
        }
        if (signal?.aborted) return failure("aborted", "cancelled");
        if (Date.now() + pollMs > deadline) {
          return failure(
            "timeout",
            `No email to ${to}${subjectContains ? ` with "${subjectContains}" in the subject` : ""} arrived in Mailpit within ${Math.round(timeoutMs / 1000)} s.`,
            "Check that the app sends email to Mailpit's SMTP port (1025), and the address is right.",
          );
        }
        await pause(pollMs, signal);
      }
    },

    async check() {
      const info = await transport.request({
        method: "GET",
        path: "/api/v1/info",
        timeoutMs: 5000,
      });
      if (info.kind === "response" && info.status === 200) {
        const version = str(obj(info.json).Version);
        return {
          ok: true,
          provider: "mailpit",
          host: transport.host,
          status: "ok",
          message: `Mailpit${version ? ` ${version}` : ""} is running.`,
        };
      }
      const problem = httpFailure(NAME, info);
      return {
        ok: false,
        provider: "mailpit",
        host: transport.host,
        status: problem.reason,
        message: problem.message,
        fix: unreachableFix,
      };
    },
  };
}
