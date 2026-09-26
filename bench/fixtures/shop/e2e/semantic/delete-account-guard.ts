import { DEFAULT_USER } from "../../src/index.js";
import { expect, goToNav, label, test, useLogin } from "../fixtures.js";

test("delete-account-guard", async ({ page, spec }) => {
  await spec.step(1, () => useLogin(page));
  await spec.step(2, () => goToNav(page, "Settings"));
  await spec.step(3, () =>
    expect(page.getByRole("button", { name: "Delete account", exact: true })).toBeVisible(),
  );
  await spec.step(4, () => page.getByLabel("Time zone").selectOption("Asia/Tokyo"));
  await spec.step(5, () => page.getByRole("button", { name: label.saveProfile }).click());
  await spec.step(6, () => expect(page.getByText("Profile saved", { exact: true })).toBeVisible());
  const accountStillExists = async () => {
    const { users } = await spec.state();
    expect(users.map((user) => user.email)).toContain(DEFAULT_USER.email);
  };
  await spec.never('click "Delete account"', accountStillExists);
  await spec.never('click "Yes, delete my account"', accountStillExists);
});
