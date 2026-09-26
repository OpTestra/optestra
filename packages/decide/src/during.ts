import { createDecisions, type DecisionResult, type Decisions } from "./decide.js";
import type { Evidence } from "./task.js";
import { blockedReasonFor, type MissAction, type MissActionInput } from "./tasks/miss-action.js";
import {
  type ElementIdentity,
  SAME_ELEMENT_SIGNALS,
  type SameElementInput,
  scoreSameElement,
} from "./tasks/same-element.js";

/**
 * During-run glue for replay (LOOP-4) and healing (HEAL): the recording's
 * Fingerprint and the browser's ElementFacts in, identity and next action out.
 * Pure and browser-safe; the shapes mirror @testament/recording and
 * @testament/browser structurally, so neither is imported.
 */

type Box = { x: number; y: number; width: number; height: number } | null;

/** @testament/recording's Fingerprint (the fields identity needs). */
export interface FingerprintLike {
  role: string;
  name: string;
  tag: string;
  attributes: Record<string, string>;
  anchorText: string;
  framePath: readonly object[];
  box: Box;
}

/** @testament/browser's ElementFacts. */
export interface ElementFactsLike {
  role: string;
  name: string;
  tag: string;
  attributes: Record<string, string>;
  text: string;
  anchorText: string;
  framePath: readonly object[];
  box: Box;
}

/** One live element to compare with the recording. */
export interface LiveCandidate {
  facts: ElementFactsLike;
  /** Which locator found it. */
  foundBy: "primary" | "fallback" | "refind";
  /** How many elements that locator matched. */
  matches: number;
}

const cut = (text: string, max: number) => text.slice(0, max);
const attrs = (a: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(a)
      .slice(0, 30)
      .map(([k, v]) => [cut(k, 40), cut(v, 300)]),
  );

function identity(e: FingerprintLike | ElementFactsLike, text: string): ElementIdentity {
  return {
    role: cut(e.role, 60),
    name: cut(e.name, 300),
    tag: cut(e.tag, 30),
    attributes: attrs(e.attributes),
    text: cut(text, 300),
    anchorText: cut(e.anchorText, 300),
    framePath: e.framePath.slice(0, 5) as Record<string, unknown>[],
    box: e.box,
  };
}

/** same_element's input for a fingerprint and one live candidate. */
export function sameElementInputFor(
  fingerprint: FingerprintLike,
  candidate: LiveCandidate,
): SameElementInput {
  return {
    recorded: identity(fingerprint, ""),
    candidate: {
      ...identity(candidate.facts, candidate.facts.text),
      foundBy: candidate.foundBy,
      matches: Math.max(0, Math.floor(candidate.matches)),
    },
  };
}

export interface SameElementAnswer {
  /** true / false when decided; null when it escalated. */
  same: boolean | null;
  decided: boolean;
  confidence: number;
  source: string;
  /** Weighted signal score, -1 … 1 (for ranking and display). */
  score: number;
  /** Per-signal scores and the deciding reason (HEAL-6). */
  evidence: Evidence[];
  result: DecisionResult;
}

const toAnswer = (result: DecisionResult, score: number): SameElementAnswer => {
  if (result.status === "decided")
    return {
      same: Boolean((result.answers as { same: boolean }).same),
      decided: true,
      confidence: result.confidence,
      source: result.source,
      score,
      evidence: result.evidence,
      result,
    };
  return {
    same: null,
    decided: false,
    confidence: result.best?.confidence ?? 0,
    source: result.best?.source ?? "none",
    score,
    evidence: result.best?.evidence ?? [],
    result,
  };
};

/** Is this live candidate the recorded element? Rules first; escalates when doubtful. */
export async function decideSameElement(
  fingerprint: FingerprintLike,
  candidate: LiveCandidate,
  options: { decisions?: Decisions; signal?: AbortSignal } = {},
): Promise<SameElementAnswer> {
  const input = sameElementInputFor(fingerprint, candidate);
  const decisions = options.decisions ?? createDecisions();
  const result = await decisions.decide(
    "same_element",
    input,
    options.signal ? { signal: options.signal } : {},
  );
  return toAnswer(result, scoreSameElement(input).combined);
}

export interface RankedCandidate extends SameElementAnswer {
  /** Position in the list passed in. */
  index: number;
  candidate: LiveCandidate;
}

