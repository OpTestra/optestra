import { brand } from "@optestra/brand";
import { defineConfig } from "vitepress";
import { brandText, REPO } from "./brand.ts";
import { writeLlmsFiles } from "./llms.ts";
import { SECTIONS } from "./pages.ts";

/** Applies brandText to every string inside frontmatter values. */
function brandDeep<T>(value: T): T {
  if (typeof value === "string") return brandText(value) as T;
  if (Array.isArray(value)) return value.map(brandDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, brandDeep(inner)]),
    ) as T;
  }
  return value;
}

export default defineConfig({
  title: brand.productName,
  description: `${brand.productName} tests websites and Android apps from plain-English descriptions.`,
  lang: "en",
  // Everything the site needs is in its own output: no CDN, no web fonts, no analytics.
  outDir: "dist",
  cacheDir: "node_modules/.vitepress-cache",
  srcExclude: ["README.md", "scripts/**", "test/**"],
  // Pages link to each other as ./page.md; a broken link fails the build. Example
  // addresses like http://localhost:3000 are text, not links to check.
  ignoreDeadLinks: "localhostLinks",
  cleanUrls: false,
  lastUpdated: false,
  head: [["meta", { name: "color-scheme", content: "light dark" }]],
  markdown: {
    // Brand placeholders are filled in before markdown is parsed, so they work in
    // headings, text, links and code blocks alike (and in the search index).
    config(md) {
      const parse = md.parse.bind(md);
      md.parse = (src, env) => parse(brandText(src), env);
      // Test syntax like `{{data.email}}` is shown as written, never as a Vue expression.
      const inline = md.renderer.rules.code_inline;
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) =>
        (inline?.(tokens, idx, options, env, self) ?? "").replace(/^<code/, "<code v-pre");
    },
  },
  transformPageData(pageData) {
    pageData.title = brandText(pageData.title);
    pageData.description = brandText(pageData.description);
    pageData.frontmatter = brandDeep(pageData.frontmatter);
  },
  async buildEnd(site) {
    await writeLlmsFiles(site.srcDir, site.outDir);
  },
  themeConfig: {
    nav: [
      { text: "Quickstart", link: "/quickstart/cli" },
      { text: "Writing tests", link: "/writing/test-files" },
      { text: "CI", link: "/ci/github-action" },
      { text: "Reference", link: "/reference/cli" },
    ],
    sidebar: SECTIONS.map((section) => ({
      text: brandText(section.text),
      items: section.items.map((page) => ({ text: brandText(page.text), link: page.link })),
    })),
    // Built into the site: the index is a file in the output, searched in the browser.
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: `https://github.com/${REPO}` }],
    outline: { level: [2, 3] },
    footer: {
      message: "The engine, the test format, the CLI and the GitHub Action are MIT licensed.",
    },
  },
});
