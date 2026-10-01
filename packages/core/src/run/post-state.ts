import type { StepResult } from "@optestra/contract";
import { type ExpectPost, routeOf, type TemplateVariable } from "@optestra/recording";
import { pageTemplate } from "../author/commands.js";
import type { ActionOutcome, ElementSummary, Observation } from "../target/harness.js";

// VER-5 at replay: the replayed command's recorded effect must show up. The
// recording says what happened when the step was recorded (URL change,
// elements that appeared or went away, requests, a reorder); the page is
// compared in the same template form (values by reference, secrets by name),
// so one recording works for every test user.
//
// The rule is deliberately "some of the recorded effect shows up", not "all of
// it": toasts come and go, lists hold other rows, and a cosmetic build rewords
// labels. Whether the effect was the RIGHT one is for the checks to say (a
// login that lands on an error page fails at "the page heading is Dashboard").

export type PostCheck = NonNullable<StepResult["postState"]>;

type ElementRef = { role: string; name: string; text?: string | undefined };

const MAX_SHOWN = 4;

function describeElements(list: readonly ElementRef[]): string {
  const shown = list
    .slice(0, MAX_SHOWN)
    .map(
      (e) =>
        `${e.role}${e.name ? ` "${e.name}"` : ""}${e.text ? `: "${e.text.slice(0, 40)}"` : ""}`,
    );
  return `${shown.join(", ")}${list.length > MAX_SHOWN ? ` (+${list.length - MAX_SHOWN})` : ""}`;
}

/** What the recording expects, in words. */
export function describeExpectPost(expect: ExpectPost): string {
  const parts: string[] = [];
  if (expect.urlChange) parts.push(`the page changes to ${expect.urlChange}`);
  if (expect.appeared?.length) parts.push(`appears: ${describeElements(expect.appeared)}`);
  if (expect.removed?.length) parts.push(`goes away: ${describeElements(expect.removed)}`);
  if (expect.requests?.length)
    parts.push(
      `requests: ${expect.requests
        .slice(0, MAX_SHOWN)
        .map((r) => `${r.method} ${r.route}${r.status ? ` ${r.status}` : ""}`)
        .join(", ")}`,
    );
  if (expect.reordered) parts.push("the elements are reordered");
  return parts.join("; ");
}

/** True when the recording holds something to compare with. */
export function checkable(expect: ExpectPost): boolean {
  return Boolean(
    expect.urlChange ||
      expect.appeared?.length ||
      expect.removed?.length ||
      expect.requests?.length ||
      expect.reordered,
  );
}

const norm = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** Page elements in template form, like the recording. */
function templated(list: readonly ElementSummary[], variables: readonly TemplateVariable[]) {
  return list.map((e) => ({
    role: e.role,
    name: norm(pageTemplate(e.name, variables)),
    ...(e.text !== undefined ? { text: norm(pageTemplate(e.text, variables)) } : {}),
  }));
}

/** Same role, and the same name, or (when the name was reworded) the same text. */
function sameElement(recorded: ElementRef, seen: ElementRef): boolean {
  if (recorded.role !== seen.role) return false;
  const name = norm(recorded.name);
  const text = norm(recorded.text);
  if (name && name === seen.name) return !text || !seen.text || text === seen.text;
  return Boolean(text) && text === norm(seen.text);
}

export interface PostMatch {
  urlMatched: boolean | null;
  effects: string[];
}

/** Which parts of the recorded effect showed up in an action's outcome. */
export function matchOutcome(
  expect: ExpectPost,
  outcome: ActionOutcome,
  variables: readonly TemplateVariable[],
): PostMatch {
  const post = outcome.post;
  const effects: string[] = [];
  const urlMatched =
    expect.urlChange === undefined ? null : routeOf(post.urlAfter) === expect.urlChange;
  if (urlMatched) effects.push(`page changed to ${expect.urlChange}`);
  const added = templated(post.added, variables);
  const removed = templated(post.removed, variables);
  const appeared = (expect.appeared ?? []).filter((r) => added.some((a) => sameElement(r, a)));
  if (appeared.length) effects.push(`appeared: ${describeElements(appeared)}`);
  const gone = (expect.removed ?? []).filter((r) => removed.some((a) => sameElement(r, a)));
  if (gone.length) effects.push(`went away: ${describeElements(gone)}`);
  const requests = (expect.requests ?? []).filter((r) =>
    post.requests.some(
      (seen) =>
        seen.method === r.method && routeOf(seen.url) === r.route && seen.status !== "refused",
    ),
  );
  if (requests.length)
    effects.push(`requests: ${requests.map((r) => `${r.method} ${r.route}`).join(", ")}`);
  if (expect.reordered && post.reordered) effects.push("the elements were reordered");
  return { urlMatched, effects };
}

