// Allowlist matching (SAF-1). Entries are host names: `example.com` (exactly that
// host), `*.example.com` (any subdomain, not example.com itself) and an optional
// `:port` (`example.com:8080`); without a port every port matches. Hosts compare
// case-insensitively. Only http(s) URLs can ever match.

export interface AllowEntry {
  host: string;
  wildcard: boolean;
  port: number | undefined;
}

const ENTRY =
  /^(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i;

/** Parses one entry, or returns undefined when it isn't a valid host pattern. */
export function parseAllowEntry(entry: string): AllowEntry | undefined {
  const match = ENTRY.exec(entry.trim());
  if (!match?.[2]) return undefined;
  const port = match[3] === undefined ? undefined : Number(match[3]);
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  return { host: match[2].toLowerCase(), wildcard: Boolean(match[1]), port };
}

export class Allowlist {
  readonly entries: readonly AllowEntry[];
  /** Entries that didn't parse; they allow nothing. */
  readonly invalid: readonly string[];

  constructor(domains: readonly string[]) {
    const entries: AllowEntry[] = [];
    const invalid: string[] = [];
    for (const domain of domains) {
      const entry = parseAllowEntry(domain);
      if (entry) entries.push(entry);
      else invalid.push(domain);
    }
    this.entries = entries;
    this.invalid = invalid;
  }

  /** True when `host` (and `port`, if the entry names one) is allowed. */
  allowsHost(host: string, port?: number): boolean {
    const name = host.toLowerCase().replace(/^\[|\]$/g, "");
    return this.entries.some((entry) => {
      if (entry.port !== undefined && entry.port !== port) return false;
      return entry.wildcard ? name.endsWith(`.${entry.host}`) : name === entry.host;
    });
  }

  /** True for http(s) URLs whose host is allowed. Everything else is refused. */
  allowsUrl(url: string | URL): boolean {
    const parsed = parseUrl(url);
    if (!parsed || !isHttp(parsed)) return false;
    return this.allowsHost(parsed.hostname, effectivePort(parsed));
  }

  /**
   * The browser's proxy bypass list: exactly the allowed hosts. `<-loopback>`
   * first, so loopback addresses are not bypassed implicitly (Chromium bypasses
   * them by default).
   */
  proxyBypass(): string {
    const rules = this.entries.map((entry) => {
      const host = entry.wildcard ? `*.${entry.host}` : entry.host;
      return entry.port === undefined ? host : `${host}:${entry.port}`;
    });
    return ["<-loopback>", ...rules].join(",");
  }
}

export function parseUrl(url: string | URL): URL | undefined {
  if (url instanceof URL) return url;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export const isHttp = (url: URL): boolean => url.protocol === "http:" || url.protocol === "https:";

/** `about:blank` is the one non-http page a session may show (the empty start page). */
export const isBlank = (url: string): boolean => url === "about:blank";

export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
}

/** For ws(s) URLs: the same check as for http(s). */
export function allowsSocketUrl(allowlist: Allowlist, url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")) return false;
  return allowlist.allowsHost(parsed.hostname, effectivePort(parsed));
}

/** Host of a URL, for messages ("" when it has none). */
export function hostOf(url: string): string {
  return parseUrl(url)?.host ?? "";
}
