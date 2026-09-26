import type { ActionOutcome, CandidatesResult, ElementSummary } from "@testament/browser";
import {
  type Command,
  type ExpectPost,
  type Fingerprint,
  type Locator,
  type RecordedAction,
  routeOf,
  type TemplateVariable,
  toTemplate,
} from "@testament/recording";

// Turning what the harness did into recorded commands: locators instead of refs
// (the top unique candidate first), the element's fingerprint, what replay
// should see afterwards (VER-5) and how long the page took to settle (LRN-4).
// Every page string goes through the step's variables, so values become
// templates and secret labels become `{{secret.NAME}}` (REP-7).

const MAX_ELEMENTS = 10;
const TRACKED_REQUESTS = new Set(["document", "fetch", "xhr"]);

/** Page text → template: variable values by reference, `[secret:X]` → `{{secret.X}}`. */
export function pageTemplate(text: string, variables: readonly TemplateVariable[]): string {
  return toTemplate(text, variables).replace(/\[secret:([A-Z][A-Z0-9_]*)\]/g, "{{secret.$1}}");
}

/** The locator and fingerprint for an element, from `candidates(ref)`. */
export function fingerprintOf(
  result: CandidatesResult,
): { primary: Locator; fingerprint: Fingerprint } | undefined {
  if (result.status !== "ok" || result.candidates.length === 0 || !result.facts) return undefined;
  const ordered = [
    ...result.candidates.filter((c) => c.unique),
    ...result.candidates.filter((c) => !c.unique),
  ];
  const [first, ...rest] = ordered.map((c) => c.locator as Locator);
  if (!first) return undefined;
  const facts = result.facts;
  return {
    primary: first,
    fingerprint: {
      primary: first,
      fallbacks: rest,
      role: facts.role,
      name: facts.name,
      tag: facts.tag,
      attributes: facts.attributes,
      anchorText: facts.anchorText,
      framePath: facts.framePath as Locator[] as Fingerprint["framePath"],
      box: facts.box,
    },
  };
}

function elements(list: readonly ElementSummary[], variables: readonly TemplateVariable[]) {
  return list.slice(0, MAX_ELEMENTS).map((element) => {
    const out: { role: string; name: string; text?: string } = {
      role: element.role,
      name: pageTemplate(element.name, variables),
    };
    if (element.text !== undefined) out.text = pageTemplate(element.text, variables);
    return out;
  });
}

/** What replay should see after the command. */
export function expectPostOf(
  outcome: ActionOutcome,
  variables: readonly TemplateVariable[],
): ExpectPost {
  const post = outcome.post;
  const expect: ExpectPost = {};
  if (post.urlAfter !== post.urlBefore) expect.urlChange = routeOf(post.urlAfter);
  if (post.added.length) expect.appeared = elements(post.added, variables);
  if (post.removed.length) expect.removed = elements(post.removed, variables);
  const requests = post.requests
    .filter((r) => TRACKED_REQUESTS.has(r.resourceType) && r.status !== "refused")
    .map((r) => {
      const request: { method: string; route: string; status?: number } = {
        method: r.method,
        route: routeOf(r.url),
      };
      if (typeof r.status === "number") request.status = r.status;
      return request;
    });
  if (requests.length) expect.requests = requests;
  return expect;
}

export function commandOf(
  action: RecordedAction,
  fingerprint: Fingerprint | null,
  outcome: ActionOutcome,
  variables: readonly TemplateVariable[],
): Command {
  return {
    action,
    fingerprint,
    expectPost: expectPostOf(outcome, variables),
    wait: { settledMs: outcome.settle.settledMs, waitedFor: outcome.settle.waitedFor },
  };
}
