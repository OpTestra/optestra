import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxValues } from "@optestra/auth";
import { brand } from "@optestra/brand";
import { launchBrowser, openSession } from "@optestra/browser";
import { ENV_PREFIX } from "@optestra/config";
import { readRun } from "@optestra/contract/node";
import { shopInbox, startShop, type Variant, verificationCode } from "@optestra/fixture-shop";
import { afterAll, describe, expect, it } from "vitest";
import { readZip } from "../../browser/src/zip.js";
import { createTestInbox } from "../src/author/inbox.js";
import { agentScript, promptText, scriptedModels } from "../src/author/test-kit.test-support.js";
import { type RunTestsOptions, runTests } from "../src/run/runner.js";

// AUTH-1 end to end, on the real shop in a real browser: tests start logged in
// from a saved session (SEC-3), email codes are read from a test inbox and typed
// by the harness (SEC-5), TOTP codes too (SEC-4); none of these values reach a
// prompt, a recording, an event, a report or the evidence.

const SHOP = new URL("../../../bench/fixtures/shop/", import.meta.url).pathname;
const PASSWORD = "shop-demo-pass";
const TOTP_SEED = "JBSWY3DPEHPK3PXPJBSWY3DP";
const projects: string[] = [];

afterAll(() => {
  for (const dir of projects) rmSync(dir, { recursive: true, force: true });
});

/** A private copy of the shop project with its committed recordings; `edit` changes its project file. */
function project(edit: (config: string) => string = (config) => config): string {
  const dir = mkdtempSync(join(tmpdir(), "auth-e2e-"));
  projects.push(dir);
  const config = readFileSync(join(SHOP, brand.configFileName), "utf8");
  writeFileSync(join(dir, brand.configFileName), edit(config));
  cpSync(join(SHOP, "tests"), join(dir, "tests"), {
    recursive: true,
    filter: (source) => !/\.ts$/.test(source),
  });
  return dir;
}

/** Every text the run wrote (events, results, logs, HAR, VTT) and every entry of every trace. */
function runTexts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (entry.name.endsWith(".zip"))
      for (const file of readZip(readFileSync(path)))
        out.push(Buffer.from(file.data).toString("latin1"));
    else if (/\.(json|ndjson|log|har|vtt|html|md|xml)$/.test(entry.name))
      out.push(readFileSync(path, "utf8"));
  }
  return out;
}

async function run(
  variant: Variant,
  tests: string[],
  options: Partial<RunTestsOptions> & {
    dir?: string;
    hold?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const dir = options.dir ?? project();
  const shop = await startShop({ variant, port: 0 });
  const { models, calls } = scriptedModels(() => ({ text: "the replay must not ask a model" }));
  try {
    const result = await runTests({
      projectDir: dir,
      tests: tests.map((t) => join(dir, "tests", `${t}.test.md`)),
      mode: "replay-only",
      retries: 0,
      video: false,
      generateSpecs: false,
      models,
      inbox: shopInbox(shop, { hold: options.hold ?? false }),
      ...options,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [`${ENV_PREFIX}BASE_URL`]: shop.url,
        SHOP_PASSWORD: PASSWORD,
        ...options.env,
      },
    });
    const byFile = (name: string) => {
      const test = result.tests.find((t) => t.file === `tests/${name}.test.md`);
      if (!test) throw new Error(`no result for ${name}`);
      return test;
    };
    return { dir, result, calls, byFile, outbox: shop.outbox() };
  } finally {
    await shop.stop();
  }
}

const sessionFile = (dir: string) =>
  join(dir, brand.dataDirName, "auth", "local", "ada", "w0.json");

describe("auth profiles in runs (SEC-3)", () => {
  it("logs in once with the profile's flow, then later tests start from the saved session", async () => {
    const { dir, result, calls, byFile } = await run("correct", [
      "billing-zero-due",
      "sort-orders",
    ]);
    expect(calls).toHaveLength(0);
    expect(result.tests.map((t) => t.verdict)).toEqual(["passed", "passed"]);
    const first = byFile("billing-zero-due").attempts[0]?.steps ?? [];
    expect(first[0]).toMatchObject({
      kind: "flow",
      status: "passed",
      text: expect.stringMatching(/^auth: ada/),
    });
    // The second test skips the login steps: no flow step, and it still passed.
    expect(byFile("sort-orders").attempts[0]?.steps.some((s) => s.kind === "flow")).toBe(false);
    // The saved session is owner-only, and none of its values is in anything the run wrote.
    const file = sessionFile(dir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      storageState: { cookies: Array<{ value: string }> };
    };
    const cookie = saved.storageState.cookies[0]?.value ?? "";
    expect(cookie.length).toBeGreaterThan(5);
    const texts = runTexts(result.dir);
    expect(texts.length).toBeGreaterThan(5);
    for (const text of texts) expect(text).not.toContain(cookie);
    expect(
      readRun(result.dir, { verifyArtifacts: true }).diagnostics.filter(
        (d) => d.severity === "error",
      ),
    ).toEqual([]);

    // An expired saved session means logging in again.
    const expired = JSON.parse(readFileSync(file, "utf8"));
    expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(file, JSON.stringify(expired), { mode: 0o600 });
    const again = await run("correct", ["sort-orders"], { dir });
    expect(again.byFile("sort-orders").verdict).toBe("passed");
    expect(again.byFile("sort-orders").attempts[0]?.steps[0]).toMatchObject({
      kind: "flow",
      status: "passed",
    });
  });

  it("fails a test whose profile login is broken (never blocked), at the login", async () => {
    // One retry, as in the manifest's harness: the same failure twice is a product bug.
    const { result, byFile } = await run("broken-login-redirect", ["billing-zero-due"], {
      retries: 1,
    });
    const test = byFile("billing-zero-due");
    expect(test.verdict).toBe("failed");
    expect(test.failureCause).toBe("product_bug");
    expect(test.headline).toMatch(/^auth: ada: logging in with flows\/login\.test\.md failed/);
    expect(test.attempts.map((a) => a.status)).toEqual(["failed", "failed"]);
    expect(test.attempts[0]?.steps[0]).toMatchObject({ kind: "flow", status: "failed" });
    expect(test.decidedBy).toEqual([expect.objectContaining({ kind: "step" })]);
    expect(result.run.totals.blocked).toBe(0);
  });
});

