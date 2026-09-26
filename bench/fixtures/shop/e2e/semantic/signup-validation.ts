import { expect, heading, label, test } from "../fixtures.js";

test("signup-validation", async ({ page, spec }) => {
  await spec.step(1, () => page.getByLabel("Email").fill("not-an-email"));
  await spec.step(2, () => page.getByLabel("Password").fill("short"));
  await spec.step(3, () => page.getByRole("button", { name: label.signUp }).click());
  await spec.step(4, () =>
    expect(page.getByText("Enter a valid email address, like name@example.com.")).toBeVisible(),
  );
  await spec.step(5, () =>
    expect(page.getByText("Password must be at least 8 characters.")).toBeVisible(),
  );
  await spec.step(6, () => expect(heading(page)).toHaveText("Create your account"));
});
