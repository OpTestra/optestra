import { randomInt } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  type APIRequestContext,
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

// Helpers for the generated specs in this folder. Plain Playwright: nothing
// here needs __NAME__ installed. Values come from environment variables at run
// time, never from this file.

export { expect };

// @environment-start
const generated = {
  name: "local",
  baseUrl: "http://127.0.0.1:4100",
  allowedDomains: ["127.0.0.1"],
  vars: {},
  secrets: { SHOP_PASSWORD: ["127.0.0.1"] },
  emailDomain: "example.test",
};
// @environment-end

/** The environment these specs were generated for; `__ENV_PREFIX__*` variables override it. */
export const environment = {
  name: generated.name,
  baseUrl: process.env.__ENV_PREFIX__BASE_URL ?? generated.baseUrl,
  allowedDomains: listOf(process.env.__ENV_PREFIX__ALLOWED_DOMAINS) ?? generated.allowedDomains,
  vars: generated.vars as Record<string, string>,
  secrets: generated.secrets as Record<string, string[]>,
  emailDomain: generated.emailDomain,
};

function listOf(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
}

// ── Allowed domains ─────────────────────────────────────────────────────────
// `example.com` is that host only, `*.example.com` any subdomain, and an
// optional `:port` narrows it. Only http(s) URLs can match.

function allows(domains: readonly string[], url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^(https?|wss?):$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const port = Number(parsed.port || (secure ? 443 : 80));
  return domains.some((domain) => {
    const match = /^(\*\.)?([^:]+)(?::(\d+))?$/.exec(domain.trim().toLowerCase());
    if (!match?.[2] || (match[3] !== undefined && Number(match[3]) !== port)) return false;
    return match[1] ? host.endsWith(`.${match[2]}`) : host === match[2];
  });
}

/** True when the page may load `url` (the environment's allowed domains). */
export function isAllowed(url: string): boolean {
  return allows(environment.allowedDomains, url);
}

/** Resolves `target` against the base URL and refuses hosts outside the allowed domains. */
export function allowed(target: string): string {
  const url = new URL(target, environment.baseUrl).href;
  if (!isAllowed(url)) {
    throw new Error(`${new URL(url).host} is not in the allowed domains.`);
  }
  return url;
}

// ── Values ──────────────────────────────────────────────────────────────────
// A fresh value on every run, so parallel runs never collide.

const FIRST = ["Ada", "Alan", "Grace", "Linus", "Margaret", "Dennis", "Barbara", "Ken", "Hedy"];
const LAST = ["Lovelace", "Turing", "Hopper", "Torvalds", "Hamilton", "Ritchie", "Liskov"];
const COMPANY = ["Northwind", "Bluebird", "Granite", "Lumen", "Harbor", "Juniper", "Summit"];
const SUFFIX = ["Labs", "Works", "Group", "Studio", "Systems", "Co"];
const CITIES = ["Lisbon", "Nairobi", "Osaka", "Toronto", "Lagos", "Melbourne", "Oslo", "Pune"];

const pick = (items: readonly string[]): string => items[randomInt(items.length)] ?? "";
const token = (length: number): string =>
  Array.from({ length }, () => "0123456789abcdefghijklmnopqrstuvwxyz"[randomInt(36)]).join("");
const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

export class Values {
  /** Every address generated in this test, so the inbox knows whom to look for. */
  readonly emails: string[] = [];

  readonly unique = {
    email: () => this.#email(`test-${token(10)}@${environment.emailDomain}`),
    id: () => token(12),
    name: () => `${pick(FIRST)} ${pick(LAST)} ${token(5)}`,
  };

  readonly faker = {
    name: () => `${pick(FIRST)} ${pick(LAST)}`,
    firstName: () => pick(FIRST),
    lastName: () => pick(LAST),
    email: () =>
      this.#email(
        `${plain(pick(FIRST))}.${plain(pick(LAST))}${randomInt(100)}@${environment.emailDomain}`,
      ),
    company: () => `${pick(COMPANY)} ${pick(SUFFIX)}`,
    phone: () =>
      `+1 555 ${String(randomInt(1000)).padStart(3, "0")} ${String(randomInt(10000)).padStart(4, "0")}`,
    city: () => pick(CITIES),
  };

  /** An environment value: `__ENV_PREFIX__VAR_<NAME>` wins over the generated default. */
  env(name: string): string {
    const value = process.env[`__ENV_PREFIX__VAR_${name}`] ?? environment.vars[name];
    if (value === undefined) {
      throw new Error(`{{env.${name}}} is not set: set __ENV_PREFIX__VAR_${name}.`);
    }
    return value;
  }

  #email(address: string): string {
    this.emails.push(address);
    return address;
  }
}

