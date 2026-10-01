import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Accessibility warnings (EVD-6): axe-core's WCAG 2 A and AA rules on a page.
// Warnings only: never part of a verdict. axe runs in the page (CDP evaluate,
// not a script tag, so the page's CSP doesn't stop it) and is removed after.

/** The axe tags checked: WCAG 2.0/2.1/2.2 levels A and AA. */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

export interface AccessibilityViolation {
  rule: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  help: string;
  helpUrl: string;
  /** Elements that fail the rule. */
  nodes: number;
  /** CSS selectors of the first few. */
  targets: string[];
}

export interface AccessibilityScan {
  status: "ok" | "error";
  ms: number;
  violations: AccessibilityViolation[];
  message?: string;
}

let source: string | undefined;
/** axe-core's script, read once. */
export function axeSource(): string {
  source ??= readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  return source;
}

/** The page-side script: runs axe on the document and returns plain data. */
export function axeScript(): string {
  return `(async () => {
  ${axeSource()}
  try {
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: ${JSON.stringify(WCAG_TAGS)} },
      resultTypes: ["violations"],
    });
    return result.violations.map((v) => ({
      rule: v.id,
      impact: v.impact ?? null,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => [].concat(n.target).join(" ")),
    }));
  } finally {
    try { delete window.axe; } catch {}
  }
})()`;
}
