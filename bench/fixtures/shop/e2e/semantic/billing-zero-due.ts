import { expect, goToNav, test } from "../fixtures.js";

test("billing-zero-due", async ({ page, spec }) => {
  await spec.step(1, () => goToNav(page, "Billing"));
  await spec.step(2, () => expect(page.getByText("Pro plan")).toBeVisible());
  await spec.step(3, () =>
    expect(page.getByText("$0.00 due today", { exact: true })).toBeVisible(),
  );
});
