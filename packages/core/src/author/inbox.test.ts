import { createInboxValues, type Inbox, type InboxMessage } from "@optestra/auth";
import { Redactor } from "@optestra/config/node";
import { prepareSecret } from "@optestra/config/reveal";
import { expandTest, mapReader, parseTest } from "@optestra/spec";
import { describe, expect, it } from "vitest";
import { createTestInbox, inboxAddressFor, prepareInbox } from "./inbox.js";
import { describeVariables, harnessValue, stepVariables, withInbox } from "./variables.js";

// The test inbox in an attempt (AUTH-1): which address is read, how misses are
// classified, and that a code only ever reaches the harness (never a prompt).

const CODE = "482913";

async function test(
  body: string,
  frontmatter = 'name: T\nstart: /signup\ndata:\n  email: "{{unique.email}}"',
) {
  const text = `---\n${frontmatter}\n---\n\n${body}\n`;
  const { spec } = parseTest(text, "tests/t.test.md");
  return expandTest(spec, { readFile: mapReader({ "tests/t.test.md": text }), seed: "s" });
}

function fakeInbox(
  messages: (to: string) => InboxMessage | undefined,
): Inbox & { waits: string[] } {
  const waits: string[] = [];
  return {
    provider: "mailpit",
    host: "127.0.0.1:8025",
    emailDomain: "example.test",
    waits,
    address: async () => ({ ok: true, address: "x@example.test" }),
    async waitForMessage({ to }) {
      waits.push(to);
      const message = messages(to);
      return message
        ? { ok: true, message }
        : { ok: false, reason: "timeout", message: `No email to ${to} in 1 s.` };
    },
    check: async () => ({ ok: true, provider: "mailpit", host: "x", status: "ok", message: "" }),
  };
}

const mail = (to: string, text: string): InboxMessage => ({
  id: "1",
  from: "shop@example.test",
  to: [to],
  subject: "Your verification code",
  text,
  html: "",
  receivedAt: new Date().toISOString(),
});

function runtime(inbox: Inbox, redactor = new Redactor()) {
  const allowedDomains = ["127.0.0.1", "shop.example.test"];
  return createTestInbox({
    values: createInboxValues({ inbox, allowedDomains, timeoutMs: 1000, redactor }),
    provider: inbox.provider,
    allowedDomains,
    since: new Date(Date.now() - 1000),
    redactor,
  });
}

describe("the test inbox in an attempt", () => {
  it("reads the email sent to the test's generated address, and types the code only in the harness", async () => {
    const t = await test(
      '1. Fill "Email" with {{data.email}}\n2. Enter the code from the verification email',
    );
    const to = inboxAddressFor(t, t.steps[1] as never);
    expect(to).toMatch(/^test-[a-z0-9]{10}@example\.test$/);
    const inbox = fakeInbox((address) => mail(address, `Your code is ${CODE}.`));
    const redactor = new Redactor();
    const run = runtime(inbox, redactor);
    const read = await prepareInbox(run, t, t.steps[1] as never, "code");
    expect(read).toMatchObject({ ok: true, to });
    expect(inbox.waits).toEqual([to]);
    // The session's INBOX_CODE secret produces the code from the same (cached) email.
    const secret = run.secrets.INBOX_CODE;
    if (!secret) throw new Error("no INBOX_CODE secret");
    expect(await prepareSecret(secret)).toBe(CODE);
    expect(inbox.waits).toHaveLength(1);
    expect(redactor.redact(`typed ${CODE}`)).toBe("typed [secret:INBOX_CODE]");
  });

  it("blocks when no email comes (our inbox, not the app), fails when the email has no code", async () => {
    const t = await test("1. Enter the code from the verification email");
    const step = t.steps[0] as never;
    expect(await prepareInbox(runtime(fakeInbox(() => undefined)), t, step, "code")).toMatchObject({
      ok: false,
      outcome: "blocked",
      reason: "inbox_unavailable",
      message: expect.stringMatching(/arrived in time/),
    });
    const noCode = runtime(fakeInbox((to) => mail(to, "Welcome! Nothing to enter here.")));
    expect(await prepareInbox(noCode, t, step, "code")).toMatchObject({
      ok: false,
      outcome: "failed",
      reason: "no_code",
    });
    // Without an inbox, or without an address, it can't be read: blocked.
    expect(await prepareInbox(undefined, t, step, "code")).toMatchObject({
      outcome: "blocked",
      reason: "inbox_unavailable",
    });
    const noAddress = await test("1. Enter the code from the verification email", "name: T");
    expect(
      await prepareInbox(
        runtime(fakeInbox(() => undefined)),
        noAddress,
        noAddress.steps[0] as never,
        "code",
      ),
    ).toMatchObject({ outcome: "blocked", message: expect.stringMatching(/no email address/) });
  });

  it("refuses a magic link to a host outside the allowed domains (SAF-1)", async () => {
    const t = await test("1. Open the link in the verification email");
    const inbox = fakeInbox((to) =>
      mail(to, "Sign in: https://evil.example.com/magic?token=abc123"),
    );
    expect(await prepareInbox(runtime(inbox), t, t.steps[0] as never, "link")).toMatchObject({
      ok: false,
      outcome: "blocked",
      reason: "disallowed_domain",
      message: expect.stringMatching(/evil\.example\.com/),
    });
    const good = fakeInbox((to) =>
      mail(to, "Sign in: https://shop.example.test/magic?token=abc123"),
    );
    const run = runtime(good);
    expect(await prepareInbox(run, t, t.steps[0] as never, "link")).toMatchObject({ ok: true });
    expect(await prepareSecret(run.secrets.INBOX_LINK as never)).toBe(
      "https://shop.example.test/magic?token=abc123",
    );
  });
});

describe("inbox values in a step's variables", () => {
  it("are handles: typed as {{inbox.code}} only after read_inbox, never with a value", async () => {
    const t = await test("1. Enter the code from the verification email");
    const variables = stepVariables(t, t.steps[0] as never);
    expect(harnessValue("{{inbox.code}}", variables)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/read_inbox/),
    });
    const ready = withInbox(variables, "code");
    expect(harnessValue("{{inbox.code}}", ready)).toEqual({
      ok: true,
      value: { secret: "INBOX_CODE" },
    });
    expect(harnessValue("code: {{inbox.code}}", ready)).toMatchObject({ ok: false });
    expect(describeVariables(ready)).toContain(
      "{{inbox.code}} = (from the test inbox, never shown",
    );
  });

  it("are ready when the step names them itself", async () => {
    const t = await test('1. Fill "Code" with {{inbox.code}}');
    const variables = stepVariables(t, t.steps[0] as never);
    expect(variables.inbox).toEqual(["code"]);
    expect(variables.unresolved).toEqual([]);
    expect(harnessValue("{{inbox.code}}", variables)).toMatchObject({ ok: true });
  });
});
