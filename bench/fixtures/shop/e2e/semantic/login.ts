import { DEFAULT_USER } from "../../src/index.js";
import { expect, heading, label, SECRETS, test } from "../fixtures.js";

test("login", async ({ page, spec }) => {
  await spec.step(1, () => page.getByLabel("Email").fill(DEFAULT_USER.email));
  await spec.step(2, () => page.getByLabel("Password").fill(SECRETS.SHOP_PASSWORD));
  await spec.step(3, () => page.getByRole("button", { name: label.logIn }).click());
  await spec.step(4, () => expect(heading(page)).toHaveText("Dashboard"));
  await spec.step(5, () => expect(page).toHaveURL(/\/dashboard/));
  await spec.step(6, () => page.getByRole("button", { name: "Log out" }).click());
  await spec.step(7, () => expect(heading(page)).toHaveText("Acme Shop"));
});
