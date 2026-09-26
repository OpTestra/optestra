import { expect, fillCard, label, test, useLogin } from "../fixtures.js";

test("declined-card", async ({ page, spec }) => {
  await spec.step(1, () => useLogin(page));
  await spec.step(2, () => page.goto("/pricing"));
  await spec.step(3, () =>
    page
      .getByRole("article", { name: "Pro", exact: true })
      .getByRole("button", { name: label.startTrial })
      .click(),
  );
  await spec.step(4, () => fillCard(page, "4000 0000 0000 0002"));
  await spec.step(5, () => page.getByRole("button", { name: label.startCheckout }).click());
  await spec.step(6, () =>
    expect(page.getByRole("alert").filter({ hasText: "Your card was declined." })).toBeVisible(),
  );
  await spec.step(7, () => expect(page).toHaveURL(/\/checkout/));
});
