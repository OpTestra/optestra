import { type LaunchedBrowser, launchBrowser, openSession } from "@testament/browser";
import { createSecretValue } from "@testament/config/node";
import { type RunningShop, startShop } from "@testament/fixture-shop";
import type { ScriptedCall, ScriptedReply } from "@testament/models/testing";
import { checkTest, mapReader } from "@testament/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promptText, refIn, scriptedModels } from "../src/author/test-kit.test-support.js";
import { exploreDraft } from "../src/draft/draft.js";
import { exploreStarters } from "../src/draft/starters.js";

// Drafting (AGT-0) on the real shop with a scripted model: the harness, the
// guards, the phrasing of the steps and the checks on every expectation are
// real; only the model's replies are pre-written.

const PASSWORD = "shop-demo-pass";
const secrets = {
  SHOP_PASSWORD: createSecretValue("SHOP_PASSWORD", PASSWORD, { domains: ["127.0.0.1"] }),
};
const described = { SHOP_PASSWORD: "Password of the seeded user ada@example.com" };

type Call = { name: string; input?: Record<string, unknown>; on?: { role: string; name: string } };

/** The draft so far, from the prompt: its numbered lines. */
function draftSoFar(text: string): string[] {
  const block = /The test so far:\n([\s\S]*?)\n\nWhat happened so far:/.exec(text)?.[1] ?? "";
  return block === "(no steps yet)" ? [] : block.split("\n");
}

/**
 * A scripted drafter: `turns[n]` is the reply when the draft has the n-th
 * shape. Refs are looked up in the page the model was sent.
 */
function drafter(next: (draft: string[], text: string) => Call[]) {
  return (call: ScriptedCall): ScriptedReply => {
    const text = promptText(call);
    const calls = next(draftSoFar(text), text);
    return {
      toolCalls: calls.map((c) => ({
        name: c.name,
        input: { ...(c.on ? { ref: refIn(text, c.on.role, c.on.name) } : {}), ...c.input },
      })),
    };
  };
}

const logIn: Call[] = [
  { name: "fill", on: { role: "textbox", name: "Email" }, input: { value: "ada@example.com" } },
  {
    name: "fill",
    on: { role: "textbox", name: "Password" },
    input: { value: "{{secret.SHOP_PASSWORD}}" },
  },
  { name: "click", on: { role: "button", name: "Log in" } },
];

let browser: LaunchedBrowser;
let shop: RunningShop;
beforeAll(async () => {
  browser = await launchBrowser();
  shop = await startShop({ variant: "correct", port: 0 });
  // The seeded user ada@example.com (what the shop's tests do in their setup hook).
  await fetch(`${shop.url}/__test/seed`, { method: "POST" });
});
afterAll(async () => {
  await shop.stop();
  await browser.close();
});

const session = () =>
  openSession({
    browser,
    baseUrl: shop.url,
    allowedDomains: ["127.0.0.1"],
    secrets,
    evidence: { trace: false, console: false, network: false, video: false },
  });

