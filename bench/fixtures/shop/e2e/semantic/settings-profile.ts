import { expect, goToNav, label, test, useLogin } from "../fixtures.js";

test("settings-profile", async ({ page, spec }) => {
  const name = page.getByLabel(label.fullName);
  const timezone = page.getByLabel("Time zone");
  await spec.step(1, () => useLogin(page));
  await spec.step(2, () => goToNav(page, "Settings"));
  await spec.step(3, () => name.fill("Ada King"));
  await spec.step(4, () => timezone.selectOption("Europe/London"));
  await spec.step(5, () => page.getByRole("button", { name: label.saveProfile }).click());
  await spec.step(6, () => expect(page.getByText("Profile saved", { exact: true })).toBeVisible());
  await spec.step(7, () => page.reload());
  await spec.step(8, () => expect(name).toHaveValue("Ada King"));
  await spec.step(9, () => expect(timezone).toHaveValue("Europe/London"));
});
