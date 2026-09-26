import { expect, label, test, useLogin } from "../fixtures.js";

test("create-project", async ({ page, spec }) => {
  const projects = page.getByRole("list", { name: "Projects" });
  await spec.step(1, () => useLogin(page));
  await spec.step(2, () => page.getByRole("button", { name: label.createProject }).click());
  await spec.step(3, () => expect(page.getByRole("dialog", { name: "New project" })).toBeVisible());
  await spec.step(4, () => page.getByLabel("Project name").fill("Q3 roadmap"));
  await spec.step(5, () => page.getByRole("button", { name: label.createConfirm }).click());
  await spec.step(6, () =>
    expect(page.getByText("Project created", { exact: true })).toBeVisible(),
  );
  await spec.step(7, () => expect(projects.getByText("Q3 roadmap")).toBeVisible());
  await spec.step(8, () => page.reload());
  await spec.step(9, () => expect(projects.getByText("Q3 roadmap")).toBeVisible());
});