describe("test inboxes in runs (SEC-5)", () => {
  it("replays the email-code tests with no AI; the codes are typed and appear nowhere", async () => {
    const dir = project();
    const recordings = ["signup-email-code", "checkout-trial"].map((t) =>
      readFileSync(join(dir, "tests", brand.dataDirName, `tests__${t}.steps.json`), "utf8"),
    );
    const { result, calls, outbox } = await run(
      "correct",
      ["signup-email-code", "checkout-trial"],
      // Full evidence (trace, HAR): the codes must be scrubbed from all of it.
      { dir, evidence: "full" },
    );
    expect(calls).toHaveLength(0);
    expect(result.tests.map((t) => t.verdict)).toEqual(["passed", "passed"]);
    const codes = outbox.map((mail) => verificationCode(mail.to));
    expect(codes).toHaveLength(2);
    for (const recording of recordings) expect(recording).toContain('"{{inbox.code}}"');
    const texts = runTexts(result.dir);
    for (const text of texts) for (const code of codes) expect(text).not.toContain(code);
    expect(texts.join("\n")).toContain("[secret:INBOX_CODE]");
  });

  it("blocks with inbox_unavailable when no email arrives in time (the app may be fine)", async () => {
    const dir = project((config) =>
      config.replace(
        "inbox:\n  provider: mailpit",
        "inbox:\n  provider: mailpit\n  timeoutSeconds: 2",
      ),
    );
    const { byFile } = await run("correct", ["signup-email-code"], { dir, hold: true });
    const test = byFile("signup-email-code");
    expect(test.verdict).toBe("blocked");
    expect(test.failureCause).toBe("blocked");
    expect(test.decidedBy[0]).toMatchObject({
      kind: "blocked",
      reason: "inbox_unavailable",
      message: expect.stringMatching(/arrived in time/),
    });
  });

  it("authors 'enter the code from the email' with read_inbox: the model gets a handle, never the code", async () => {
    const dir = project();
    rmSync(join(dir, "tests", brand.dataDirName, "tests__signup-email-code.steps.json"));
    const { models, calls } = scriptedModels(
      agentScript([
        [
          /Fill "Email"/,
          [
            {
              name: "fill",
              on: { role: "textbox", name: "Email" },
              input: { value: "{{data.email}}" },
            },
          ],
        ],
        [
          /Fill "Password"/,
          [
            {
              name: "fill",
              on: { role: "textbox", name: "Password" },
              input: { value: "{{secret.SHOP_PASSWORD}}" },
            },
          ],
        ],
        [/Click "Sign up"/, [{ name: "click", on: { role: "button", name: "Sign up" } }]],
        [
          /verification email/,
          [
            { name: "read_inbox", input: { want: "code" } },
            {
              name: "fill",
              on: { role: "textbox", name: "Verification code" },
              input: { value: "{{inbox.code}}" },
            },
          ],
        ],
        [/Click "Verify"/, [{ name: "click", on: { role: "button", name: "Verify" } }]],
      ]),
    );
    const { result, byFile, outbox } = await run("correct", ["signup-email-code"], {
      dir,
      mode: "normal",
      models,
    });
    expect(byFile("signup-email-code").verdict).toBe("passed");
    const code = verificationCode(outbox[0]?.to ?? "");
    const prompts = calls.map(promptText);
    expect(prompts.some((p) => p.includes("is ready as {{inbox.code}}"))).toBe(true);
    for (const prompt of prompts) expect(prompt).not.toContain(code);
    const recording = readFileSync(
      join(dir, "tests", brand.dataDirName, "tests__signup-email-code.steps.json"),
      "utf8",
    );
    expect(recording).toContain('"value": "{{inbox.code}}"');
    expect(recording).not.toContain(code);
    for (const text of runTexts(result.dir)) expect(text).not.toContain(code);
    // Replayed from that recording with no AI.
    const replayed = await run("correct", ["signup-email-code"], { dir });
    expect(replayed.calls).toHaveLength(0);
    expect(replayed.byFile("signup-email-code").verdict).toBe("passed");
  });

  it("opens a magic link only on the allowed domains", async () => {
    const shop = await startShop({ variant: "correct", port: 0 });
    const browser = await launchBrowser({ browser: "chromium" });
    try {
      const allowedDomains = ["127.0.0.1"];
      const link = (url: string) =>
        createTestInbox({
          values: createInboxValues({
            inbox: {
              ...shopInbox({ outbox: () => [] }),
              waitForMessage: async ({ to }) => ({
                ok: true,
                message: {
                  id: "1",
                  from: "a@b.c",
                  to: [to],
                  subject: "Sign in",
                  text: `Sign in: ${url}`,
                  html: "",
                  receivedAt: new Date().toISOString(),
                },
              }),
            },
            allowedDomains,
            timeoutMs: 1000,
          }),
          provider: "mailpit",
          allowedDomains,
          since: new Date(),
        });
      const good = link(`${shop.url}/pricing?token=magic-token-123456`);
      expect(await good.read("link", "x@example.test")).toMatchObject({ ok: true });
      const session = await openSession({
        browser,
        baseUrl: shop.url,
        allowedDomains,
        secrets: { ...good.secrets },
      });
      const opened = await session.act({ type: "goto", url: { secret: "INBOX_LINK" } });
      expect(opened.status).toBe("ok");
      expect(session.url).toContain("[secret:INBOX_LINK]");
      expect(JSON.stringify(opened)).not.toContain("magic-token-123456");
      await session.close();

      const bad = link("https://evil.example.com/magic?token=abc");
      expect(await bad.read("link", "x@example.test")).toMatchObject({
        ok: false,
        reason: "disallowed_domain",
      });
    } finally {
      await browser.close();
      await shop.stop();
    }
  });
});

