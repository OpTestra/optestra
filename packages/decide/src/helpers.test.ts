import { readFileSync } from "node:fs";
import { type TestResult, TestResultSchema } from "@testament/contract";
import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  classifyHeal,
  createDecisions,
  failureCauseCase,
  flakyInput,
  groupFailures,
  signatureFromTestResult,
} from "./index.js";

const fixture = (path: string): TestResult =>
  TestResultSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(`../../contract/fixtures/v1/${path}/result.json`, import.meta.url),
        "utf8",
      ),
    ),
  );
const bug = fixture("failed-product-bug/tests/tests__checkout__discount-code");
const flaky = fixture("flaky/tests/tests__search__search-products");
const blocked = fixture("blocked-budget-exceeded/tests/tests__account__sign-up");
const healed = fixture("healed/tests/tests__cart__add-to-cart");

describe("helpers for the runner (on the contract fixtures)", () => {
  it("classifies each fixture's failure cause like its recorded label", async () => {
    expect(await classifyFailure(bug)).toMatchObject({
      cause: "product_bug",
      decided: true,
      source: "rules",
    });
    expect(await classifyFailure(flaky)).toMatchObject({ cause: "environment", decided: true });
    // Blocked is deterministic: no decision is made.
    expect(await classifyFailure(blocked)).toMatchObject({
      cause: "blocked",
      source: "rules",
      evidence: [{ signal: "blocked_reason" }, { signal: "blocked_step" }],
    });
    expect(await classifyFailure(healed)).toMatchObject({ cause: null, decided: false });
  });

  it("reads requests out of a step error when the runner gave no observations", () => {
    const c = failureCauseCase(flaky);
    expect(c.kind === "decide" && c.input.requests).toEqual([
      { method: "GET", path: "/api/search", status: 503, document: false, thirdParty: false },
    ]);
  });

  it("uses the runner's observations, and ignores other sites' requests", () => {
    const c = failureCauseCase(bug, {
      attempts: {
        2: {
          requests: [
            {
              method: "GET",
              url: "https://shop.acme.test/checkout",
              status: 200,
              resourceType: "document",
            },
            { method: "POST", url: "https://analytics.example.com/collect", status: 503 },
          ],
          consoleErrors: ["Uncaught TypeError: x is undefined"],
          page: { status: 200, title: "Checkout", heading: "Checkout", text: "Total $100.00" },
          pageIsError: false,
          route: "/checkout",
        },
      },
    });
    expect(c.kind === "decide" && c.input.requests.map((r) => r.thirdParty)).toEqual([false, true]);
    expect(c.kind === "decide" && c.input.consoleErrors).toHaveLength(1);
  });

  it("builds flaky_or_real input with per-attempt signatures", () => {
    const input = flakyInput(bug, { history: [{ verdict: "passed", signature: null }] });
    expect(input?.attempts.map((a) => a.signature)).toEqual([
      "check:c1|expected <value> found <value>",
      "check:c1|expected <value> found <value>",
    ]);
    expect(input?.history).toHaveLength(1);
    expect(flakyInput(healed)).toBeNull();
  });

  it("groups failures: tests broken by the same login flow step share a group", async () => {
    const loginBroken = (testId: string): TestResult => ({
      ...bug,
      testId,
      headline: "Expected the dashboard, landed on /error",
    });
    const flows = { stepFlows: { 2: ["login"] }, attempts: { 2: { route: "/error" } } };
    const groups = await groupFailures(
      [loginBroken("tests__a"), loginBroken("tests__b"), flaky, loginBroken("tests__c"), healed],
      { context: (r) => (r.testId === flaky.testId ? {} : flows) },
    );
    expect(groups.map((g) => [g.id, g.testIds, g.uncertain])).toEqual([
      ["g1", ["tests__a", "tests__b", "tests__c"], false],
      ["g2", [flaky.testId], false],
    ]);
    expect(groups[0]?.why.tests__b?.[0]?.signal).toBe("same_flow_step");
    expect(signatureFromTestResult(bug, flows)).toMatchObject({
      flowChain: ["login"],
      route: "/error",
    });
  });

  it("classifies a heal proposal, falling back to unknown when nothing is confident", async () => {
    const heal = healed.attempts[0]?.heals[0];
    if (!heal) throw new Error("fixture has no heal");
    expect(await classifyHeal(heal, { attempt: 1 })).toMatchObject({
      classification: "cosmetic",
      decided: true,
      evidence: expect.arrayContaining([expect.objectContaining({ signal: "synonymous_name" })]),
    });
    const wishlist = {
      ...heal,
      changes: [
        {
          target: "locator" as const,
          before: "getByRole('button', { name: 'Add to cart' })",
          after: "getByRole('button', { name: 'Add to wishlist' })",
        },
      ],
    };
    expect(await classifyHeal(wishlist, { decisions: createDecisions() })).toMatchObject({
      classification: "unknown",
      decided: false,
    });
  });
});
