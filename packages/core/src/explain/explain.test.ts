import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scriptedModels } from "../author/test-kit.test-support.js";
import { explainRun, failedRequests, formatExplanation } from "./explain.js";

// explain (DIA-6), rules only, on the contract's fixture runs: every sentence
// cites the evidence it used; the verdict and cause stay the run's.

const FIXTURES = fileURLToPath(new URL("../../../contract/fixtures/v1/", import.meta.url));

describe("explainRun (rules only)", () => {
  it("a product bug: names the failing check with expected and actual, and cites it", async () => {
    const result = await explainRun(`${FIXTURES}failed-product-bug`);
    expect(result.explanations.map((e) => e.testId)).toEqual(["tests__checkout__discount-code"]);
    const [e] = result.explanations;
    expect(e?.mode).toBe("rules");
    expect(e?.verdict).toBe("failed");
    expect(e?.cause).toBe("product_bug");
    expect(e?.diagnosis).toMatch(
      /^The check "The order total is \$90\.00" failed \[E1\]: it expected '\$90\.00' and the page showed '\$100\.00'\. The run classed the cause as product bug\./,
    );
    expect(e?.evidence[0]).toMatchObject({ id: "E1", kind: "check" });
    expect(e?.evidence.map((x) => x.kind)).toEqual(expect.arrayContaining(["screenshot", "trace"]));
    for (const cited of e?.diagnosis.matchAll(/\[(E\d+)\]/g) ?? [])
      expect(e?.evidence.map((x) => x.id)).toContain(cited[1]);
    expect(e?.next.join(" ")).toMatch(/Don't change the Expect: line/);
    const text = formatExplanation(e as NonNullable<typeof e>);
    expect(text).toContain("Explained by rules (no AI)");
    expect(e?.modelCalls).toEqual([]);
  });

  it("flaky, healed and blocked runs get their own diagnosis", async () => {
    const flaky = (await explainRun(`${FIXTURES}flaky`)).explanations[0];
    expect(flaky?.diagnosis).toMatch(/passed on a retry, so it is flaky/);
    expect(flaky?.cause).toBe("environment");
    const healed = (await explainRun(`${FIXTURES}healed`)).explanations[0];
    expect(healed?.diagnosis).toMatch(/passed after a heal/);
    const blocked = (await explainRun(`${FIXTURES}blocked-missing-secret`)).explanations[0];
    expect(blocked?.diagnosis).toMatch(/couldn't run \(missing secret\) \[E1\]/);
    expect(blocked?.next[0]).toMatch(/Set the missing secret/);
  });

  it("picks a test by id, file or name, and says when there is nothing to explain", async () => {
    const one = await explainRun(`${FIXTURES}failed-product-bug`, {
      test: "tests__checkout__guest-checkout",
    });
    expect(one.explanations[0]?.verdict).toBe("passed");
    const none = await explainRun(`${FIXTURES}all-passed`);
    expect(none.explanations).toEqual([]);
    expect(none.message).toMatch(/nothing to explain/);
    const missing = await explainRun(`${FIXTURES}failed-product-bug`, { test: "nope" });
    expect(missing.message).toMatch(/No test "nope"/);
  });
});

describe("explainRun with a model", () => {
  it("makes one call, and keeps the rules' answer when the model cites evidence that doesn't exist", async () => {
    const good = scriptedModels(() => ({
      text: JSON.stringify({
        diagnosis: "The discount wasn't applied: the total stayed $100.00 [E1].",
        next: ["Fix the discount code handling."],
      }),
    }));
    const result = await explainRun(`${FIXTURES}failed-product-bug`, { models: good.models });
    expect(good.calls).toHaveLength(1);
    expect(result.explanations[0]).toMatchObject({
      mode: "ai",
      cause: "product_bug",
      diagnosis: "The discount wasn't applied: the total stayed $100.00 [E1].",
    });
    const bad = scriptedModels(() => ({
      text: JSON.stringify({ diagnosis: "It's the database [E99].", next: [] }),
    }));
    const fallback = (await explainRun(`${FIXTURES}failed-product-bug`, { models: bad.models }))
      .explanations[0];
    expect(fallback?.mode).toBe("rules");
    expect(fallback?.note).toMatch(/cited evidence that doesn't exist/);
  });
});

describe("failedRequests", () => {
  it("lists 4xx/5xx answers and requests without one", () => {
    const har = JSON.stringify({
      log: {
        entries: [
          { request: { method: "GET", url: "http://x/a" }, response: { status: 200 } },
          {
            request: { method: "POST", url: "http://x/api/pay?x=1" },
            response: { status: 502, statusText: "Bad Gateway" },
          },
          {
            request: { method: "GET", url: "http://x/img" },
            response: { status: 0 },
            _failureText: "net::ERR_FAILED",
          },
        ],
      },
    });
    expect(failedRequests(har)).toEqual([
      "POST /api/pay?x=1 → 502 Bad Gateway",
      "GET /img → no answer (net::ERR_FAILED)",
    ]);
    expect(failedRequests("not json")).toEqual([]);
  });
});
