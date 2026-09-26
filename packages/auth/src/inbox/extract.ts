import patterns from "./patterns.json" with { type: "json" };

// Code and link extraction from test emails (SEC-5). Pure: no Node APIs, so the
// apps can use it too (`@testament/auth/extract`). Word lists: patterns.json.

export interface ExtractableMessage {
  subject?: string;
  text?: string;
  html?: string;
}

export interface ExtractedLink {
  url: string;
  /** The link's text (HTML anchor text), "" for bare URLs. */
  text: string;
  host: string;
  /** action = looks like a verify / magic / reset link; other = anything else. */
  kind: "action" | "other";
  score: number;
}

export interface ExtractedLinks {
  /** Links on allowed hosts, best first (action links before others; avoid-links last). */
  links: ExtractedLink[];
  /** Links whose host isn't allowed. They are never followed. */
  refused: ExtractedLink[];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
    return ENTITIES[lower] ?? whole;
  });
}

/** The visible text of an HTML email, one block per line. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|td|th|section|header|footer)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function bodyText(message: ExtractableMessage): string {
  const text = message.text?.trim();
  return text ? text : htmlToText(message.html ?? "");
}

/** Blanks out URLs (same length, so positions stay), so tokens inside links aren't codes. */
function withoutUrls(text: string): string {
  return text.replace(/(?:https?:\/\/|www\.)[^\s<>"']+/gi, (url) => " ".repeat(url.length));
}

const escapeRegex = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordsPattern = (words: readonly string[]) =>
  new RegExp(
    `(?<![a-z0-9])(?:${[...words]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join("|")})(?![a-z0-9])`,
    "gi",
  );

const CODE_WORDS = wordsPattern(patterns.codeWords);
const STRONG_BEFORE = new RegExp(
  `(?:${patterns.strongBefore.map(escapeRegex).join("|")})\\s*[:\\-=]?\\s*["'“«(\\[]?\\s*$`,
  "i",
);
const NOT_CODE_BEFORE = new RegExp(
  `(?<![a-z0-9])(?:${[...patterns.notCodeBefore]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|")})\\s*(?:[#:.]\\s*)*(?:is\\s+)?$`,
  "i",
);
const NOT_CODE_AFTER = new RegExp(
  `^\\s*(?:%|${patterns.notCodeAfter.map(escapeRegex).join("|")})(?![a-z])`,
  "i",
);
const CANDIDATE =
  /(?<![A-Za-z0-9])(\d{3}[- ]\d{3}|\d{4}[- ]\d{4}|[A-Za-z0-9]{4,8})(?![A-Za-z0-9])/g;
const MONTHS =
  /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*$|^\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;

interface Candidate {
  code: string;
  score: number;
  at: number;
}

function wordPositions(text: string): number[] {
  return [...text.matchAll(CODE_WORDS)].map((m) => m.index ?? 0);
}

/** Why a token near a number is not a code: part of a date, time, price, amount, phone… */
function looksLikeOtherNumber(text: string, start: number, end: number, token: string): boolean {
  const before = text.slice(Math.max(0, start - 3), start);
  const after = text.slice(end, end + 3);
  // Money: $29, €1200, 1200.00, 1,200
  if (/[$€£¥₹]\s*$/.test(before)) return true;
  if (/^[.,]\d/.test(after) || /\d[.,]$/.test(before)) return true;
  // Dates and times: 2026-09-26, 09/26/2026, 26.09.2026, 12:30
  if (/^[-/.:]\d/.test(after) || /\d[-/.:]$/.test(before)) return true;
  // Part of a longer identifier: A-1003, INV_2291, abc/1234
  if (/[A-Za-z0-9][-_/]$/.test(before) || /^[-_/][A-Za-z0-9]/.test(after)) return true;
  // Phone numbers: +1 555 123 4567, (555) 123-4567
  if (/\+\s*$/.test(before) || /\)\s*$/.test(before)) return true;
  if (/^\s\d{3,4}(?!\d)/.test(after) && /^\d+$/.test(token.replace(/[- ]/g, ""))) return true;
  return false;
}

function isYear(token: string): boolean {
  return /^(19|20)\d{2}$/.test(token);
}

/**
 * The one-time code in an email: 4–8 digits (or `123-456`), or a 4–8 character
 * letters-and-digits code, next to words like code, verify, OTP. Dates, times,
 * prices, amounts, years, phone and order numbers are ignored. Returns the code
 * without separators, or undefined when there is no clear code.
 */
export function extractCode(message: ExtractableMessage): string | undefined {
  const blocks = [message.subject ?? "", bodyText(message)].map(withoutUrls);
  const candidates: Candidate[] = [];
  let offset = 0;
  for (const [blockIndex, block] of blocks.entries()) {
    const words = wordPositions(block);
    const lines = block.split("\n");
    let lineStart = 0;
    for (const line of lines) {
      for (const match of line.matchAll(CANDIDATE)) {
        const token = match[1] ?? "";
        const start = match.index ?? 0;
        const end = start + token.length;
        const compact = token.replace(/[- ]/g, "");
        const digits = /^\d+$/.test(compact);
        const hasDigit = /\d/.test(compact);
        const hasLetter = /[A-Za-z]/.test(compact);
        if (digits && (compact.length < 4 || compact.length > 8)) continue;
        const beforeText = line.slice(Math.max(0, start - 40), start);
        const afterText = line.slice(end, end + 20);
        const strong = STRONG_BEFORE.test(beforeText);
        if (!digits) {
          // Words are not codes, unless the email says "your code is ABCDEF" in capitals.
          if (!hasDigit && !(strong && /^[A-Z]{4,8}$/.test(compact))) continue;
          if (hasDigit && !hasLetter) continue;
        }
        if (looksLikeOtherNumber(line, start, end, token)) continue;
        if (NOT_CODE_AFTER.test(afterText)) continue;
        if (MONTHS.test(beforeText.slice(-12)) || MONTHS.test(afterText.slice(0, 12))) continue;
        if (!strong && NOT_CODE_BEFORE.test(beforeText)) continue;
        if (!strong && digits && isYear(compact)) continue;

        const at = lineStart + start;
        const distance = Math.min(
          Number.POSITIVE_INFINITY,
          ...words.map((w) => (w <= at ? at - w : (w - at) * 2)),
        );
        let score = 0;
        if (strong) score += 10;
        if (distance <= patterns.maxDistance) score += 8 - distance / 10;
        if (line.trim() === token) score += 5;
        if (digits && compact.length === 6) score += 2;
        else if (digits) score += 1;
        if (blockIndex === 0) score += 1;
        // Needs a reason to be a code: a code word nearby, or "code is" right before it.
        if (!strong && distance > patterns.maxDistance) continue;
        candidates.push({ code: compact, score, at: offset + at });
      }
      lineStart += line.length + 1;
    }
    offset += block.length + 1;
  }
  candidates.sort((a, b) => b.score - a.score || a.at - b.at);
  return candidates[0]?.code;
}

// ── Links ─────────────────────────────────────────────────────────────────────

interface DomainEntry {
  host: string;
  wildcard: boolean;
  port: number | undefined;
}

function parseDomain(entry: string): DomainEntry | undefined {
  const match = /^(\*\.)?([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(entry.trim());
  if (!match?.[2]) return undefined;
  return {
    host: match[2].toLowerCase(),
    wildcard: Boolean(match[1]),
    port: match[3] === undefined ? undefined : Number(match[3]),
  };
}

/**
 * Same rules as the browser allowlist: `example.com` exactly, `*.example.com` any
 * subdomain (not the domain itself), optional `:port`. Only http(s).
 */
export function urlAllowed(url: string, allowedDomains: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  return allowedDomains.some((domain) => {
    const entry = parseDomain(domain);
    if (!entry) return false;
    if (entry.port !== undefined && entry.port !== port) return false;
    return entry.wildcard ? host.endsWith(`.${entry.host}`) : host === entry.host;
  });
}

const LINK_WORDS = wordsPattern(patterns.linkWords);
const AVOID_WORDS = wordsPattern(patterns.linkAvoid);
const BARE_URL = /https?:\/\/[^\s<>"'`]+/gi;

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?)\]}>]+$/, "");
}

