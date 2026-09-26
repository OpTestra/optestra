import { expect, heading, label, SECRETS, test } from "../fixtures.js";

test("signup-email-code", async ({ page, spec }) => {
  const email = spec.data.email;
  await spec.step(1, () => page.getByLabel("Email").fill(email));
  await spec.step(2, () => page.getByLabel("Password").fill(SECRETS.SHOP_PASSWORD));
  await spec.step(3, () => page.getByRole("button", { name: label.signUp }).click());
  await spec.step(4, () => expect(heading(page)).toHaveText("Check your email"));
  await spec.step(5, async () =>
    page.getByLabel("Verification code").fill(await spec.verificationCode(email)),
  );
  await spec.step(6, () => page.getByRole("button", { name: "Verify" }).click());
  await spec.step(7, () => expect(heading(page)).toHaveText("Dashboard"));
  await spec.step(8, () =>
    expect(page.getByRole("list", { name: "Projects" })).toHaveText("No projects yet."),
  );
});
