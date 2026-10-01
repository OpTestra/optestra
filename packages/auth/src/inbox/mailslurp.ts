import type { SecretValue } from "@optestra/config/node";
import {
  arr,
  failure,
  httpFailure,
  obj,
  pause,
  receivedSince,
  str,
  subjectMatches,
} from "./common.js";
import { createInboxTransport, type FetchLike } from "./transport.js";
import type { Inbox, InboxCheck, InboxMessage, InboxResult } from "./types.js";

// MailSlurp (mailslurp.com). Each address is an inbox created through the API, so
// `address()` creates one (or reuses `inboxId`). The key goes in the x-api-key
// header, only to the configured host. API used: POST /inboxes, GET /inboxes/<id>,
// GET /inboxes/byEmailAddress, GET /waitForLatestEmail (long poll), GET /user/info.

export interface MailslurpOptions {
  baseUrl: string;
  inboxId?: string;
  key: SecretValue;
  keySecret: string;
  fetch?: FetchLike;
}

const NAME = "MailSlurp";

export function createMailslurpInbox(options: MailslurpOptions): Inbox {
  const transport = createInboxTransport(options.baseUrl, {
    auth: { kind: "header", name: "x-api-key", key: options.key },
    ...(options.fetch && { fetch: options.fetch }),
  });
  // address → inbox id, for inboxes this process created or looked up.
  const inboxes = new Map<string, string>();

  async function inboxIdFor(
    to: string,
    signal?: AbortSignal,
  ): Promise<InboxResult<{ id: string }>> {
    const known = inboxes.get(to.toLowerCase());
    if (known) return { ok: true, id: known };
    const result = await transport.request({
      method: "GET",
      path: `/inboxes/byEmailAddress?emailAddress=${encodeURIComponent(to)}`,
      timeoutMs: 10_000,
      ...(signal && { signal }),
    });
    if (result.kind === "error" || result.status !== 200) {
      return httpFailure(NAME, result, options.keySecret);
    }
    const found = obj(result.json);
    if (found.exists === false || !str(found.inboxId)) {
      return failure(
        "not_configured",
        `${to} is not a MailSlurp inbox of this account.`,
        "Use an address from the inbox (address()), or set inbox.mailslurp.inboxId.",
      );
    }
    inboxes.set(to.toLowerCase(), str(found.inboxId));
    return { ok: true, id: str(found.inboxId) };
  }

  return {
    provider: "mailslurp",
    host: transport.host,
    emailDomain: undefined,

    async address() {
      const result = options.inboxId
        ? await transport.request({
            method: "GET",
            path: `/inboxes/${encodeURIComponent(options.inboxId)}`,
            timeoutMs: 10_000,
          })
        : await transport.request({ method: "POST", path: "/inboxes", timeoutMs: 10_000 });
      if (result.kind === "error" || (result.status !== 200 && result.status !== 201)) {
        return httpFailure(NAME, result, options.keySecret);
      }
      const inbox = obj(result.json);
      const address = str(inbox.emailAddress);
      if (!address)
        return failure("bad_response", "MailSlurp returned an inbox without an address.");
      inboxes.set(address.toLowerCase(), str(inbox.id));
      return { ok: true, address };
    },

    async waitForMessage({ to, subjectContains, since, timeoutMs, signal }) {
      const inbox = await inboxIdFor(to, signal);
      if (!inbox.ok) return inbox;
      const deadline = Date.now() + timeoutMs;
      const noMessage = () =>
        failure(
          "timeout",
          `No email to ${to}${subjectContains ? ` with "${subjectContains}" in the subject` : ""} arrived in MailSlurp within ${Math.round(timeoutMs / 1000)} s.`,
        );
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return noMessage();
        const after = new Date(since.getTime() - 2000).toISOString();
        const result = await transport.request({
          method: "GET",
          path: `/waitForLatestEmail?inboxId=${encodeURIComponent(inbox.id)}&timeout=${Math.round(left)}&unreadOnly=false&since=${encodeURIComponent(after)}`,
          timeoutMs: left + 10_000,
          ...(signal && { signal }),
        });
        if (result.kind === "error") {
          return result.reason === "timeout" ? noMessage() : httpFailure(NAME, result);
        }
        if (result.status === 408 || result.status === 404 || result.status === 204)
          return noMessage();
        if (result.status !== 200) return httpFailure(NAME, result, options.keySecret);
        const m = obj(result.json);
        const body = str(m.body);
        const message: InboxMessage = {
          id: str(m.id),
          from: str(m.from),
          to: arr(m.to).map(str),
          subject: str(m.subject),
          text: m.isHTML === true ? "" : body,
          html: m.isHTML === true ? body : "",
          receivedAt: str(m.createdAt),
        };
        if (subjectMatches(message.subject, subjectContains) && receivedSince(message, since)) {
          return { ok: true, message };
        }
        // The latest email isn't the one we want (yet); wait for a newer one.
        await pause(500, signal);
        if (signal?.aborted) return failure("aborted", "cancelled");
      }
    },

    async check(): Promise<InboxCheck> {
      const result = await transport.request({
        method: "GET",
        path: "/user/info",
        timeoutMs: 10_000,
      });
      const base = { provider: "mailslurp", host: transport.host };
      if (result.kind === "response" && result.status === 200) {
        return { ...base, ok: true, status: "ok", message: "Key valid." };
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