/** The element acted on: as recorded, and (after a heal) as it is called now. */
export interface ActedElement {
  role: string;
  name: string;
  /** Its name now, when a heal found it under a new one. */
  renamedTo?: string;
}

/** The recorded effect with the healed element's old name replaced by its new one. */
function renamed(expect: ExpectPost, self: ActedElement | undefined): ExpectPost {
  if (!self?.renamedTo || self.renamedTo === self.name) return expect;
  const map = (list: ExpectPost["appeared"]) =>
    list?.map((e) =>
      e.role === self.role && e.name === self.name ? { ...e, name: self.renamedTo as string } : e,
    );
  return {
    ...expect,
    ...(expect.appeared ? { appeared: map(expect.appeared) } : {}),
    ...(expect.removed ? { removed: map(expect.removed) } : {}),
  };
}

/**
 * The recording saw only the acted element itself change (its own state
 * flickering), not what the action did: weak evidence, so any real change of
 * the page counts.
 */
function onlySelf(expect: ExpectPost, self: ActedElement | undefined): boolean {
  if (!self || expect.urlChange || expect.requests?.length || expect.reordered) return false;
  const all = [...(expect.appeared ?? []), ...(expect.removed ?? [])];
  return all.length > 0 && all.every((e) => e.role === self.role && e.name === self.name);
}

/** The post-state verdict for one outcome: verified, mismatch, or nothing to compare. */
export function verifyOutcome(
  recorded: ExpectPost,
  outcome: ActionOutcome,
  variables: readonly TemplateVariable[],
  self?: ActedElement,
): PostCheck {
  const expect = renamed(recorded, self);
  if (!checkable(expect))
    return { status: "not_checkable", expected: null, observed: observedText(outcome, variables) };
  if (onlySelf(recorded, self) && (outcome.post.changed || outcome.post.reordered))
    return {
      status: "verified",
      expected: describeExpectPost(expect),
      observed: observedText(outcome, variables),
    };
  // Any recorded effect counts, a matching URL included. A page that changed in
  // another way (a different URL, other elements) is for the checks to judge; a
  // page where none of the recorded effect shows is a VER-5 failure.
  const match = matchOutcome(expect, outcome, variables);
  const ok = match.effects.length > 0;
  return {
    status: ok ? "verified" : "mismatch",
    expected: describeExpectPost(expect),
    observed: ok ? match.effects.join("; ") : observedText(outcome, variables),
  };
}

/** What the page did, in words (for a mismatch). */
export function observedText(
  outcome: ActionOutcome,
  variables: readonly TemplateVariable[],
): string {
  const post = outcome.post;
  const parts: string[] = [];
  if (post.urlAfter !== post.urlBefore) parts.push(`the page changed to ${routeOf(post.urlAfter)}`);
  if (post.added.length)
    parts.push(`appeared: ${describeElements(templated(post.added, variables))}`);
  if (post.removed.length)
    parts.push(`went away: ${describeElements(templated(post.removed, variables))}`);
  const requests = post.requests.filter((r) => r.status !== "refused");
  if (requests.length)
    parts.push(
      `requests: ${requests
        .slice(0, MAX_SHOWN)
        .map((r) => `${r.method} ${routeOf(r.url)} ${r.status}`)
        .join(", ")}`,
    );
  if (post.reordered) parts.push("the elements were reordered");
  return parts.length ? parts.join("; ") : "nothing changed on the page";
}

/**
 * A second look after a short wait (settle can return before a click's async
 * work starts): the recorded URL, or a recorded element now on the page.
 */
export function lateMatch(
  expect: ExpectPost,
  url: string,
  observation: Observation,
  variables: readonly TemplateVariable[],
): string | null {
  if (expect.urlChange !== undefined && routeOf(url) === expect.urlChange)
    return `page changed to ${expect.urlChange} a moment later`;
  const now = templated(observation.elements, variables);
  const appeared = (expect.appeared ?? []).filter(
    (r) => r.role !== "textbox" && now.some((e) => sameElement(r, e)),
  );
  if (appeared.length) return `appeared a moment later: ${describeElements(appeared)}`;
  return null;
}
