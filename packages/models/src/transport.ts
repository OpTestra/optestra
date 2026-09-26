// THE ONLY FILE IN THE ENGINE THAT TOUCHES THE NETWORK (see test/guards.test.ts).
// Every provider request goes through `guardedFetch`, which only talks to the
// provider's own host, so a key can never be sent anywhere else.

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class BlockedHostError extends Error {
  constructor(
    readonly host: string,
    readonly allowedHost: string,
  ) {
    super(`Blocked a request to ${host}; this provider may only call ${allowedHost}.`);
    this.name = "BlockedHostError";
  }
}

/** The platform fetch. Tests pass their own. */
export const platformFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export interface GuardedFetchOptions {
  /** Called with each JSON response body (used to read provider-reported cost). */
  onJson?: (body: unknown) => void;
  base?: FetchLike;
}

/** A fetch that refuses every host but `allowedHost` (host includes the port). */
export function guardedFetch(allowedHost: string, options: GuardedFetchOptions = {}): FetchLike {
  const base = options.base ?? platformFetch;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== allowedHost) throw new BlockedHostError(url.host, allowedHost);
    const response = await base(input, init);
    if (options.onJson && response.headers.get("content-type")?.includes("json")) {
      try {
        options.onJson(await response.clone().json());
      } catch {
        // Not JSON after all; the SDK reports its own parse errors.
      }
    }
    return response;
  };
}