function scoreLink(url: string, text: string): { score: number; kind: ExtractedLink["kind"] } {
  const haystack = `${decodeURIComponent(url.replace(/%(?![0-9a-f]{2})/gi, "%25"))} ${text}`;
  const avoid = (haystack.match(AVOID_WORDS) ?? []).length;
  const words = (haystack.match(LINK_WORDS) ?? []).length;
  if (avoid > 0) return { score: -10 * avoid + words, kind: "other" };
  return { score: words * 5, kind: words > 0 ? "action" : "other" };
}

/**
 * Every http(s) link in an email, split into allowed and refused by host.
 * Verify / magic / reset links come first. A link to a host outside
 * `allowedDomains` is only ever reported in `refused`, never in `links`.
 */
export function extractLinks(
  message: ExtractableMessage,
  allowedDomains: readonly string[],
): ExtractedLinks {
  const found = new Map<string, string>();
  const html = message.html ?? "";
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = decodeEntities(match[2] ?? "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (!found.has(url)) found.set(url, htmlToText(match[3] ?? "").replace(/\n/g, " "));
  }
  const bare = `${message.text ?? ""}\n${htmlToText(html)}`;
  for (const match of bare.matchAll(BARE_URL)) {
    const url = trimUrl(match[0]);
    if (!found.has(url)) found.set(url, "");
  }
  const all: ExtractedLink[] = [...found].flatMap(([url, text]) => {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return [];
    }
    return [{ url, text, host, ...scoreLink(url, text) }];
  });
  const order = (a: ExtractedLink, b: ExtractedLink) => b.score - a.score;
  return {
    links: all.filter((link) => urlAllowed(link.url, allowedDomains)).sort(order),
    refused: all.filter((link) => !urlAllowed(link.url, allowedDomains)),
  };
}

/** The link to follow: the best allowed action link, else the best allowed non-avoid link. */
export function pickLink(links: ExtractedLinks): ExtractedLink | undefined {
  return (
    links.links.find((link) => link.kind === "action") ?? links.links.find((l) => l.score >= 0)
  );
}
