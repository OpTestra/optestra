import { expect, goToNav, label, test } from "../fixtures.js";

test("settings-profile", async ({ page, spec }) => {
  const name = page.getByLabel(label.fullName);
  const timezone = page.getByLabel("Time zone");
  await spec.step(1, () => goToNav(page, "Settings"));
  await spec.step(2, () => name.fill("Ada King"));
  await spec.step(3, () => timezone.selectOption("Europe/London"));
  await spec.step(4, () => page.getByRole("button", { name: label.saveProfile }).click());
  await spec.step(5, () => expect(page.getByText("Profile saved", { exact: true })).toBeVisible());
  await spec.step(6, () => page.reload());
  await spec.step(7, () => expect(name).toHaveValue("Ada King"));
  await spec.step(8, () => expect(timezone).toHaveValue("Europe/London"));
});