describe("TOTP in runs (SEC-4)", () => {
  it("logs in with a TOTP code typed by the harness, recorded as the secret, replayed with no AI", async () => {
    const dir = project((config) =>
      config.replace(
        "secrets:\n",
        "secrets:\n  ADA_TOTP:\n    domains: [127.0.0.1]\n    type: totp\n",
      ),
    );
    mkdirSync(join(dir, "tests", "totp"), { recursive: true });
    writeFileSync(
      join(dir, "tests", "totp", "login-2fa.test.md"),
      [
        "---",
        "name: Ada logs in with a code from her authenticator app",
        "start: /login",
        "auth: none",
        "setup:",
        "  - request: POST /__test/seed",
        `    body: { totp: ${TOTP_SEED} }`,
        "---",
        "",
        '1. Fill "Email" with ada@example.com',
        '2. Fill "Password" with {{secret.SHOP_PASSWORD}}',
        '3. Click "Log in"',
        '4. Fill "Authentication code" with {{secret.ADA_TOTP}}',
        '5. Click "Verify"',
        '6. Expect: the page heading is "Dashboard"',
        "",
      ].join("\n"),
    );
    const { models, calls } = scriptedModels(
      agentScript([
        [
          /Fill "Email"/,
          [
            {
              name: "fill",
              on: { role: "textbox", name: "Email" },
              input: { value: "ada@example.com" },
            },
          ],
        ],
        [
          /Fill "Password"/,
          [
            {
              name: "fill",
              on: { role: "textbox", name: "Password" },
              input: { value: "{{secret.SHOP_PASSWORD}}" },
            },
          ],
        ],
        [/Click "Log in"/, [{ name: "click", on: { role: "button", name: "Log in" } }]],
        [
          /Authentication code/,
          [
            {
              name: "fill",
              on: { role: "textbox", name: "Authentication code" },
              input: { value: "{{secret.ADA_TOTP}}" },
            },
          ],
        ],
        [/Click "Verify"/, [{ name: "click", on: { role: "button", name: "Verify" } }]],
      ]),
    );
    const env = { ADA_TOTP: TOTP_SEED };
    const authored = await run("correct", ["totp/login-2fa"], { dir, mode: "normal", models, env });
    expect(authored.byFile("totp/login-2fa").verdict).toBe("passed");
    expect(calls.length).toBeGreaterThan(0);
    const recording = readFileSync(
      join(dir, "tests", brand.dataDirName, "tests__totp__login-2fa.steps.json"),
      "utf8",
    );
    expect(recording).toContain('"value": "{{secret.ADA_TOTP}}"');
    const replayed = await run("correct", ["totp/login-2fa"], { dir, env });
    expect(replayed.calls).toHaveLength(0);
    expect(replayed.byFile("totp/login-2fa").verdict).toBe("passed");
    for (const text of [
      ...runTexts(authored.result.dir),
      ...runTexts(replayed.result.dir),
      recording,
    ])
      expect(text).not.toContain(TOTP_SEED);
  });
});
