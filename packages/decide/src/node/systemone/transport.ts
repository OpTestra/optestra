// THE ONLY FILE IN @optestra/decide THAT TOUCHES THE NETWORK (see test/guards.test.ts).
// Every System One request (Jev, Kev, Laya via Ollaya) goes through `createTransport`,
// which only talks to the configured backend's own host, so a key or a page's
// state can never be sent anywhere else.

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The platform fetch. Tests pass their own. */
export const platformFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export interface HttpRequest {
  method: "GET" | "POST";
  /** Path on the pinned host, e.g. `/v1/systemone`. */
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs: number;
}

/** A response of any status, with its body parsed as JSON when it is JSON. */
export interface HttpResponse {
  kind: "response";
  status: number;
  /** Parsed JSON, or undefined when the body wasn't JSON. */
  json: unknown;
  headers: Headers;
}

/** The request never produced a response. */
export interface HttpError {
  kind: "error";
  reason: "timeout" | "aborted" | "unavailable" | "blocked";
  message: string;
}

export type HttpResult = HttpResponse | HttpError;

export interface Transport {
  /** host[:port] every request is pinned to. */
  readonly host: string;
  request(request: HttpRequest): Promise<HttpResult>;
  /** Reads a newline-delimited JSON stream (Ollaya pull progress), calling `onLine` per object. */
  stream(request: HttpRequest, onLine: (line: unknown) => void): Promise<HttpResult>;
}

export class BlockedHostError extends Error {
  constructor(
    readonly host: string,
    readonly allowedHost: string,
  ) {
    super(`Blocked a request to ${host}; this decision backend may only call ${allowedHost}.`);
    this.name = "BlockedHostError";
  }
}

function describe(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
}

/**
 * A transport pinned to the host of `baseUrl`. `request` never throws: network
 * errors, timeouts and aborts come back as `{ kind: "error" }`.
 */
export function createTransport(baseUrl: string, base: FetchLike = platformFetch): Transport {
  const origin = new URL(baseUrl);
  const host = origin.host;

  async function send(request: HttpRequest): Promise<Response | HttpError> {
    const url = new URL(request.path, origin);
    if (url.host !== host) {
      return {
        kind: "error",
        reason: "blocked",
        message: new BlockedHostError(url.host, host).message,
      };
    }
    let timeout: AbortSignal | undefined;
    try {
      // AbortSignal.timeout only takes whole milliseconds.
      timeout = AbortSignal.timeout(Math.max(1, Math.ceil(request.timeoutMs)));
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      return await base(url, {
        method: request.method,
        headers: {
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (request.signal?.aborted) return { kind: "error", reason: "aborted", message: "aborted" };
      if (timeout?.aborted)
        return {
          kind: "error",
          reason: "timeout",
          message: `no response within ${request.timeoutMs} ms`,
        };
      return {
        kind: "error",
        reason: "unavailable",
        message: `cannot reach ${host}: ${describe(error)}`,
      };
    }
  }

  const failed = (request: HttpRequest, error: unknown): HttpError =>
    request.signal?.aborted
      ? { kind: "error", reason: "aborted", message: "aborted" }
      : { kind: "error", reason: "timeout", message: `response cut off: ${describe(error)}` };

  return {
    host,
    async request(request) {
      const response = await send(request);
      if (!(response instanceof Response)) return response;
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        return failed(request, error);
      }
      let json: unknown;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { kind: "response", status: response.status, json, headers: response.headers };
    },
    async stream(request, onLine) {
      const response = await send(request);
      if (!(response instanceof Response)) return response;
      if (!response.ok || !response.body) {
        let json: unknown;
        try {
          json = JSON.parse(await response.text());
        } catch {
          json = undefined;
        }
        return { kind: "response", status: response.status, json, headers: response.headers };
      }
      const decoder = new TextDecoder();
      let buffered = "";
      let last: unknown;
      const emit = (line: string) => {
        if (line.trim() === "") return;
        try {
          last = JSON.parse(line);
          onLine(last);
        } catch {
          // Not a JSON line; skip it.
        }
      };
      try {
        for await (const chunk of response.body) {
          buffered += decoder.decode(chunk, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) emit(line);
        }
        emit(buffered);
      } catch (error) {
        return failed(request, error);
      }
      return { kind: "response", status: response.status, json: last, headers: response.headers };
    },
  };
}
