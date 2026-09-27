// Browser-safe entry: every renderer is a pure function of a run's documents,
// so the apps and the cloud reuse them. File I/O lives in `./node`.
export { encodePath, escapeHtml, escapeMarkdown, escapeXml } from "./escape.js";
export {
  CONTENT_SECURITY_POLICY,
  type HtmlReportOptions,
  renderHtmlReport,
} from "./html/render.js";
export {
  buildResultsSummary,
  renderJsonSummary,
  type ResultsSummary,
  resultsSummaryJsonSchema,
  SUMMARY_KIND,
  SUMMARY_VERSION,
  type SummaryCheck,
  type SummaryHeal,
  type SummaryStep,
  type SummaryTest,
} from "./json.js";
export { renderJunit } from "./junit.js";
export {
  ARTIFACT_LINK_PREFIX,
  DEFAULT_MARKDOWN_MAX,
  fillArtifactLinks,
  GITHUB_COMMENT_LIMIT,
  type MarkdownOptions,
  renderMarkdownSummary,
} from "./markdown.js";
export {
  buildModel,
  CAUSE_LABEL,
  type FailureGroup,
  type ReportModel,
  type RunData,
  type TestView,
  VERDICT_LABEL,
} from "./model.js";
export {
  formatRunSummary,
  formatTerminal,
  formatTestLine,
  type TerminalOptions,
  type TestLineInput,
} from "./terminal.js";
export { type ColorTokens, defaultTokens, type ReportTokens, tokensToCss } from "./tokens.js";
