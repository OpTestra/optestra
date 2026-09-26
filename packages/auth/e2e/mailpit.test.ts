import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENV_PREFIX } from "@testament/config";
import { createSecretValue, loadProject, Redactor } from "@testament/config/node";
import { verificationCode, startShop, type RunningShop } from "@testament/fixture-shop";
import {
  launchBrowser,
  type LaunchedBrowser,
  type Observation,
  openSession,
  renderForModel,
} from "@testament/browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProfiles, createInbox, createInboxValues, inboxSecret } from "@testament/auth";

// SEC-5 end to end: the shop sends its sign-up code to a real Mailpit over SMTP; the
// browser harness signs up, and the code is read through the Mailpit adapter and
// typed like a secret. CI runs Mailpit as a service (REQUIRE_MAILPIT=1 makes a
// missing Mailpit a failure there). Locally it is skipped when Mailpit isn't running:
//   docker run -d -p 8025:8025 -p 1025:1025 axllent/mailpit

const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
const MAILPIT_SMTP = process.env.MAILPIT_SMTP ?? "127.0.0.1:1025";

// The shop's own project file (bench/fixtures/shop) configures the inbox; CI may move Mailpit.
const shopDir = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const project = loadProject(shopDir, { env: { [`${ENV_PREFIX}INBOX_MAILPIT_URL`]: MAILPIT_URL } });
const created = createInbox(project.config);
if (!created.ok) throw new Error(`the shop's inbox settings: ${created.message}`);
const inbox = created.inbox;
const allowedDomains = project.environment?.settings.allowedDomains ?? [];
const check = await inbox.check();
if (!check.ok) {
  const message = `Mailpit is not running at ${MAILPIT_URL} (${check.message}). Start it with: docker run -d -p 8025:8025 -p 1025:1025 axllent/mailpit`;
  if (process.env.REQUIRE_MAILPIT) throw new Error(message);
  process.stderr.write(`\nSkipping the Mailpit e2e: ${message}\n\n`);
}

const PASSWORD = "shop-demo-pass";

function find(page: Observation, role: string, name: string): string {
  const match = page.elements.find((e) => e.role === role && e.name === name);
  if (!match?.ref) throw new Error(`no ${role} "${name}" in:\n${renderForModel(page)}`);
  return match.ref;
}

describe("the shop's project settings", () => {
  it("configure Mailpit, and the ada profile's login flow exists", () => {
    expect(project.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(project.config.inbox.provider).toBe("mailpit");
    expect(inbox.emailDomain).toBe("example.test");
    expect(
      checkProfiles(project.config.auth, (flow) => existsSync(`${shopDir}tests/${flow}`)),
    ).toEqual([]);
  });
});

describe.skipIf(!check.ok)("sign-up email code through Mailpit", () => {
  let browser: LaunchedBrowser;
  let shop: RunningShop;
  beforeAll(async () => {
    browser = await launchBrowser();
    shop = await startShop({ variant: "correct", port: 0, mailpitSmtp: MAILPIT_SMTP });
  });
  afterAll(async () => {
    await shop?.stop();
    await browser?.close();
  });

  it("signs up, reads the verification code from Mailpit and types it like a secret", async () => {
    const address = await inbox.address(`signup-${Date.now()}`);
    if (!address.ok) throw new Error(address.message);
    const email = address.address;
    const redactor = new Redactor();
    const values = createInboxValues({ inbox, allowedDomains, timeoutMs: 15_000, redactor });
    let since = new Date();
    const session = await openSession({
      browser,
      baseUrl: shop.url,
      allowedDomains,
      secrets: {
        SHOP_PASSWORD: createSecretValue("SHOP_PASSWORD", PASSWORD, {
          domains: ["127.0.0.1"],
          redactor,
        }),
        // Opened before the email exists; the code is read when it is typed.
        INBOX_CODE: inboxSecret(values, "code", () => ({ to: email, since }), {
          allowedDomains,
          redactor,
        }),
      },
      redact: (text) => redactor.redact(text),
      evidence: { trace: true, console: true, network: true },
    });
    const outputs: unknown[] = [];
    const act = async (action: Parameters<typeof session.act>[0]) => {
      const outcome = await session.act(action);
      outputs.push(outcome);
      if (outcome.status !== "ok")
        throw new Error(`${action.type}: ${outcome.status} ${outcome.message}`);
      return outcome;
    };

    await act({ type: "goto", url: "/signup" });
    let page = await session.observe();
    await act({ type: "fill", target: { ref: find(page, "textbox", "Email") }, value: email });
    await act({
      type: "fill",
      target: { ref: find(page, "textbox", "Password") },
      value: { secret: "SHOP_PASSWORD" },
    });
    since = new Date();
    await act({ type: "click", target: { ref: find(page, "button", "Sign up") } });
    page = await session.observe();
    find(page, "heading", "Check your email");
    await act({
      type: "fill",
      target: { ref: find(page, "textbox", "Verification code") },
      value: { secret: "INBOX_CODE" },
    });
    page = await session.observe();
    outputs.push(page, renderForModel(page));
    const verified = await act({ type: "click", target: { ref: find(page, "button", "Verify") } });
    expect(verified.post.urlAfter).toContain("/dashboard");
    find(await session.observe(), "heading", "Dashboard");

    // The same code, read and extracted through the adapter, is the shop's code.
    const code = verificationCode(email);
    const direct = await values.get("code", { to: email, since });
    expect(direct.ok && String(direct.value)).toBe("[secret:INBOX_CODE]");
    const subject = await values.get("subject", { to: email, since });
    expect(subject.ok && subject.value).toBe("Your Acme Shop verification code");

    // The code is in no output or text evidence.
    const closed = await session.close();
    outputs.push(closed);
    expect(JSON.stringify(outputs)).not.toContain(code);
    for (const file of closed.evidence) {
      if (file.kind === "trace" || file.kind === "video") continue; // zip / pixels
      expect(readFileSync(file.path, "utf8"), file.kind).not.toContain(code);
    }
  });
});
