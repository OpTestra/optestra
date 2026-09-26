import { createSecretValue, memorySource, Redactor } from "@testament/config/node";
import { prepareSecret, revealSecret } from "@testament/config/reveal";
import { afterEach, describe, expect, it } from "vitest";
import "../index.js";
import type { InboxSettings } from "../section.js";
import { createInbox, inboxEmailDomain } from "./create.js";
import {
  type FakeServer,
  fakeMailosaur,
  fakeMailpit,
  fakeMailslurp,
} from "./fake-servers.test.helpers.js";
import { createMailpitInbox } from "./mailpit.js";
import { createInboxTransport, type FetchLike } from "./transport.js";
import { createInboxValues, InboxValueError, inboxSecret } from "./values.js";

const servers: FakeServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});
async function track(server: Promise<FakeServer>): Promise<FakeServer> {
  const s = await server;
  servers.push(s);
  return s;
}

const KEY = "inbox-key-planted-5521";
const SHOP_MAIL = {
  from: "no-reply@acme-shop.localhost",
  subject: "Your Acme Shop verification code",
  text: "Your verification code is 482913.\n\nEnter it on the sign-up page to finish creating your account.",
};

function settings(patch: Partial<InboxSettings>): InboxSettings {
  return {
    provider: "none",
    timeoutSeconds: 5,
    mailpit: { url: "http://127.0.0.1:8025", domain: "example.test" },
    mailosaur: { baseUrl: "https://mailosaur.com", keySecret: "MAILOSAUR_API_KEY" },
    mailslurp: { baseUrl: "https://api.mailslurp.com", keySecret: "MAILSLURP_API_KEY" },
    ...patch,
  };
}

const sources = (values: Record<string, string>) => [
  memorySource(values, {}, { redactor: new Redactor() }),
];

describe("the inbox transport (the one network file)", () => {
  it("refuses any host but the configured one, before sending", async () => {
    let called = 0;
    const fetch: FetchLike = async () => {
      called++;
      return new Response("{}");
    };
    const transport = createInboxTransport("http://127.0.0.1:8025", { fetch });
    const other = await transport.request({
      method: "GET",
      path: "http://evil.example/api/v1/info",
      timeoutMs: 1000,
    });
    expect(other).toMatchObject({ kind: "error", reason: "blocked" });
    const scheme = await transport.request({
      method: "GET",
      path: "https://127.0.0.1:8025/x",
      timeoutMs: 1000,
    });
    expect(scheme).toMatchObject({ kind: "error", reason: "blocked" });
    expect(called).toBe(0);
  });

  it("never follows redirects and turns network errors into typed results", async () => {
    let init: RequestInit | undefined;
    const fetch: FetchLike = async (_url, i) => {
      init = i;
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    };
    const result = await createInboxTransport("http://127.0.0.1:1", { fetch }).request({
      method: "GET",
      path: "/",
      timeoutMs: 1000,
    });
    expect(init?.redirect).toBe("error");
    expect(result).toEqual({
      kind: "error",
      reason: "unavailable",
      message: "cannot reach 127.0.0.1:1: ECONNREFUSED",
    });
  });
});

describe("Mailpit", () => {
  it("finds the newest message to an address and reads it", async () => {
    const server = await track(fakeMailpit());
    const inbox = createMailpitInbox({ url: server.url, domain: "example.test", pollMs: 50 });
    expect(inbox.emailDomain).toBe("example.test");
    const address = await inbox.address("Ada Lovelace");
    expect(address).toEqual({ ok: true, address: "ada-lovelace@example.test" });
    const since = new Date();
    server.deliver({ ...SHOP_MAIL, to: "someone-else@example.test" });
    server.deliver({ ...SHOP_MAIL, to: "ada-lovelace@example.test" }, 200);
    const got = await inbox.waitForMessage({
      to: "ADA-lovelace@example.test",
      since,
      timeoutMs: 3000,
    });
    expect(got.ok && got.message).toMatchObject({
      to: ["ada-lovelace@example.test"],
      subject: SHOP_MAIL.subject,
      text: SHOP_MAIL.text,
    });
    expect((await inbox.check()).status).toBe("ok");
  });

  it("times out with a typed miss, and reports Mailpit down as unavailable", async () => {
    const server = await track(fakeMailpit());
    const inbox = createMailpitInbox({ url: server.url, domain: "example.test", pollMs: 50 });
    const miss = await inbox.waitForMessage({
      to: "nobody@example.test",
      since: new Date(),
      timeoutMs: 300,
    });
    expect(miss).toMatchObject({ ok: false, reason: "timeout" });
    // An old message doesn't count.
    server.deliver({ ...SHOP_MAIL, to: "old@example.test" });
    const old = server.mails[0];
    if (old) old.receivedAt = "2020-01-01T00:00:00Z";
    expect(
      await inbox.waitForMessage({ to: "old@example.test", since: new Date(), timeoutMs: 200 }),
    ).toMatchObject({ ok: false, reason: "timeout" });
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    const down = await inbox.waitForMessage({
      to: "a@example.test",
      since: new Date(),
      timeoutMs: 300,
    });
    expect(down).toMatchObject({ ok: false, reason: "unavailable" });
    expect(down.ok === false && down.fix).toContain("axllent/mailpit");
    expect((await inbox.check()).status).toBe("unavailable");
  });
});

