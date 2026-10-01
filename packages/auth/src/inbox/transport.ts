// THE ONLY FILE IN @optestra/auth THAT TOUCHES THE NETWORK (see test/guards.test.ts).
// Every inbox request (Mailpit, Mailosaur, MailSlurp) goes through `createInboxTransport`,
// pinned to the configured inbox host, so an API key can't be sent anywhere else.
// RESTRICTED import: the key is revealed only here, only for its own provider's host.
import { revealSecret } from "@optestra/config/reveal";
import { defaultRedactor, type SecretValue } from "@optestra/config/node";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The platform fetch. Tests pass their own. */
export const platformFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** How the key is sent: HTTP basic (Mailosaur: the key is the user name) or a header (MailSlurp). */
export type InboxAuth =
  | { kind: "basic"; key: SecretValue }
  | { kind: "header"; name: string; key: SecretValue };

export interface InboxRequest {
  method: "GET" | "POST" | "DELETE";
  /** Path and query on the pinned host, e.g. `/api/v1/search?query=to%3Aa%40b.test`. */
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
}

export type InboxHttpResult =
  | { kind: "response"; status: number; json: unknown }
  | { kind: "error"; reason: "timeout" | "aborted" | "unavailable" | "blocked"; message: string };

export interface InboxTransport {
  /** host[:port] every request is pinned to. */
  readonly host: string;
  /** Never throws. */
  request(request: InboxRequest): Promise<InboxHttpResult>;
}

function describe(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
}

function authHeaders(auth: InboxAuth | undefined): Record<string, string> {
  if (!auth) return {};
  const key = revealSecret(auth.key);
  if (auth.kind === "basic") {
    // The combined "key:" is encoded as a whole, so register it too (see config README).
    defaultRedactor.register(`${key}:`, auth.key.label);
    return { authorization: `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}` };
  }
  return { [auth.name]: key };
}

/**
 * A transport pinned to the host of `baseUrl`. Requests to any other host are
 * refused before anything is sent; redirects are errors (never followed).
 */
export function createInboxTransport(
  baseUrl: string,
  options: { auth?: InboxAuth; fetch?: FetchLike } = {},
): InboxTransport {
  const origin = new URL(baseUrl);
  const host = origin.host;
  const base = options.fetch ?? platformFetch;
  return {
    host,
    async request(request) {
      const url = new URL(request.path, origin);
      if (url.host !== host || url.protocol !== origin.protocol) {
        return {
          kind: "error",
          reason: "blocked",
          message: `Blocked a request to ${url.host}; this inbox may only call ${host}.`,
        };
      }
      let timeout: AbortSignal | undefined;
      let response: Response;
      try {
        timeout = AbortSignal.timeout(Math.max(1, Math.ceil(request.timeoutMs)));
        const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
        response = await base(url, {
          method: request.method,
          headers: {
            accept: "application/json",
            ...(request.body === undefined ? {} : { "content-type": "application/json" }),
            ...authHeaders(options.auth),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal,
          redirect: "error",
        });
      } catch (error) {
        if (request.signal?.aborted)
          return { kind: "error", reason: "aborted", message: "aborted" };
        if (timeout?.aborted) {
          return {
            kind: "error",
            reason: "timeout",
            message: `no response from ${host} within ${request.timeoutMs} ms`,
          };
        }
        return {
          kind: "error",
          reason: "unavailable",
          message: `cannot reach ${host}: ${describe(error)}`,
        };
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        return request.signal?.aborted
          ? { kind: "error", reason: "aborted", message: "aborted" }
          : { kind: "error", reason: "timeout", message: `response cut off: ${describe(error)}` };
      }
      let json: unknown;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { kind: "response", status: response.status, json };
    },
  };
}
