import { Allowlist, parseUrl } from "./allowlist.js";

// Protected previews (SEC-8): extra request headers whose values are secrets
// (Vercel's bypass token, Cloudflare Access service tokens, basic auth, custom
// headers). A header is added to a request only when its URL is allowed by the
// session's allowlist AND by the header's own domains (its secret's `domains`).
// Every other request, including anything the allowlist refuses, never sees it.

export interface ScopedHeader {
  /** Header name as the server expects it (sent lower-cased; HTTP names are case-insensitive). */
  name: string;
  value: string;
  /** Where this header may go (the secret's domains). */
  domains: readonly string[];
  /** Keep a header the request already has (basic auth must not override an app's own Authorization). */
  keepExisting?: boolean;
}

export class HeaderScope {
  readonly #entries: { header: ScopedHeader; allow: Allowlist }[];
  readonly #allowlist: Allowlist;

  constructor(headers: readonly ScopedHeader[], allowlist: Allowlist) {
    this.#allowlist = allowlist;
    this.#entries = headers.map((header) => ({ header, allow: new Allowlist(header.domains) }));
  }

  get size(): number {
    return this.#entries.length;
  }

  /**
   * The request's headers with the protected ones added, or undefined when none
   * apply (the request then goes out unchanged).
   */
  apply(
    url: string | URL,
    existing: Readonly<Record<string, string>>,
  ): Record<string, string> | undefined {
    if (this.#entries.length === 0) return undefined;
    const parsed = parseUrl(url);
    if (!parsed || !this.#allowlist.allowsUrl(parsed)) return undefined;
    const has = new Set(Object.keys(existing).map((key) => key.toLowerCase()));
    let out: Record<string, string> | undefined;
    for (const { header, allow } of this.#entries) {
      if (!allow.allowsUrl(parsed)) continue;
      const key = header.name.toLowerCase();
      if (header.keepExisting && has.has(key)) continue;
      out ??= { ...existing };
      for (const name of Object.keys(out)) if (name.toLowerCase() === key) delete out[name];
      out[key] = header.value;
    }
    return out;
  }
}

/** `Basic base64(user:password)`. */
export function basicAuthValue(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
