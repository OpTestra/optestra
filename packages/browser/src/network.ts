import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Network mocking (ENV-4), inside the harness's own route handler, so a mock or
// a recorded response can only ever answer a request the allowlist already let
// through (SAF-1).
// - Mocks: `Mock:` steps. A method and a URL pattern (`*` matches anything; no
//   `?` in the pattern means any query) answered with a status and a body.
// - Recorded traffic: with `record`, every fetch/XHR answer is kept; with
//   `replay`, those requests are answered from the file. Written as a HAR 1.2
//   file (the standard: it opens in browser devtools and Playwright reads it),
//   by this code rather than Playwright's HAR recorder, so only allowed
//   requests are in it, text bodies pass through the evidence redactor, and
//   only the content type of the headers is kept (no cookies or tokens).
//   Documents, scripts and images always come from the app.

export interface MockRule {
  method: string;
  /** Absolute URL pattern (already resolved against the base URL). */
  url: string;
  status: number;
  body?: Uint8Array | string;
  contentType?: string;
  stepIndex?: number;
  /** Project-relative body file, for the report. */
  file?: string;
}

export interface MockUse {
  source: "step" | "recorded";
  method: string;
  url: string;
  status: number | null;
  hits: number;
  stepIndex: number | null;
  file: string | null;
}

interface HarEntry {
  /** Ours: path + query of a request to the app's own origin, so a recording works on another port or host. */
  _route?: string;
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: { name: string; value: string }[];
    queryString: { name: string; value: string }[];
    cookies: [];
    headersSize: -1;
    bodySize: -1;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: { name: string; value: string }[];
    cookies: [];
    content: { size: number; mimeType: string; text?: string; encoding?: "base64" };
    redirectURL: string;
    headersSize: -1;
    bodySize: -1;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
}

const TEXT_TYPE =
  /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|[^;]+\+(json|xml))/i;
export const RECORDED_TYPES = new Set(["fetch", "xhr"]);

function patternOf(url: string): RegExp {
  const hasQuery = url.includes("?");
  const escaped = url
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("?", "\\?")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}${hasQuery ? "" : "(\\?.*)?"}$`);
}

/** The mocks of a session: first match wins, latest rule first (a later step overrides). */
export class Mocks {
  readonly #rules: { rule: MockRule; pattern: RegExp; hits: number }[] = [];

  add(rule: MockRule): void {
    this.#rules.unshift({ rule, pattern: patternOf(rule.url), hits: 0 });
  }

  /** The rule answering this request, counted as used. */
  match(method: string, url: string): MockRule | undefined {
    const found = this.#rules.find(
      (r) =>
        (r.rule.method === "*" || r.rule.method === method.toUpperCase()) && r.pattern.test(url),
    );
    if (found) found.hits++;
    return found?.rule;
  }

  uses(): MockUse[] {
    return [...this.#rules].reverse().map(({ rule, hits }) => ({
      source: "step",
      method: rule.method,
      url: routeOfPattern(rule.url),
      status: rule.status,
      hits,
      stepIndex: rule.stepIndex ?? null,
      file: rule.file ?? null,
    }));
  }
}

function routeOfPattern(url: string): string {
  const match = /^https?:\/\/[^/]+(\/.*)?$/.exec(url);
  return match ? (match[1] ?? "/") : url;
}

export interface RecordedResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

/** Recorded traffic: written on `record`, answered from on `replay`. */
export class Traffic {
  readonly #entries: HarEntry[] = [];
  readonly #replay = new Map<string, HarEntry[]>();
  readonly #used = new Map<string, number>();
  served = 0;
  missed = 0;

  constructor(
    readonly mode: "record" | "replay",
    readonly file: string,
    readonly label: string,
    readonly redact: (text: string) => string,
    readonly creator: { name: string; version: string },
  ) {
    if (mode !== "replay" || !existsSync(file)) return;
    const har = JSON.parse(readFileSync(file, "utf8")) as { log?: { entries?: HarEntry[] } };
    for (const entry of har.log?.entries ?? []) {
      const key = `${entry.request.method} ${entry._route ?? entry.request.url}`;
      this.#replay.set(key, [...(this.#replay.get(key) ?? []), entry]);
    }
  }

  /**
   * The recorded answer to a request (in order; the last one repeats), or
   * undefined. `where` is the request's route on the app's own origin, else its URL.
   */
  answer(method: string, where: string): RecordedResponse | undefined {
    const key = `${method.toUpperCase()} ${where}`;
    const list = this.#replay.get(key);
    if (!list?.length) {
      this.missed++;
      return undefined;
    }
    const used = this.#used.get(key) ?? 0;
    this.#used.set(key, used + 1);
    const entry = list[Math.min(used, list.length - 1)] as HarEntry;
    this.served++;
    const content = entry.response.content;
    return {
      status: entry.response.status,
      contentType: content.mimeType,
      body:
        content.encoding === "base64"
          ? Buffer.from(content.text ?? "", "base64")
          : Buffer.from(content.text ?? "", "utf8"),
    };
  }

  /** Keeps an answer (record mode). Text is scrubbed; other bodies are not kept. */
  keep(
    method: string,
    url: string,
    route: string | undefined,
    status: number,
    statusText: string,
    contentType: string,
    body: Buffer,
  ): void {
    if (this.mode !== "record") return;
    const text = TEXT_TYPE.test(contentType);
    if (!text && body.length > 0) return;
    const scrubbed = text ? this.redact(body.toString("utf8")) : "";
    const parsed = new URL(url);
    this.#entries.push({
      ...(route !== undefined ? { _route: this.redact(route) } : {}),
      startedDateTime: new Date().toISOString(),
      time: 0,
      request: {
        method: method.toUpperCase(),
        url: this.redact(url),
        httpVersion: "HTTP/1.1",
        headers: [],
        queryString: [...parsed.searchParams].map(([name, value]) => ({
          name,
          value: this.redact(value),
        })),
        cookies: [],
        headersSize: -1,
        bodySize: -1,
      },
      response: {
        status,
        statusText,
        httpVersion: "HTTP/1.1",
        headers: [{ name: "content-type", value: contentType }],
        cookies: [],
        content: { size: Buffer.byteLength(scrubbed), mimeType: contentType, text: scrubbed },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    });
  }

  /** Writes the recorded traffic (record mode). */
  save(): void {
    if (this.mode !== "record") return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(
      this.file,
      `${JSON.stringify({ log: { version: "1.2", creator: this.creator, entries: this.#entries } }, null, 2)}\n`,
    );
  }

  use(): MockUse | undefined {
    if (this.mode !== "replay" || this.served + this.missed === 0) return undefined;
    return {
      source: "recorded",
      method: "*",
      url: "*",
      status: null,
      hits: this.served,
      stepIndex: null,
      file: this.label,
    };
  }

  get recorded(): number {
    return this.#entries.length;
  }
}