describe("Mailosaur", () => {
  it("long-polls with the key as basic auth, only to its host", async () => {
    const server = await track(fakeMailosaur(KEY, "srv1"));
    const created = createInbox(
      {
        secrets: {},
        inbox: settings({
          provider: "mailosaur",
          mailosaur: { baseUrl: server.url, serverId: "srv1", keySecret: "MAILOSAUR_API_KEY" },
        }),
      },
      { sources: sources({ MAILOSAUR_API_KEY: KEY }) },
    );
    if (!created.ok) throw new Error(created.message);
    const inbox = created.inbox;
    expect(inbox.emailDomain).toBe("srv1.mailosaur.net");
    const address = await inbox.address("signup");
    expect(address).toEqual({ ok: true, address: "signup@srv1.mailosaur.net" });
    const since = new Date();
    server.deliver({ ...SHOP_MAIL, to: "signup@srv1.mailosaur.net" }, 150);
    const got = await inbox.waitForMessage({
      to: "signup@srv1.mailosaur.net",
      subjectContains: "verification",
      since,
      timeoutMs: 3000,
    });
    expect(got.ok && got.message.text).toContain("482913");
    expect((await inbox.check()).status).toBe("ok");
    expect(
      await inbox.waitForMessage({ to: "x@srv1.mailosaur.net", since: new Date(), timeoutMs: 200 }),
    ).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("a wrong key is unauthorized; a missing key or server id is reported before any call", async () => {
    const server = await track(fakeMailosaur(KEY, "srv1"));
    const config = (serverId?: string) => ({
      secrets: {},
      inbox: settings({
        provider: "mailosaur",
        mailosaur: {
          baseUrl: server.url,
          ...(serverId && { serverId }),
          keySecret: "MAILOSAUR_API_KEY",
        },
      }),
    });
    const wrong = createInbox(config("srv1"), { sources: sources({ MAILOSAUR_API_KEY: "nope" }) });
    if (!wrong.ok) throw new Error(wrong.message);
    const check = await wrong.inbox.check();
    expect(check).toMatchObject({ ok: false, status: "unauthorized" });
    expect(check.fix).toContain("MAILOSAUR_API_KEY");
    expect(
      await wrong.inbox.waitForMessage({
        to: "a@srv1.mailosaur.net",
        since: new Date(),
        timeoutMs: 200,
      }),
    ).toMatchObject({ ok: false, reason: "unauthorized" });
    const before = server.requests.length;
    expect(createInbox(config("srv1"), { sources: sources({}) })).toMatchObject({
      ok: false,
      reason: "unauthorized",
      message: "The inbox API key MAILOSAUR_API_KEY is not set.",
    });
    expect(createInbox(config(), { sources: sources({ MAILOSAUR_API_KEY: KEY }) })).toMatchObject({
      ok: false,
      reason: "not_configured",
    });
    expect(server.requests.length).toBe(before);
  });

  it("refuses to send a declared key to a host outside its domains", () => {
    const created = createInbox(
      {
        secrets: { MAILOSAUR_API_KEY: { domains: ["mailosaur.com"] } },
        inbox: settings({
          provider: "mailosaur",
          mailosaur: {
            baseUrl: "https://mail.evil.example",
            serverId: "srv1",
            keySecret: "MAILOSAUR_API_KEY",
          },
        }),
      },
      { sources: sources({ MAILOSAUR_API_KEY: KEY }) },
    );
    expect(created).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(created.ok === false && created.message).toContain("mail.evil.example");
  });
});

describe("MailSlurp", () => {
  it("creates an inbox for an address and waits for its latest email", async () => {
    const server = await track(fakeMailslurp(KEY));
    const created = createInbox(
      {
        secrets: {},
        inbox: settings({
          provider: "mailslurp",
          mailslurp: { baseUrl: server.url, keySecret: "MAILSLURP_API_KEY" },
        }),
      },
      { sources: sources({ MAILSLURP_API_KEY: KEY }) },
    );
    if (!created.ok) throw new Error(created.message);
    const { inbox } = created;
    expect(inbox.emailDomain).toBeUndefined();
    const address = await inbox.address();
    if (!address.ok) throw new Error(address.message);
    expect(address.address).toBe("inbox-1@mailslurp.biz");
    const since = new Date();
    server.deliver({ ...SHOP_MAIL, to: address.address, html: `<p>${SHOP_MAIL.text}</p>` }, 150);
    const got = await inbox.waitForMessage({ to: address.address, since, timeoutMs: 3000 });
    expect(got.ok && got.message.html).toContain("482913");
    expect(got.ok && got.message.text).toBe("");
    expect(server.requests.every((r) => r.headers["x-api-key"] === KEY)).toBe(true);
    expect((await inbox.check()).status).toBe("ok");
    // An address that isn't one of the account's inboxes is a typed miss.
    expect(
      await inbox.waitForMessage({ to: "nobody@mailslurp.biz", since, timeoutMs: 200 }),
    ).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("reports provider trouble as unavailable, never throwing", async () => {
    const server = await track(fakeMailslurp(KEY));
    const created = createInbox(
      {
        secrets: {},
        inbox: settings({
          provider: "mailslurp",
          mailslurp: { baseUrl: server.url, keySecret: "MAILSLURP_API_KEY" },
        }),
      },
      { sources: sources({ MAILSLURP_API_KEY: KEY }) },
    );
    if (!created.ok) throw new Error(created.message);
    server.fail(503);
    expect(await created.inbox.address()).toMatchObject({ ok: false, reason: "unavailable" });
    expect((await created.inbox.check()).status).toBe("unavailable");
  });
});

describe("createInbox and the email domain (ENV-3)", () => {
  it("none is not_configured; each provider has its domain", () => {
    expect(createInbox({ secrets: {}, inbox: settings({}) })).toMatchObject({
      ok: false,
      reason: "not_configured",
    });
    expect(inboxEmailDomain(settings({ provider: "mailpit" }))).toBe("example.test");
    expect(
      inboxEmailDomain(
        settings({
          provider: "mailosaur",
          mailosaur: { baseUrl: "https://mailosaur.com", serverId: "abc123", keySecret: "K" },
        }),
      ),
    ).toBe("abc123.mailosaur.net");
    expect(inboxEmailDomain(settings({ provider: "mailslurp" }))).toBeUndefined();
    expect(inboxEmailDomain(settings({}))).toBeUndefined();
  });
});

describe("InboxValues ({{inbox.code}}, {{inbox.link}}, {{inbox.subject}})", () => {
  it("returns the code and link as secrets typed only on allowed domains, from one message", async () => {
    const server = await track(fakeMailpit());
    const inbox = createMailpitInbox({ url: server.url, domain: "example.test", pollMs: 50 });
    const redactor = new Redactor();
    const values = createInboxValues({
      inbox,
      allowedDomains: ["127.0.0.1"],
      timeoutMs: 2000,
      redactor,
    });
    const since = new Date();
    server.deliver({
      to: "ada@example.test",
      from: "no-reply@acme.test",
      subject: "Verify your email",
      text: "Your code is 482913.\nOr click http://127.0.0.1:4100/verify?token=tok-99812 to verify.",
    });
    const lookup = { to: "ada@example.test", since };
    const code = await values.get("code", lookup);
    const link = await values.get("link", lookup);
    const subject = await values.get("subject", lookup);
    if (!code.ok || !link.ok || !subject.ok) throw new Error("expected values");
    expect(code.member).toBe("code");
    expect(String(code.value)).toBe("[secret:INBOX_CODE]");
    expect(typeof code.value !== "string" && revealSecret(code.value)).toBe("482913");
    expect(typeof code.value !== "string" && code.value.domains).toEqual(["127.0.0.1"]);
    expect(typeof link.value !== "string" && revealSecret(link.value)).toBe(
      "http://127.0.0.1:4100/verify?token=tok-99812",
    );
    expect(subject.value).toBe("Verify your email");
    // Code and link are registered: no log can show them.
    expect(
      redactor.redact(
        "typed 482913 then opened tok-99812 at http://127.0.0.1:4100/verify?token=tok-99812",
      ),
    ).not.toMatch(/482913|verify\?token/);
    // One wait for all three.
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/message/"))).toHaveLength(1);
    expect(JSON.stringify({ code, link })).not.toMatch(/482913|tok-99812/);
  });

  it("refuses a link to a host outside allowedDomains and reports missing codes", async () => {
    const server = await track(fakeMailpit());
    const inbox = createMailpitInbox({ url: server.url, domain: "example.test", pollMs: 50 });
    const values = createInboxValues({ inbox, allowedDomains: ["127.0.0.1"], timeoutMs: 1000 });
    server.deliver({
      to: "bo@example.test",
      from: "no-reply@acme.test",
      subject: "Sign in",
      text: "Sign in with this magic link: https://login.evil.example/magic?token=abc",
    });
    const lookup = { to: "bo@example.test", since: new Date(Date.now() - 1000) };
    expect(await values.get("link", lookup)).toMatchObject({
      ok: false,
      reason: "link_not_allowed",
    });
    expect(await values.get("code", lookup)).toMatchObject({ ok: false, reason: "no_code" });
    expect(await values.get("body", lookup)).toMatchObject({ ok: false, reason: "unknown_member" });
    expect(
      await values.get("code", { to: "none@example.test", since: new Date(), timeoutMs: 200 }),
    ).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("never lets the inbox key reach a log or a result", async () => {
    const server = await track(fakeMailosaur(KEY, "srv1"));
    const key = createSecretValue("MAILOSAUR_API_KEY", KEY);
    const created = createInbox(
      {
        secrets: {},
        inbox: settings({
          provider: "mailosaur",
          mailosaur: { baseUrl: server.url, serverId: "srv1", keySecret: "MAILOSAUR_API_KEY" },
        }),
      },
      {
        sources: [
          { name: "test", get: (name) => (name === "MAILOSAUR_API_KEY" ? key : undefined) },
        ],
      },
    );
    if (!created.ok) throw new Error(created.message);
    const results = [
      await created.inbox.check(),
      await created.inbox.waitForMessage({
        to: "a@srv1.mailosaur.net",
        since: new Date(),
        timeoutMs: 100,
      }),
      created,
    ];
    const { defaultRedactor } = await import("@testament/config/node");
    const text = JSON.stringify(results);
    expect(text).not.toContain(KEY);
    const header = server.requests[0]?.headers.authorization ?? "";
    expect(defaultRedactor.redact(`auth: ${header}`)).not.toContain(header.slice(6));
  });
});

describe("inboxSecret (a session secret whose value arrives by email)", () => {
  it("reads the code at typing time, registers it, and fails typed when there is none", async () => {
    const server = await track(fakeMailpit());
    const inbox = createMailpitInbox({ url: server.url, domain: "example.test", pollMs: 50 });
    const redactor = new Redactor();
    const values = createInboxValues({ inbox, allowedDomains: ["127.0.0.1"], timeoutMs: 2000 });
    let lookup = { to: "cy@example.test", since: new Date() };
    const secret = inboxSecret(values, "code", () => lookup, {
      allowedDomains: ["127.0.0.1"],
      redactor,
    });
    expect(String(secret)).toBe("[secret:INBOX_CODE]");
    expect(secret.dynamic).toBe(true);
    expect(secret.domains).toEqual(["127.0.0.1"]);
    // Opened before the email exists; the code is fetched when it is typed.
    server.deliver({ ...SHOP_MAIL, to: "cy@example.test" }, 150);
    expect(await prepareSecret(secret)).toBe("482913");
    expect(redactor.redact("typed 482913")).toBe("typed [secret:INBOX_CODE]");
    lookup = { to: "nobody@example.test", since: new Date() };
    const miss = await prepareSecret(
      inboxSecret(values, "code", () => ({ ...lookup, timeoutMs: 200 }), { allowedDomains: [] }),
    ).catch((error: unknown) => error);
    expect(miss).toBeInstanceOf(InboxValueError);
    expect((miss as InboxValueError).failure.reason).toBe("timeout");
  });
});
