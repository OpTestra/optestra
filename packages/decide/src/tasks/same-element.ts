import { z } from "zod";
import { canonicalJson } from "../cache.js";
import { defineTask, type Evidence, untrusted } from "../task.js";
import { compareNames, type NameRelation } from "./names.js";
import data from "./same-element.json" with { type: "json" };

/**
 * same_element (REP-5, HEAL-1 level 1): is this live candidate the element the
 * step was recorded on? The dangerous mistake is a wrong "same" (a replay acts
 * on the wrong button and hides a behaviour change), so the rules only say
 * "same" on strong agreement and escalate anything doubtful. Signal weights and
 * thresholds live in same-element.json.
 */

export const SAME_ELEMENT_SIGNALS = data;
const W = data.weights;
const NAME_SCORE = data.nameScores as Record<Exclude<NameRelation, "unknown">, number>;

const box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

/** The element facts both sides share (recording's Fingerprint / browser's ElementFacts). */
export const elementIdentitySchema = z.object({
  role: z.string().max(60),
  /** Accessible name. */
  name: z.string().max(300),
  tag: z.string().max(30),
  attributes: z.record(z.string().max(40), z.string().max(300)),
  /** Visible text ("" when unknown: fingerprints don't store it). */
  text: z.string().max(300),
  /** Closest heading, legend, label or landmark name. */
  anchorText: z.string().max(300),
  /** The iframe path from the page to the element's frame (locator specs). */
  framePath: z.array(z.record(z.string(), z.unknown())).max(5),
  box: box.nullable(),
});
export type ElementIdentity = z.infer<typeof elementIdentitySchema>;

export const sameElementInput = z.object({
  recorded: elementIdentitySchema,
  candidate: elementIdentitySchema.extend({
    /** Which locator found it: the stored primary, a stored fallback, or a re-find over the page. */
    foundBy: z.enum(["primary", "fallback", "refind"]),
    /** How many elements that locator matched (more than 1 means it is ambiguous). */
    matches: z.number().int().min(0),
  }),
});
export type SameElementInput = z.infer<typeof sameElementInput>;

export interface ScoredSignal {
  signal: "role" | "name" | "text" | "test_id" | "attributes" | "anchor" | "frame" | "position";
  /** -1 (different) … 1 (same); null when unknown on either side. */
  score: number | null;
  weight: number;
  detail: string;
}

const hrefPath = (href: string) => {
  try {
    return new URL(href, "http://x").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return href;
  }
};
const lastToken = (id: string) =>
  id
    .toLowerCase()
    .split(/[-_:.\s]+/)
    .filter(Boolean)
    .at(-1) ?? "";
const q = (text: string) => `'${text.length > 60 ? `${text.slice(0, 60)}…` : text}'`;

