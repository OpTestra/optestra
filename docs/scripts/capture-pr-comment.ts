// Renders the GitHub Action's PR comment for a real contract fixture run (a
// product bug) and saves a screenshot of it as docs/public/images/pr-comment.png.
// The comment text comes from the Action's own buildComment and the report
// package's renderMarkdownSummary; only the page around it imitates GitHub.
//   pnpm build && node docs/scripts/capture-pr-comment.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildComment, commentMarker } from "@optestra/action";
import { brand } from "@optestra/brand";
import { renderMarkdownSummary } from "@optestra/report";
import { loadRunData } from "@optestra/report/node";
import MarkdownIt from "markdown-it";
import { chromium } from "playwright";
import { DOCS_ROOT, ENGINE_ROOT } from "./reference.ts";

const FIXTURE = join(ENGINE_ROOT, "packages/contract/fixtures/v1/failed-product-bug");
const OUT = join(DOCS_ROOT, "public/images/pr-comment.png");

const loaded = loadRunData(FIXTURE);
if (!loaded.ok) throw new Error(`can't read ${FIXTURE}`);
const markdown = renderMarkdownSummary(loaded.data, {
  productName: brand.productName,
  cliName: brand.cliName,
  reportUrl: "https://github.com/acme/shop/actions/runs/1",
});
const comment = buildComment({
  marker: commentMarker(brand.cliName, brand.productName),
  markdown,
  summary: null,
  cliName: brand.cliName,
  artifactUrl: () => "https://github.com/acme/shop/actions/runs/1",
  runUrl: "https://github.com/acme/shop/actions/runs/1",
});

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 16px; background: #fff; font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; color: #1f2328; }
  .comment { width: 760px; border: 1px solid #d1d9e0; border-radius: 6px; }
  .head { background: #f6f8fa; border-bottom: 1px solid #d1d9e0; padding: 8px 16px; color: #59636e; border-radius: 6px 6px 0 0; }
  .head b { color: #1f2328; }
  .bot { font-size: 12px; border: 1px solid #d1d9e0; border-radius: 2em; padding: 0 6px; margin-left: 4px; }
  .body { padding: 16px; }
  h2 { font-size: 1.5em; margin: 0 0 16px; padding-bottom: .3em; border-bottom: 1px solid #d1d9e0; }
  h3 { font-size: 1.25em; margin: 24px 0 16px; }
  table { border-collapse: collapse; margin: 0 0 16px; }
  th, td { border: 1px solid #d1d9e0; padding: 6px 13px; }
  th { font-weight: 600; background: #f6f8fa; }
  code { background: #eff1f3; border-radius: 6px; padding: .2em .4em; font: 85% ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: #0969da; text-decoration: none; }
  p, ul { margin: 0 0 16px; }
  details { margin: 0 0 16px; }
  summary { cursor: pointer; }
  sub { color: #59636e; }
</style></head><body><div class="comment">
  <div class="head"><b>github-actions</b><span class="bot">bot</span> commented</div>
  <div class="body">${new MarkdownIt({ html: true, linkify: false, breaks: true }).render(comment)}</div>
</div></body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    deviceScaleFactor: 2,
    viewport: { width: 800, height: 600 },
  });
  await page.setContent(html);
  const png = await page.locator(".comment").screenshot();
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${Math.round(png.length / 1024)} KB)`);
} finally {
  await browser.close();
}
