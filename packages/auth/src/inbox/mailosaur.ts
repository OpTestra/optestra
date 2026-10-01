import { randomBytes } from "node:crypto";
import type { SecretValue } from "@optestra/config/node";
import {
  arr,
  failure,
  httpFailure,
  localPart,
  obj,
  receivedSince,
  str,
  subjectMatches,
} from "./common.js";
import { createInboxTransport, type FetchLike } from "./transport.js";
import type { Inbox, InboxCheck, InboxMessage } from "./types.js";

// Mailosaur (mailosaur.com). Every address at <serverId>.mailosaur.net lands in the
// server. The key is sent as HTTP basic auth, only to the configured host. API used:
// POST /api/messages/await?server=&timeout=&receivedAfter= (long poll; 204 = nothing),
// GET /api/servers/<serverId> (key and server check).

export interface MailosaurOptions {
  baseUrl: string;
  serverId: string;
  key: SecretValue;
  keySecret: string;
  fetch?: FetchLike;
}

const NAME = "Mailosaur";

function email(value: unknown): string {
  return str(obj(value).email);
}

export function createMailosaurInbox(options: MailosaurOptions): Inbox {
  const transport = createInboxTransport(options.baseUrl, {
    auth: { kind: "basic", key: options.key },
    ...(options.fetch && { fetch: options.fetch }),
  });
  const domain = `${options.serverId}.mailosaur.net`;
  const server = encodeURIComponent(options.serverId);

  return {
    provider: "mailosaur",
    host: transport.host,
    emailDomain: domain,

    async address(hint) {
      return {
        ok: true,
        address: `${localPart(hint, () => randomBytes(5).toString("hex"))}@${domain}`,
      };
    },

    async waitForMessage({ to, subjectContains, since, timeoutMs, signal }) {
      const after = new Date(since.getTime() - 2000).toISOString();
      const result = await transport.request({
        method: "POST",
        path: `/api/messages/await?server=${server}&timeout=${Math.round(timeoutMs)}&receivedAfter=${encodeURIComponent(after)}`,
        body: { sentTo: to, ...(subjectContains && { subject: subjectContains }) },
        // The server waits up to timeoutMs; allow for the round trip.
        timeoutMs: timeoutMs + 10_000,
        ...(signal && { signal }),
      });
      const noMessage = () =>
        failure(
          "timeout",
          `No email to ${to}${subjectContains ? ` with "${subjectContains}" in the subject` : ""} arrived in Mailosaur within ${Math.round(timeoutMs / 1000)} s.`,
          `Check that the app sends to an address at ${domain}.`,
        );
      if (result.kind === "error") {
        return result.reason === "timeout" ? noMessage() : httpFailure(NAME, result);
      }
      if (result.status === 204 || result.status === 404) return noMessage();
      if (result.status !== 200) {
        return httpFailure(NAME, result, `${options.keySecret} and inbox.mailosaur.serverId`);
      }
      const m = obj(result.json);
      const message: InboxMessage = {
        id: str(m.id),
        from: email(arr(m.from)[0]),
        to: arr(m.to).map(email),
        subject: str(m.subject),
        text: str(obj(m.text).body),
        html: str(obj(m.html).body),
        receivedAt: str(m.received),
      };
      if (!subjectMatches(message.subject, subjectContains) || !receivedSince(message, since)) {
        return noMessage();
      }
      return { ok: true, message };
    },

    async check(): Promise<InboxCheck> {
      const result = await transport.request({
        method: "GET",
        path: `/api/servers/${server}`,
        timeoutMs: 10_000,
      });
      const base = { provider: "mailosaur", host: transport.host };
      if (result.kind === "response" && result.status === 200) {
        return {
          ...base,
          ok: true,
          status: "ok",
          message: `Key valid; server ${options.serverId} found.`,
        };
      }
      if (result.kind === "response" && result.status === 404) {
        return {
          ...base,
          ok: false,
          status: "not_configured",
          message: `Mailosaur has no server ${options.serverId} for this key.`,
          fix: "Set inbox.mailosaur.serverId to the server id shown in the Mailosaur dashboard.",
        };
      }
      const problem = httpFailure(NAME, result, options.keySecret);
      return {
        ...base,
        ok: false,
        status: problem.reason,
        message: problem.message,
        ...(problem.fix && { fix: problem.fix }),
      };
    },
  };
}