/** Scores every signal and derives the facts the rules need. Pure and fast. */
export function scoreSameElement(input: SameElementInput) {
  const { recorded: r, candidate: c } = input;
  const signals: ScoredSignal[] = [];
  const add = (signal: ScoredSignal["signal"], score: number | null, detail: string) =>
    signals.push({ signal, score, weight: W[signal], detail });

  const roleEqual = r.role.toLowerCase() === c.role.toLowerCase();
  add("role", roleEqual ? 1 : -1, `${r.role} ${roleEqual ? "=" : "≠"} ${c.role}`);

  const name = compareNames(r.name, c.name);
  add(
    "name",
    name === "unknown" ? null : NAME_SCORE[name],
    `${q(r.name)} → ${q(c.name)} (${name})`,
  );

  const text = r.text && c.text ? compareNames(r.text, c.text) : "unknown";
  add(
    "text",
    text === "unknown" ? null : NAME_SCORE[text],
    text === "unknown" ? "not recorded" : `${q(r.text)} → ${q(c.text)} (${text})`,
  );

  const tr = r.attributes["data-testid"];
  const tc = c.attributes["data-testid"];
  const testIdEqual = Boolean(tr && tc && tr === tc);
  const testIdUnrelated = Boolean(tr && tc && tr !== tc && lastToken(tr) !== lastToken(tc));
  add(
    "test_id",
    tr && tc ? (testIdEqual ? 1 : testIdUnrelated ? -0.5 : 0.3) : null,
    tr && tc ? `${tr} → ${tc}` : "not on both",
  );

  // Key attributes present on both sides.
  let hrefDiffers = false;
  let typeDiffers = false;
  const attrScores: number[] = [];
  const attrDetail: string[] = [];
  for (const key of data.keyAttributes) {
    const a = r.attributes[key];
    const b = c.attributes[key];
    if (a === undefined || b === undefined) continue;
    let score: number;
    if (key === "href") {
      const same = hrefPath(a) === hrefPath(b);
      hrefDiffers = !same;
      score = same ? 1 : -1;
    } else if (key === "type") {
      typeDiffers = a.toLowerCase() !== b.toLowerCase();
      score = typeDiffers ? -1 : 1;
    } else if (key === "name" || key === "for") {
      // Field names and label targets change with cosmetic id renames: agreement counts, a change doesn't.
      score = a === b ? 1 : 0;
    } else {
      const rel = compareNames(a, b);
      score = rel === "unknown" ? 0 : NAME_SCORE[rel];
    }
    attrScores.push(score);
    attrDetail.push(`${key} ${a === b ? "=" : `${q(a)} → ${q(b)}`}`);
  }
  add(
    "attributes",
    attrScores.length ? attrScores.reduce((x, y) => x + y, 0) / attrScores.length : null,
    attrDetail.join("; ") || "none on both",
  );

  const anchor =
    r.anchorText && c.anchorText ? compareNames(r.anchorText, c.anchorText) : "unknown";
  const anchorSame = anchor === "equal" || anchor === "near" || anchor === "synonym";
  const anchorDifferent = anchor === "different" || anchor === "opposite";
  add(
    "anchor",
    anchor === "unknown" ? null : anchorSame ? 1 : anchor === "partial" ? -0.5 : -1,
    anchor === "unknown" ? "not on both" : `${q(r.anchorText)} → ${q(c.anchorText)} (${anchor})`,
  );

  const frameEqual = canonicalJson(r.framePath) === canonicalJson(c.framePath);
  add(
    "frame",
    frameEqual ? 1 : -1,
    frameEqual ? (r.framePath.length ? "same frame" : "both in the page") : "different frame",
  );

  let distance: number | null = null;
  if (r.box && c.box) {
    const cx = (b: NonNullable<typeof r.box>) => [b.x + b.width / 2, b.y + b.height / 2] as const;
    const [ax, ay] = cx(r.box);
    const [bx, by] = cx(c.box);
    distance = Math.hypot(ax - bx, ay - by);
  }
  const { nearPx, farPx } = data.position;
  // Layouts move for cosmetic reasons, so distance never counts against; nearness only helps.
  add(
    "position",
    distance === null
      ? null
      : distance <= nearPx
        ? 1
        : distance >= farPx
          ? 0
          : 1 - (distance - nearPx) / (farPx - nearPx),
    distance === null ? "no box on both" : `${Math.round(distance)} px apart`,
  );

  const known = signals.filter((s) => s.score !== null);
  const totalWeight = known.reduce((sum, s) => sum + s.weight, 0);
  const combined = totalWeight
    ? known.reduce((sum, s) => sum + s.weight * (s.score ?? 0), 0) / totalWeight
    : 0;
  return {
    signals,
    combined: Math.round(combined * 1000) / 1000,
    roleEqual,
    name,
    nameSameMeaning: name === "equal" || name === "near" || name === "synonym",
    anchor,
    anchorSame,
    anchorDifferent,
    testIdEqual,
    testIdUnrelated,
    hrefDiffers,
    typeDiffers,
    frameEqual,
    ambiguous: c.matches > 1,
    near: distance !== null && distance <= nearPx,
  };
}

const evidenceOf = (signals: ScoredSignal[]): Evidence[] =>
  signals.map((s) => ({
    signal: s.signal,
    detail: s.detail,
    ...(s.score === null ? {} : { score: Math.round(s.score * 100) / 100 }),
    weight: s.weight,
  }));