// ── Secrets ─────────────────────────────────────────────────────────────────
// Read from environment variables of the same name when typed, and typed only
// on pages whose host is allowed and on the secret's own domains. Playwright's
// own trace records what is typed (and the page's requests), so treat traces
// of tests that type secrets as private.

export class Secrets {
  async fill(locator: Locator, name: string): Promise<void> {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Secret ${name} is not set. Set the ${name} environment variable.`);
    }
    const domains = environment.secrets[name] ?? [];
    const frameUrl = await locator.evaluate(() => location.href);
    if (!isAllowed(frameUrl) || !allows(domains, frameUrl)) {
      throw new Error(
        `Secret ${name} may not be typed into ${new URL(frameUrl).host || frameUrl}; it is allowed on: ${domains.join(", ") || "no domains"}.`,
      );
    }
    await locator.fill(value);
  }
}

// ── Network checks ──────────────────────────────────────────────────────────

interface SeenResponse {
  seq: number;
  method: string;
  url: string;
  status: number;
}

export interface ResponseMatch {
  method: string;
  /** A path (`/api/projects`, `*` and `**` allowed) or a full URL. */
  url: string;
  status?: number;
}

function matchesUrl(pattern: string, url: string): boolean {
  const parsed = new URL(url);
  const subject = /^[a-z]+:\/\//i.test(pattern)
    ? `${parsed.origin}${parsed.pathname}`
    : parsed.pathname;
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((part) =>
      part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}/?$`).test(subject);
}

export class Network {
  readonly #seen: SeenResponse[] = [];
  #seq = 0;
  #mark = 0;

  constructor(page: Page) {
    page.on("response", (response) => {
      this.#seen.push({
        seq: ++this.#seq,
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
      });
    });
  }

  /** Starts a new action step: later checks look at responses from here on. */
  mark(): void {
    this.#mark = this.#seq;
  }

  /** Waits for a matching response since the current action step began. */
  async expectResponse(match: ResponseMatch, options: { soft?: boolean } = {}): Promise<void> {
    const name = `${match.method} ${match.url}${match.status ? ` → ${match.status}` : ""}`;
    const found = () =>
      this.#seen.some(
        (seen) =>
          seen.seq > this.#mark &&
          seen.method === match.method.toUpperCase() &&
          (match.status === undefined || seen.status === match.status) &&
          matchesUrl(match.url, seen.url),
      );
    await expect
      .configure({ soft: options.soft ?? false })
      .poll(found, { message: `a response to ${name}` })
      .toBe(true);
  }
}

// ── Email inbox ─────────────────────────────────────────────────────────────
// Reads the newest email sent to an address this test generated, from a
// Mailpit server (__ENV_PREFIX__MAILPIT_URL, e.g. http://127.0.0.1:8025).

export class Inbox {
  readonly #request: APIRequestContext;
  readonly #values: Values;

  constructor(request: APIRequestContext, values: Values) {
    this.#request = request;
    this.#values = values;
  }

  /** The verification code in the newest email (4 to 8 digits). */
  async code(): Promise<string> {
    return this.#find("code", (text) => /\b(\d{4,8})\b/.exec(text)?.[1]);
  }

  /** The first link in the newest email. */
  async link(): Promise<string> {
    return this.#find("link", (text) => /https?:\/\/[^\s"'<>]+/.exec(text)?.[0]);
  }

