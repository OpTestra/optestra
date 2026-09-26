import { printExactOp } from "./exact.js";
import { hash16 } from "./hash.js";
import type { Step, Template } from "./model.js";

/*
 * textKey (REP-4, REP-7): identifies a step's recording independently of the
 * steps around it.
 *
 *   textKey = FNV-1a-64 hex of JSON ["k1", kind, flowChain, normalizedText, occurrence]
 *
 * - normalizedText: whitespace collapsed and trimmed, curly/single quotes and
 *   backticks turned into ", variable references written {{ns.name}} by NAME
 *   (values never enter the key, so one login recording serves many users).
 * - flowChain: project-relative paths of the flows the step came through,
 *   outermost first ([] for the test's own steps).
 * - occurrence: 0 for the first step with the same kind, chain and text in the
 *   expansion, 1 for the next, …
 *
 * Adding, removing or rewording a step changes no other step's key, except that
 * a new step identical to a later one shifts that one's occurrence.
 * LOOP combines textKey + route/screen + engine version into the contract's
 * `StepResult.key`; this package never sees routes.
 */

const QUOTES = /[‘’‚‛′“”„‟″«»'`]/g;

export function normalizeText(text: string): string {
  return text.replace(QUOTES, '"').replace(/\s+/g, " ").trim();
}

/** A template with references by name and literal text normalized. */
export function normalizeTemplate(template: Template): string {
  return normalizeText(
    template.segments
      .map((s) => (s.kind === "text" ? s.text.replace(/\{\{/g, "\\{{") : `{{${s.ns}.${s.name}}}`))
      .join(""),
  );
}

/** The normalized text of a step, as it enters the key. */
export function stepKeyText(step: Step): string {
  switch (step.kind) {
    case "flow":
      return normalizeText(
        `${step.path} ${Object.entries(step.params)
          .map(([k, v]) => `${k}=${normalizeTemplate(v)}`)
          .join(" ")}`,
      );
    case "exact":
      return step.exact.form === "op"
        ? normalizeText(printExactOp(step.exact.op, normalizeTemplate))
        : normalizeText(step.exact.code);
    default:
      return normalizeTemplate(step.text);
  }
}

export const TEXT_KEY_VERSION = "k1";

export function textKey(
  kind: Step["kind"],
  chain: readonly string[],
  text: string,
  occurrence: number,
) {
  return hash16(JSON.stringify([TEXT_KEY_VERSION, kind, chain, text, occurrence]));
}

/** Hands out occurrence numbers per (kind, chain, text). */
export class KeyCounter {
  readonly #seen = new Map<string, number>();

  next(kind: Step["kind"], chain: readonly string[], text: string): string {
    const id = JSON.stringify([kind, chain, text]);
    const occurrence = this.#seen.get(id) ?? 0;
    this.#seen.set(id, occurrence + 1);
    return textKey(kind, chain, text, occurrence);
  }
}
