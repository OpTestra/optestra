import { looseName, opposite, synonymous } from "./heal-class.js";
import { SIGNALS, words } from "./shared.js";

/**
 * How two accessible names relate, shared by same_element and heal_class:
 * equal (ignoring case, punctuation, whitespace), near (the same words once
 * stop and filler words are dropped), synonym (from the synonyms list),
 * opposite (Save ↔ Cancel), partial (some words shared) or different.
 */
export type NameRelation =
  | "equal"
  | "near"
  | "synonym"
  | "opposite"
  | "partial"
  | "different"
  | "unknown";

const H = SIGNALS.heal_class;
const FILLER = new Set(H.rewordFiller);

export function compareNames(
  a: string | null | undefined,
  b: string | null | undefined,
): NameRelation {
  const left = looseName(a ?? null);
  const right = looseName(b ?? null);
  if (!left || !right) return left === right && left !== null ? "equal" : "unknown";
  if (left === right) return "equal";
  if (opposite(left, right)) return "opposite";
  if (synonymous(left, right)) return "synonym";
  const wa = words(left, H.stopWords);
  const wb = words(right, H.stopWords);
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const shared = shorter.filter((w) => longer.includes(w));
  if (
    shared.length > 0 &&
    shared.length === shorter.length &&
    longer.filter((w) => !shorter.includes(w)).every((w) => FILLER.has(w))
  )
    return "near";
  return shared.length > 0 ? "partial" : "different";
}