  async #find(what: string, extract: (text: string) => string | undefined): Promise<string> {
    const server = process.env.__ENV_PREFIX__MAILPIT_URL;
    base.skip(!server, `Reading the email ${what} needs an inbox: set __ENV_PREFIX__MAILPIT_URL.`);
    const to = this.#values.emails.at(-1);
    if (!to) throw new Error(`No email address was generated in this test to read a ${what} for.`);
    let found: string | undefined;
    await expect
      .poll(
        async () => {
          const search = await this.#request.get(`${server}/api/v1/search`, {
            params: { query: `to:"${to}"`, limit: 1 },
          });
          const { messages = [] } = (await search.json()) as { messages?: Array<{ ID: string }> };
          const newest = messages[0];
          if (!newest) return undefined;
          const message = await this.#request.get(`${server}/api/v1/message/${newest.ID}`);
          const { Text = "" } = (await message.json()) as { Text?: string };
          found = extract(Text);
          return found;
        },
        { message: `an email to ${to} with a ${what}`, timeout: 30_000 },
      )
      .toBeTruthy();
    return found as string;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** For `toHaveURL`: the page's path is `route` (`:id` matches ids; no query, no trailing slash). */
export function route(pattern: string): (url: URL) => boolean {
  const id = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
  return (url) => {
    const segments = url.pathname.split("/").filter(Boolean);
    const expected = pattern.split("/").filter(Boolean);
    return (
      segments.length === expected.length &&
      expected.every(
        (part, i) => part === segments[i] || (part === ":id" && id.test(segments[i] ?? "")),
      )
    );
  };
}

/** A pattern matching text that contains `text`. */
export function containing(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/** Waits until the number of matches is within the range. */
export async function expectCount(
  locator: Locator,
  range: { min?: number; max?: number },
  options: { soft?: boolean } = {},
): Promise<void> {
  const check = expect.configure({ soft: options.soft ?? false });
  if (range.min !== undefined)
    await check.poll(() => locator.count()).toBeGreaterThanOrEqual(range.min);
  if (range.max !== undefined)
    await check.poll(() => locator.count()).toBeLessThanOrEqual(range.max);
}

/**
 * Uploads files given relative to this folder; they must be inside the tests
 * folder. Works for file inputs and for buttons that open a file chooser.
 */
export async function upload(locator: Locator, files: string[]): Promise<void> {
  const here = dirname(base.info().file);
  const root = realpathSync(resolve(here, ".."));
  const paths = files.map((file) => {
    const real = realpathSync(resolve(here, file));
    const inside = relative(root, real);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`${file} is outside the tests folder.`);
    }
    return real;
  });
  const isFileInput = await locator.evaluate(
    (element) => element.tagName === "INPUT" && element.getAttribute("type") === "file",
  );
  if (isFileInput) {
    await locator.setInputFiles(paths);
    return;
  }
  const [chooser] = await Promise.all([
    locator.page().waitForEvent("filechooser"),
    locator.click(),
  ]);
  await chooser.setFiles(paths);
}

/** Notes a check or rule that only __NAME__ evaluates; it never passes or fails this spec. */
export function checkedBy__PASCAL__(line: string, reason: string): void {
  base.info().annotations.push({
    type: "__SLUG__",
    description: `${line} (checked by __NAME__ only: ${reason})`,
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

export interface Fixtures {
  /** Aborts every request to a host outside the allowed domains (automatic). */
  allowlist: { refused: string[] };
  values: Values;
  secrets: Secrets;
  network: Network;
  inbox: Inbox;
}

export const test = base.extend<Fixtures>({
  allowlist: [
    async ({ context }, use) => {
      const refused: string[] = [];
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (isAllowed(url)) return route.fallback();
        refused.push(url);
        return route.abort("blockedbyclient");
      });
      await context.routeWebSocket(/.*/, (socket) => {
        if (isAllowed(socket.url())) return socket.connectToServer();
        refused.push(socket.url());
        return socket.close();
      });
      context.on("page", (page) => {
        page.on("framenavigated", (frame) => {
          const url = frame.url();
          if (frame !== page.mainFrame() || url === "about:blank" || isAllowed(url)) return;
          refused.push(url);
          void page.goto("about:blank").catch(() => {});
        });
      });
      await use({ refused });
    },
    { auto: true },
  ],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
  values: async ({}, use) => {
    await use(new Values());
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
  secrets: async ({}, use) => {
    await use(new Secrets());
  },
  network: async ({ page }, use) => {
    await use(new Network(page));
  },
  inbox: async ({ request, values }, use) => {
    await use(new Inbox(request, values));
  },
});
