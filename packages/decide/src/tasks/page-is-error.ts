import { z } from "zod";
import { defineTask, untrusted } from "../task.js";

/**
 * Demo task (DEC-0): is the page in front of us an error page? Not wired into
 * the runner; it exercises every path of the pipeline.
 */

/** Phrases that mark an error page when they appear in the title or main heading. */
const ERROR_PHRASES = [
  "internal server error",
  "server error",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "page not found",
  "404 not found",
  "not found",
  "something went wrong",
  "application error",
  "an error occurred",
  "an error has occurred",
  "unexpected error",
  "we're sorry",
  "oops",
];
const ERROR_CODES = /\b(4\d\d|5\d\d)\b/;

const hasPhrase = (text: string) => {
  const lower = text.toLowerCase().replaceAll("’", "'");
  return ERROR_PHRASES.some((phrase) => lower.includes(phrase));
};

export const pageIsErrorInput = z.object({
  /** HTTP status of the main document; null when unknown (e.g. a client-side route). */
  status: z.number().int().min(100).max(599).nullable(),
  title: z.string().max(500),
  /** The main heading (first h1 or equivalent); empty when there is none. */
  heading: z.string().max(500),
  /** A sample of the visible text. */
  text: z.string().max(4000),
});
export type PageIsErrorInput = z.infer<typeof pageIsErrorInput>;

export const pageIsError = defineTask({
  name: "page_is_error",
  version: 1,
  description: "Is the current page an error page (server error, not found, crash)?",
  phase: "during",
  input: pageIsErrorInput,
  questions: {
    is_error: {
      kind: "noul",
      instructions:
        "This page is an error page (a server error, not-found or crash page) rather than the page the user meant to reach.",
    },
  },
  rules({ status, title, heading, text }) {
    if (status !== null && status >= 500) return { answers: { is_error: true }, confidence: 0.97 };
    const top = `${title}\n${heading}`;
    if (hasPhrase(top) || (status !== null && status >= 400 && ERROR_CODES.test(top)))
      return { answers: { is_error: true }, confidence: 0.92 };
    // A phrase only in the body is a weak signal ("Not found? Contact us"): let a model look.
    if (hasPhrase(text)) return { answers: { is_error: true }, confidence: 0.6 };
    if (status !== null && status >= 200 && status < 300 && heading.trim() !== "")
      return { answers: { is_error: false }, confidence: 0.9 };
    return null;
  },
  state({ status, title, heading, text }) {
    return [
      `HTTP status: ${status ?? "unknown"}`,
      untrusted("page-title", title),
      untrusted("page-heading", heading),
      untrusted("page-text", text),
    ].join("\n");
  },
  onEscalate: "fixer",
});