export const sameElement = defineTask({
  name: "same_element",
  version: 1,
  description: "Is this live element the one the step was recorded on?",
  phase: "during",
  input: sameElementInput,
  questions: {
    same: {
      kind: "noul",
      instructions:
        "The candidate is the same element the step was recorded on: the same control with the same purpose, even if its styling, position, id, CSS class or wording changed slightly.",
    },
  },
  rules(input) {
    const s = scoreSameElement(input);
    const evidence = evidenceOf(s.signals);
    const answer = (same: boolean, confidence: number, why: string) => ({
      answers: { same },
      confidence,
      evidence: [{ signal: same ? "decided_same" : "decided_different", detail: why }, ...evidence],
    });
    // Hard contradictions: a different element.
    if (!s.frameEqual) return answer(false, 0.95, "in a different frame");
    if (!s.roleEqual) return answer(false, 0.92, "a different role");
    if (s.name === "opposite") return answer(false, 0.93, "the opposite action");
    if (s.typeDiffers && input.recorded.tag === "input" && input.candidate.tag === "input")
      return answer(false, 0.9, "a different kind of field");
    if (s.hrefDiffers && !s.nameSameMeaning) return answer(false, 0.9, "links to a different page");
    if (s.anchorDifferent && (s.name === "different" || s.name === "partial"))
      return answer(false, 0.88, "a different name in a different section");
    // Same name in another section (the neighbouring plan card, the other dialog's Cancel).
    if (s.anchorDifferent && !s.testIdEqual) return answer(false, 0.85, "in a different section");
    // Strong agreement, and nothing ambiguous.
    const clean = !s.hrefDiffers && !s.typeDiffers && (!s.ambiguous || s.near);
    // A test id identifies an element only when it is unique on the page.
    if (s.testIdEqual && clean && !s.ambiguous && !s.anchorDifferent)
      return answer(true, 0.95, "same unique test id and role");
    if (s.nameSameMeaning && s.anchorSame && clean)
      return answer(true, 0.9, "same role, name and section");
    // No section on either side (a lone field in a small frame): the same name and
    // key attributes, in the same place (or, when it moved, with two key attributes
    // agreeing) say it all; nothing may disagree.
    const noSection = !input.recorded.anchorText && !input.candidate.anchorText;
    const attributes = s.signals.find((x) => x.signal === "attributes")?.score ?? null;
    const agreeing = data.keyAttributes.filter((key) => {
      const value = input.recorded.attributes[key];
      return value !== undefined && value === input.candidate.attributes[key];
    }).length;
    if (
      noSection &&
      s.name === "equal" &&
      clean &&
      !s.ambiguous &&
      attributes === 1 &&
      (s.near || agreeing >= 2)
    )
      return answer(true, 0.88, "same role, name and key attributes, no section on either side");
    // In between: never a guess. The best view goes along as evidence.
    return { answers: { same: s.combined > 0 }, confidence: 0.5, evidence };
  },
  state({ recorded, candidate }) {
    const facts = (e: ElementIdentity) =>
      [
        `role: ${e.role}`,
        `accessible name: ${e.name}`,
        `tag: ${e.tag}`,
        `text: ${e.text || "?"}`,
        `section (nearest heading/label): ${e.anchorText || "?"}`,
        `attributes: ${
          Object.entries(e.attributes)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ") || "none"
        }`,
        `frame: ${e.framePath.length ? canonicalJson(e.framePath) : "page"}`,
        `box: ${e.box ? `${Math.round(e.box.x)},${Math.round(e.box.y)} ${Math.round(e.box.width)}×${Math.round(e.box.height)}` : "?"}`,
      ].join("\n");
    return [
      untrusted("recorded-element", facts(recorded)),
      untrusted("candidate-element", facts(candidate)),
      `The candidate was found by the ${candidate.foundBy} locator, which matched ${candidate.matches} element(s).`,
    ].join("\n");
  },
  evidence(input) {
    return evidenceOf(scoreSameElement(input).signals);
  },
  onEscalate: "fixer",
});
