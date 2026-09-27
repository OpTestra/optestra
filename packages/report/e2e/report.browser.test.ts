/// <reference lib="dom" />
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRunData, writeHtmlReport } from "../src/node/index.js";

// The report as people open it: from disk, in Chromium, with no network.

const FIXTURES = fileURLToPath(new URL("../../contract/fixtures/v1/", import.meta.url));
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const root = mkdtempSync(join(tmpdir(), "report-e2e-"));
let browser: Browser;

/** Copies a fixture, writes its report into the copy, returns the report's file URL. */
function reportFor(name: string): string {
  const dir = join(root, name);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  const loaded = loadRunData(dir);
  if (!loaded.ok) throw new Error(`cannot read ${name}`);
  return pathToFileURL(writeHtmlReport(dir, loaded.data)).href;
}

/** Opens a page that records every request that isn't a local file. */
async function open(
  url: string,
  options: { javaScriptEnabled?: boolean; colorScheme?: "light" | "dark" } = {},
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    javaScriptEnabled: options.javaScriptEnabled ?? true,
    colorScheme: options.colorScheme ?? "light",
  });
  const network: string[] = [];
  await context.route(/^(?!file:)/, (route) => {
    network.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(url);
  return { page, network, close: () => context.close() };
}

async function axe(page: Page) {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: axe is injected at runtime
    const result = await (window as any).axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
      },
    });
    return result.violations.map((v: { id: string; nodes: { target: string[] }[] }) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target.join(" ")),
    }));
  });
}

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  rmSync(root, { recursive: true, force: true });
});

describe.each(readdirSync(FIXTURES))("report of %s", (name) => {
  it("opens from disk with no network requests and passes axe (light and dark)", async () => {
    const url = reportFor(name);
    for (const colorScheme of ["light", "dark"] as const) {
      const { page, network, close } = await open(url, { colorScheme });
      // Open every collapsed section so axe sees all content.
      await page.evaluate(() => {
        for (const d of document.querySelectorAll("details")) d.open = true;
      });
      expect(await axe(page), colorScheme).toEqual([]);
      expect(network).toEqual([]);
      const broken = await page.$$eval("img", (imgs) =>
        imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute("src")),
      );
      expect(broken).toEqual([]);
      await close();
    }
  });

  it("shows its core content with JavaScript disabled", async () => {
    const { page, close } = await open(reportFor(name), { javaScriptEnabled: false });
    const run = JSON.parse(readFileSync(join(FIXTURES, name, "run.json"), "utf8"));
    expect(await page.locator("article.test").count()).toBe(run.tests.length);
    await expect.poll(() => page.locator("#filters").isVisible()).toBe(false);
    for (const heading of await page.locator("article.test h3").allTextContents())
      expect(heading.trim()).not.toBe("");
    await close();
  });
});

describe("failed-product-bug report", () => {
  it("shows the headline and screenshot on the first screen", async () => {
    const { page, close } = await open(reportFor("failed-product-bug"));
    const headline = page.locator("#failures .headline").first();
    await expect
      .poll(() => headline.textContent())
      .toBe("Expected order total '$90.00', found '$100.00'");
    const inView = async (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => {
          const box = el.getBoundingClientRect();
          return box.top >= 0 && box.top < window.innerHeight;
        });
    expect(await inView("#failures .headline")).toBe(true);
    expect(await inView("#failures figure img")).toBe(true);
    await close();
  });

  it("filters by verdict and search when JavaScript is on", async () => {
    const { page, close } = await open(reportFor("failed-product-bug"));
    await expect.poll(() => page.locator("#filters").isVisible()).toBe(true);
    await page.selectOption("#f-verdict", "failed");
    expect(await page.locator("article.test:visible").count()).toBe(1);
    await page.selectOption("#f-verdict", "");
    await page.fill("#f-search", "guest");
    expect(await page.locator("article.test:visible h3").allTextContents()).toEqual([
      "Guest checkout",
    ]);
    await expect.poll(() => page.locator("#f-count").textContent()).toBe("1 of 2 tests shown");
    await close();
  });
});
