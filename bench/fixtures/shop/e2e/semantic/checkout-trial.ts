import { expect, fillCard, goToNav, heading, label, signUp, test } from "../fixtures.js";

test("checkout-trial", async ({ page, spec }) => {
  const email = spec.data.email;
  await spec.step(1, () =>
    page
      .getByRole("article", { name: "Pro", exact: true })
      .getByRole("button", { name: label.startTrial })
      .click(),
  );
  await spec.step(2, () => signUp(page, email));
  await spec.step(3, () => expect(heading(page)).toHaveText("Check your email"));
  await spec.step(4, async () => {
    await page.getByLabel("Verification code").fill(await spec.verificationCode(email));
    await page.getByRole("button", { name: "Verify" }).click();
  });
  await spec.step(5, () => fillCard(page, "4242 4242 4242 4242"));
  await spec.step(6, () => page.getByRole("button", { name: label.startCheckout }).click());
  await spec.step(7, () => expect(heading(page)).toHaveText("Welcome to Pro"));
  await spec.step(8, () => expect(page).toHaveURL(/\/dashboard/));
  await spec.step(9, () => goToNav(page, "Billing"));
  await spec.step(10, () =>
    expect(page.getByText("$0.00 due today", { exact: true })).toBeVisible(),
  );
  await spec.never('click "Delete account"', async () => {
    const { users } = await spec.state();
    expect(users.map((user) => user.email)).toContain(email);
  });
});