describe("exploreDraft on the shop (scripted model)", () => {
  it("drafts a lint-clean login test whose expectations name real page text", async () => {
    const { models, calls } = scriptedModels(
      drafter((draft) => {
        if (draft.length === 0) return logIn;
        if (draft.length === 3)
          return [
            // Already true before logging in: refused (proves nothing).
            { name: "expect", input: { text: 'the page shows "Acme Shop"' } },
            // Not on the page: refused with what was seen.
            { name: "expect", input: { text: 'the page heading is "Welcome back"' } },
            { name: "expect", input: { text: 'the page heading is "Dashboard"' } },
            { name: "expect", input: { text: "the URL contains /dashboard" } },
          ];
        return [{ name: "draft_done", input: { name: "Returning user can log in" } }];
      }),
    );
    const s = await session();
    const refused: string[] = [];
    try {
      const draft = await exploreDraft("a returning user can log in and see the dashboard", {
        session: s,
        models,
        start: "/login",
        secrets: described,
        onEvent: (event) => {
          if (event.type === "refused") refused.push(`${event.text}: ${event.message}`);
        },
      });
      expect(draft.status).toBe("drafted");
      expect(draft.lintClean).toBe(true);
      expect(draft.findings.filter((f) => f.severity !== "info")).toEqual([]);
      expect(draft.path).toBe("tests/returning-user-can-log-in.test.md");
      expect(draft.text).toBe(`---
name: Returning user can log in
start: /login
---

1. Fill "Email" with ada@example.com
2. Fill "Password" with {{secret.SHOP_PASSWORD}}
3. Click "Log in"
4. Expect: the page heading is "Dashboard"
5. Expect: the URL contains /dashboard
`);
      expect(refused).toHaveLength(2);
      expect(refused[0]).toMatch(/also passes before the preceding action/);
      expect(refused[1]).toMatch(/doesn't hold on the page now .*saw "Dashboard"/);
      expect(draft.items.filter((i) => i.kind === "expect").map((i) => i.text)).toEqual([
        'the page heading is "Dashboard"',
        "the URL contains /dashboard",
      ]);
      expect(draft.totals.aiCalls).toBe(3);
      expect(draft.actions).toBe(3);
      // The secret was typed, never shown: not in the draft, not in any prompt.
      expect([draft.text, ...calls.map(promptText)].join("\n")).not.toContain(PASSWORD);
      expect(calls.map(promptText).join("\n")).toContain("<<<PAGE CONTENT");
      // It parses and lints the same as a file in the project.
      const again = await checkTest(draft.text, draft.path, { readFile: mapReader({}) });
      expect(again.findings.filter((f) => f.severity !== "info")).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("turns {{unique.name}} into data, and never does a destructive action", async () => {
    const { models } = scriptedModels(
      drafter((draft, text) => {
        if (draft.length === 0) return logIn;
        if (draft.length === 3) return [{ name: "goto", input: { url: "/settings" } }];
        if (draft.length === 4 && !text.includes("destructive"))
          return [{ name: "click", on: { role: "button", name: "Delete account" } }];
        if (draft.length === 4)
          return [
            {
              name: "fill",
              on: { role: "textbox", name: "Full name" },
              input: { value: "{{unique.name}}" },
            },
            { name: "click", on: { role: "button", name: "Save changes" } },
          ];
        if (draft.length === 6)
          return [{ name: "expect", input: { text: 'a message says "Profile saved"' } }];
        return [{ name: "draft_done", input: { name: "Profile name is saved" } }];
      }),
    );
    const s = await session();
    try {
      const draft = await exploreDraft("a user can change their name", {
        session: s,
        models,
        start: "/login",
        secrets: described,
      });
      expect(draft.status).toBe("drafted");
      // The delete click was refused before acting.
      expect(draft.notes.join("\n")).toMatch(/refused a destructive action/);
      expect(draft.text).not.toContain("Delete");
      expect(draft.text).toContain('data:\n  name: "{{unique.name}}"');
      expect(draft.text).toContain('5. Fill "Full name" with {{data.name}}');
      expect(draft.text).toContain('6. Click "Save changes"');
      expect(draft.text).toContain('7. Expect: a message says "Profile saved"');
      expect(draft.lintClean).toBe(true);
      // The account still exists: the settings page still opens.
      const check = await s.act({ type: "goto", url: "/settings" });
      expect(check.status).toBe("ok");
      expect(s.url).toContain("/settings");
    } finally {
      await s.close();
    }
  });

  it("stops at its limits with a partial, honest draft", async () => {
    const { models } = scriptedModels(
      drafter(() => [{ name: "scroll", input: { direction: "down" } }]),
    );
    const s = await session();
    try {
      const draft = await exploreDraft("anything", {
        session: s,
        models,
        start: "/",
        limits: { modelCalls: 3 },
      });
      expect(draft.status).toBe("incomplete");
      expect(draft.reason).toBe("limit_reached");
      expect(draft.lintClean).toBe(false);
      expect(draft.findings.map((f) => f.code)).toEqual(["NO_STEPS"]);
      expect(draft.totals.aiCalls).toBe(3);
    } finally {
      await s.close();
    }
  });
});

describe("exploreStarters on the shop", () => {
  it("proposes three starters: the home page (no AI), sign-up and login from the page", async () => {
    const { models, calls } = scriptedModels(
      drafter((draft, text) => {
        const goal = /Goal: (.*)/.exec(text)?.[1] ?? "";
        if (/log in/.test(goal)) {
          if (draft.length === 0) return logIn;
          if (draft.length === 3)
            return [{ name: "expect", input: { text: 'the page heading is "Dashboard"' } }];
          return [{ name: "draft_done", input: { name: "Returning user can log in" } }];
        }
        // sign up: the shop sends a code by email, which a draft can't read.
        if (draft.length === 0)
          return [{ name: "expect", input: { text: 'the page heading is "Create your account"' } }];
        return [{ name: "draft_impossible", input: { reason: "needs the code from an email" } }];
      }),
    );
    const suggestions = await exploreStarters({
      openSession: session,
      models,
      secrets: described,
    });
    expect(suggestions.proposals.map((p) => [p.name, p.start, p.source])).toEqual([
      ["The home page loads", "/", "page"],
      ["New visitor can sign up", "/signup", "page"],
      ["Returning user can log in", "/login", "page"],
    ]);
    const [home, signUp, login] = suggestions.drafts;
    expect(home?.text).toBe(`---
name: The home page loads
start: /
---

1. Expect: the page heading is "Acme Shop"
`);
    expect(home?.totals.aiCalls).toBe(0);
    expect(signUp?.status).toBe("impossible");
    expect(login?.status).toBe("drafted");
    expect(login?.lintClean).toBe(true);
    // No proposal call: the page gave all three.
    expect(calls.some((c) => promptText(c).includes("Propose"))).toBe(false);
    expect(suggestions.drafts.map((d) => d.path)).toEqual([
      "tests/the-home-page-loads.test.md",
      "tests/new-visitor-can-sign-up.test.md",
      "tests/returning-user-can-log-in.test.md",
    ]);
  });

  it("without a model drafts only the home page test", async () => {
    const suggestions = await exploreStarters({ openSession: session });
    expect(suggestions.drafts.map((d) => d.name)).toEqual(["The home page loads"]);
    expect(suggestions.notes.join(" ")).toMatch(/No AI model/);
  });
});
