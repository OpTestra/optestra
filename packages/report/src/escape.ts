// Tiny hand-written escaping (no template engine). Every contract string goes
// through one of these before it reaches an output.

const HTML: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML[char] ?? char);
}

/** Characters XML 1.0 cannot carry at all, even escaped. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are exactly the characters to drop
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Escapes text for XML content and quoted attributes, dropping characters XML forbids. */
export function escapeXml(text: string): string {
  return escapeHtml(text.replace(XML_INVALID, "")).replace(/\r/g, "&#13;");
}

/** Escapes an attribute value that may contain newlines (kept as character references). */
export function escapeXmlAttr(text: string): string {
  return escapeXml(text).replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

/**
 * Escapes one line of text for GitHub Markdown: no HTML, no formatting, no
 * links, no table breaks, and no @mentions that would notify people.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/[&<>]/g, (char) => HTML[char] ?? char)
    .replace(/[\\`*_{}[\]()#+!|~$]/g, "\\$&")
    .replace(/@/g, "@⁠");
}

/** Text for inside a Markdown code span: backticks can't be escaped there, so they are swapped. */
export function markdownCode(text: string): string {
  return `\`${text.replace(/[\r\n]+/g, " ").replace(/`/g, "'")}\``;
}

/** A run-folder-relative path as a URL path: each segment percent-encoded, "/" kept. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((part) => (part === ".." || part === "." ? part : encodeURIComponent(part)))
    .join("/");
}
