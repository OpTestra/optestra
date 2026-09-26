import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTests } from "./node/index.js";
import { withoutSource } from "./print.js";

// The FND-4 demo shop's tests are the primary acceptance input for the format.
const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const loaded = await loadTests(SHOP, undefined, { seed: "snapshot" });

describe("Acme Shop tests", () => {
  it("lists every runnable test and loads the login flow separately", () => {
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.tests.map((t) => t.path)).toEqual([
      "tests/avatar-upload.test.md",
      "tests/billing-zero-due.test.md",
      "tests/checkout-trial.test.md",
      "tests/create-project.test.md",
      "tests/declined-card.test.md",
      "tests/delete-account-guard.test.md",
      "tests/login.test.md",
      "tests/settings-profile.test.md",
      "tests/signup-email-code.test.md",
      "tests/signup-validation.test.md",
      "tests/sort-orders.test.md",
    ]);
    expect(loaded.flows.map((f) => f.path)).toEqual(["tests/flows/login.test.md"]);
  });

  it.each([...loaded.tests, ...loaded.flows].map((t) => [t.path, t]))(
    "%s parses with no problems and matches its expanded snapshot",
    (_path, test) => {
      expect(test.diagnostics).toEqual([]);
      expect(withoutSource(test.expanded)).toMatchSnapshot();
    },
  );

  it("keeps the shop password a secret reference everywhere", () => {
    const create = loaded.tests.find((t) => t.path === "tests/create-project.test.md");
    const password = create?.expanded.steps.find((s) => s.text.includes("Password"));
    expect(password?.bound).toContainEqual({ kind: "secret", name: "SHOP_PASSWORD" });
    expect(password?.display).toBe('Fill "Password" with {{secret.SHOP_PASSWORD}}');
    expect(password?.origin.map((o) => o.file)).toEqual([
      "tests/create-project.test.md",
      "tests/flows/login.test.md",
    ]);
  });

  it("reads the setup hooks FND-4 added", () => {
    const billing = loaded.tests.find((t) => t.path === "tests/billing-zero-due.test.md");
    expect(billing?.spec.frontmatter.setup).toEqual([
      expect.objectContaining({
        type: "request",
        method: "POST",
        target: "/__test/seed",
        body: { trial: "pro" },
      }),
    ]);
  });
});
