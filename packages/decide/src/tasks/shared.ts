import { z } from "zod";
import data from "./signals.json" with { type: "json" };

/** The word lists and patterns (signals.json), compiled once. */
export const SIGNALS = data;

/** One case-insensitive regex that matches any of `patterns`. */
export function anyOf(patterns: readonly string[]): RegExp {
  return new RegExp(patterns.map((p) => `(?:${p})`).join("|"), "i");
}

/** The first pattern match in any of `texts`, with where it was found. */
export function findMatch(
  pattern: RegExp,
  texts: readonly (readonly [where: string, text: string | null | undefined])[],
): { where: string; match: string } | undefined {
  for (const [where, text] of texts) {
    const found = text ? pattern.exec(text) : null;
    if (found) return { where, match: found[0] };
  }
  return undefined;
}

/**
 * Lowercased text with volatile parts replaced: quoted values, numbers, money,
 * emails, URLs, ids and hashes. Two failures that differ only in those match.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")
    .replace(/(['"`‘’“”])(?:(?!\1).){0,200}\1/g, "<value>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<id>")
    .replace(/[$€£]\s?\d[\d,.]*/g, "<money>")
    .replace(/\d+(?:[.,]\d+)*/g, "<n>")
    .replace(/[^\p{L}\p{N}<>\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content words of a text (no stop words), lowercased. */
export function words(text: string, stop: readonly string[]): string[] {
  const skip = new Set(stop);
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0 && !skip.has(w));
}

/** Jaccard similarity of two word lists (0–1); 1 when both are empty. */
export function similarity(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Shortens page-derived text for a model's state. */
export const clip = (text: string | null | undefined, max = 400): string =>
  !text ? "" : text.length > max ? `${text.slice(0, max)}…` : text;

/** A contract EvidenceRef, as the task inputs carry it. */
export const evidenceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("check"),
    attempt: z.number().int().min(1),
    checkId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("step"),
    attempt: z.number().int().min(1),
    stepIndex: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal("decision"),
    attempt: z.number().int().min(1),
    decisionId: z.string().min(1),
  }),
  z.object({ kind: z.literal("artifact"), path: z.string().min(1) }),
]);
