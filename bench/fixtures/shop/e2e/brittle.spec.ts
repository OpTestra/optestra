import { test as base, expect } from "@playwright/test";
import { DEFAULT_USER } from "../src/index.js";

// The brittle suite: CSS classes, ids and test ids, the way record-and-replay
// tools pin elements. It must pass on `correct` and fail on `cosmetic`, which
// proves the cosmetic build really changes the surface.

const test = base.extend({
  page: async ({ page, request }, use) => {
    await request.post("/__test/reset?environment=1");
    await request.post("/__test/seed", { data: { trial: "pro" } });
    await use(page);
  },
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixtures from this destructuring.
test.beforeEach(({}, testInfo) => {
  test.fail(testInfo.project.metadata.variant === "cosmetic", "cosmetic changes the selectors");
});

async function logIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill("#login-email", DEFAULT_USER.email);
  await page.fill("#login-password", DEFAULT_USER.password);
  await page.click("#login-form .btn-primary");
  await page.waitForURL("**/dashboard");
}

test.describe.configure({ timeout: 15_000 });

test("pricing trial button by class", async ({ page }) => {
  await page.goto("/pricing");
  await page.click(".plan--pro .btn-primary", { timeout: 3000 });
  await expect(page.locator("#signup-form")).toBeVisible({ timeout: 3000 });
});

test("login form by id", async ({ page }) => {
  await logIn(page);
  await expect(page.locator(".site-nav")).toBeVisible({ timeout: 3000 });
});

test("create project by id and test id", async ({ page }) => {
  await logIn(page);
  await page.click("#create-project", { timeout: 3000 });
  await page.fill("#project-name", "Q3 roadmap");
  await page.click("dialog .btn-primary");
  await expect(page.locator('[data-testid="project-list"] li')).toHaveText("Q3 roadmap", {
    timeout: 3000,
  });
});

test("billing amount by test id", async ({ page }) => {
  await logIn(page);
  await page.goto("/billing");
  await expect(page.locator('[data-testid="due-today"]')).toHaveText("$0.00 due today", {
    timeout: 3000,
  });
});
