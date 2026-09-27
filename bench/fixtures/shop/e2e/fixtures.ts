import { test as base, expect, type Page } from "@playwright/test";
import { DEFAULT_USER } from "../src/index.js";
import { readTestFile, TESTS_DIR, type TestFile } from "./test-file.js";

// The reference suite's harness. Each semantic test is named after its
// .test.md file; the `spec` fixture runs the manifest's harness rules (reset,
// setup), opens `start`, and hands out `step(n, fn)`, whose title is step n of
// the .test.md, so the Bench can compare the failing step with the gold answer.

export const SECRETS = { SHOP_PASSWORD: DEFAULT_USER.password };

/**
 * Labels the cosmetic build rewords (see src/variants.ts). This suite is a
 * behavioural reference, so it knows both wordings; an engine has to heal.
 */
export const label = {
  startTrial: /^Start (your )?free trial$/,
  signUp: /^(Sign up|Create account)$/,
  logIn: /^(Log in|Sign in)$/,
  createProject: /^(Create|Add) project$/,
  createConfirm: /^(Create|Save project)$/,
  saveProfile: /^Save (changes|profile)$/,
  fullName: /^(Full name|Your name)$/,
  uploadAvatar: /^Upload (avatar|photo)$/,
  showRefunded: /^(Show|Include) refunded orders$/,
  startCheckout: /^Start (my )?trial$/,
};

export interface Spec {
  file: TestFile;
  data: { email: string };
  /** Runs step `n` of the .test.md as a Playwright step with the same text. */
  step(n: number, body: () => Promise<unknown>): Promise<void>;
  /** Checks a `Never:` guard held. */
  never(text: string, body: () => Promise<unknown>): Promise<void>;
  verificationCode(email: string): Promise<string>;
  state(): Promise<{ users: Array<{ email: string; plan: string | null; projects: string[] }> }>;
  filePath(relative: string): string;
}

export const test = base.extend<{ spec: Spec }>({
  spec: async ({ page, request }, use, testInfo) => {
    const file = readTestFile(testInfo.title);
    // Harness rules from manifest.yaml: the environment resets once per test, data every attempt.
    const reset = testInfo.retry === 0 ? "/__test/reset?environment=1" : "/__test/reset";
    expect((await request.post(reset)).ok()).toBe(true);
    for (const call of file.setup) {
      const response =
        call.method === "POST"
          ? await request.post(call.path, { data: call.body ?? {} })
          : await request.get(call.path);
      expect(response.ok(), `setup ${call.method} ${call.path}`).toBe(true);
    }
    const ran: number[] = [];
    const spec: Spec = {
      file,
      data: { email: `${testInfo.title}-${testInfo.retry}@example.com` },
      async step(n, body) {
        const text = file.steps.get(n);
        if (text === undefined) throw new Error(`${file.name}.test.md has no step ${n}`);
        ran.push(n);
        await test.step(`${n}. ${text}`, body);
      },
      async never(text, body) {
        if (!file.never.includes(text))
          throw new Error(`${file.name}.test.md has no "Never: ${text}"`);
        await test.step(`Never: ${text}`, body);
      },
      async verificationCode(email) {
        const response = await request.get(`/__test/outbox?to=${encodeURIComponent(email)}`);
        const { emails } = (await response.json()) as { emails: Array<{ text: string }> };
        const code = /\b(\d{6})\b/.exec(emails.at(-1)?.text ?? "")?.[1];
        if (!code) throw new Error(`no verification email for ${email}`);
        return code;
      },
      async state() {
        return (await request.get("/__test/state")).json();
      },
      filePath: (relative) => `${TESTS_DIR}${relative}`,
    };
    // `auth: <profile>` (SEC-3): the test starts logged in. The reference logs in as
    // step "0. auth: ada", so a broken login is a failure at step 0, not a skipped test.
    const auth = file.frontmatter.auth;
    if (typeof auth === "string" && auth !== "none") {
      if (auth !== "ada") throw new Error(`${file.name}.test.md: unknown auth profile ${auth}`);
      await test.step(`0. auth: ${auth} (flows/login.test.md)`, () => useLogin(page));
    }
    await page.goto(file.start);
    await use(spec);
    // A pass only counts if every step of the .test.md was mirrored, in order.
    if (testInfo.status === "passed") {
      expect(ran, "steps run by the reference test").toEqual([...file.steps.keys()]);
    }
  },
});

export { expect };

export const heading = (page: Page) => page.getByRole("heading", { level: 1 });

export async function goToNav(page: Page, name: string): Promise<void> {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name }).click();
}

/** Step N of a test: `Use: flows/login.test.md`, with the flow's own steps nested. */
export async function useLogin(page: Page): Promise<void> {
  const flow = readTestFile("flows/login");
  const step = (n: number, body: () => Promise<unknown>) =>
    test.step(`login ${n}. ${flow.steps.get(n)}`, body);
  await step(1, () => page.goto("/login"));
  await step(2, () => page.getByLabel("Email").fill(DEFAULT_USER.email));
  await step(3, () => page.getByLabel("Password").fill(SECRETS.SHOP_PASSWORD));
  await step(4, () => page.getByRole("button", { name: label.logIn }).click());
  await step(5, () => expect(heading(page)).toHaveText("Dashboard"));
}

export async function fillCard(page: Page, number: string): Promise<void> {
  const card = page.getByTitle("Secure card payment").contentFrame();
  await card.getByLabel("Card number").fill(number);
  await card.getByLabel("Expiry date").fill("12/34");
  await card.getByLabel("CVC").fill("123");
}

export async function signUp(page: Page, email: string): Promise<void> {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SECRETS.SHOP_PASSWORD);
  await page.getByRole("button", { name: label.signUp }).click();
}
