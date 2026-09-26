import { expect, goToNav, label, test, useLogin } from "../fixtures.js";

test("avatar-upload", async ({ page, spec }) => {
  await spec.step(1, () => useLogin(page));
  await spec.step(2, () => goToNav(page, "Settings"));
  await spec.step(3, () =>
    page.getByLabel("Choose an image").setInputFiles(spec.filePath("files/avatar.png")),
  );
  await spec.step(4, () => page.getByRole("button", { name: label.uploadAvatar }).click());
  await spec.step(5, () => expect(page.getByText("Avatar updated", { exact: true })).toBeVisible());
  await spec.step(6, () => expect(page.getByRole("img", { name: "Your avatar" })).toBeVisible());
});