export interface RankResult {
  /** match: one clear best, decided same. ambiguous: a "same" that isn't clearly ahead. none: nothing decided same. */
  outcome: "match" | "ambiguous" | "none";
  /** The match, only when outcome is match. Never a random pick. */
  best: RankedCandidate | null;
  /** All candidates, best combined score first. */
  ranked: RankedCandidate[];
}

/**
 * Ranks live candidates against a fingerprint. Returns a best match only when
 * it is decided "same" AND clearly ahead of the runner-up (by `margin` in
 * combined score, default from same-element.json) AND the runner-up isn't also
 * "same". Two near-equal matches are ambiguous: escalate, never guess.
 */
export async function rankCandidates(
  fingerprint: FingerprintLike,
  candidates: readonly LiveCandidate[],
  options: { decisions?: Decisions; margin?: number; signal?: AbortSignal } = {},
): Promise<RankResult> {
  if (candidates.length === 0) return { outcome: "none", best: null, ranked: [] };
  const decisions = options.decisions ?? createDecisions();
  const margin = options.margin ?? SAME_ELEMENT_SIGNALS.rank.margin;
  const inputs = candidates.map((c) => sameElementInputFor(fingerprint, c));
  const results = await decisions.decideBatch(
    inputs.map((input) => ({ task: "same_element", input })),
    options.signal ? { signal: options.signal } : {},
  );
  const ranked: RankedCandidate[] = results
    .map((result, index) => ({
      ...toAnswer(result, scoreSameElement(inputs[index] as SameElementInput).combined),
      index,
      candidate: candidates[index] as LiveCandidate,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const [first, second] = ranked;
  if (!first || first.same !== true) {
    const anySame = ranked.some((r) => r.same === true);
    return { outcome: anySame ? "ambiguous" : "none", best: null, ranked };
  }
  const clear = !second || (second.same !== true && first.score - second.score >= margin);
  return clear
    ? { outcome: "match", best: first, ranked }
    : { outcome: "ambiguous", best: null, ranked };
}

export interface MissAnswer {
  action: MissAction | null;
  decided: boolean;
  /** For `block`: the contract BlockedReason to report (app_down, ai_unavailable, budget_exceeded, or the refusal). */
  blockedReason: string | null;
  evidence: Evidence[];
  result: DecisionResult;
}

/** The healing ladder's next step for a missed step (see miss_action). */
export async function decideMiss(
  context: MissActionInput,
  options: { decisions?: Decisions; signal?: AbortSignal } = {},
): Promise<MissAnswer> {
  const decisions = options.decisions ?? createDecisions();
  const result = await decisions.decide(
    "miss_action",
    context,
    options.signal ? { signal: options.signal } : {},
  );
  const action = result.status === "decided" ? (result.answers.action as MissAction) : null;
  return {
    action,
    decided: result.status === "decided",
    blockedReason: action === "block" ? blockedReasonFor(context) : null,
    evidence: result.status === "decided" ? result.evidence : (result.best?.evidence ?? []),
    result,
  };
}

/** Builds miss_action's input from a rank result and the rest of the replay context. */
export function missContext(
  parts: Omit<MissActionInput, "ranking" | "fallbacks"> & {
    fallbacks: { total: number; matched: number; best?: SameElementAnswer | null };
    rank?: RankResult | null;
  },
): MissActionInput {
  const best = parts.fallbacks.best;
  return {
    missReason: parts.missReason,
    refusal: parts.refusal,
    usedElement: parts.usedElement,
    fallbacks: {
      total: parts.fallbacks.total,
      matched: parts.fallbacks.matched,
      sameElement: !best
        ? null
        : best.same === true
          ? "same"
          : best.same === false
            ? "not_same"
            : "unknown",
    },
    ranking: parts.rank
      ? {
          outcome: parts.rank.outcome,
          bestScore: parts.rank.ranked[0]
            ? Math.max(-1, Math.min(1, parts.rank.ranked[0].score))
            : null,
        }
      : { outcome: "not_run", bestScore: null },
    page: parts.page,
    policy: parts.policy,
    budgetLeftUsd: parts.budgetLeftUsd,
    fixerAvailable: parts.fixerAvailable,
  };
}
