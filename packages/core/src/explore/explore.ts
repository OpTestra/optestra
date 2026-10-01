import type { ActionOutcome, Observation, Session } from "@optestra/browser";
import type { ModelCall } from "@optestra/contract";
import {
  assembleDraft,
  type DraftItem,
  type DraftOptions,
  type DraftResult,
  exploreDraft,
} from "../draft/draft.js";
import { labelOf, slugOf } from "../draft/phrasing.js";
import prompt from "./explorer-prompt.json" with { type: "json" };

// Explore (EXPL-1, EXPL-2): the drafter's loop with the explorer's prompt,
// roaming toward a goal, while code (never the model) watches every action and
// page for problems: error pages, server errors and failed requests, console
// errors and uncaught exceptions, broken links, a crashed page, and dead ends.
// Each finding carries its evidence and where it happened; where a regression
// test can be written, it is proposed as a draft. Findings are proposals only:
// nothing is saved, nothing blocks a PR, nothing alerts (EXPL-2).

export const EXPLORE_PROMPT_VERSION: string = prompt.version;

export type FindingKind =
  | "error_page"
  | "server_error"
  | "failed_request"
  | "console_error"
  | "broken_link"
  | "crash"
  | "dead_end";

export interface ExploreFinding {
  id: string;
  kind: FindingKind;
  /** One line for a person. */
  summary: string;
  /** Route where it showed. */
  route: string;
  /** The raw evidence lines (scrubbed page text: untrusted). */
  evidence: string[];
  /** The step after which it showed (0: before any step). */
  afterStep: number;
  /** A regression test for it, as a draft (never saved). */
  proposal?: DraftResult;
}

export interface ExploreOptions
  extends Omit<DraftOptions, "session" | "prompt" | "onObserve" | "onAction"> {
  session: Pick<
    Session,
    | "observe"
    | "act"
    | "screenshot"
    | "url"
    | "check"
    | "pageCopy"
    | "hookRequest"
    | "consoleErrors"
  >;
  /** Same-origin links checked for a 4xx/5xx answer (default 25). */
  linkChecks?: number;
}

export interface ExploreResult {
  goal: string;
  /** The way toward the goal, as a draft: a regression test for it when it was reached. */
  draft: DraftResult;
  findings: ExploreFinding[];
  /** Drafts proposed from the findings. */
  proposals: DraftResult[];
  linksChecked: number;
  modelCalls: ModelCall[];
  promptVersion: string;
  notes: string[];
}

const routeOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

const ERROR_WORDS = /\b(error|not found|went wrong|exception|unavailable|forbidden|denied|oops)\b/i;

/** Explores toward `goal` and reports what went wrong on the way. Saves nothing. */
export async function exploreApp(goal: string, options: ExploreOptions): Promise<ExploreResult> {
  const session = options.session;
  const findings: ExploreFinding[] = [];
  const seen = new Set<string>();
  const checked = new Map<string, number | "failed">();
  const budget = options.linkChecks ?? 25;
  let consoleCursor = session.consoleErrors().length;
  let origin = "";
  let items: readonly DraftItem[] = [];

  const add = (finding: Omit<ExploreFinding, "id">) => {
    const key = `${finding.kind}|${finding.route}|${finding.evidence[0] ?? finding.summary}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ id: `F${findings.length + 1}`, ...finding });
  };

  const collectConsole = (route: string) => {
    const lines = session.consoleErrors(consoleCursor);
    consoleCursor += lines.length;
    if (lines.length)
      add({
        kind: "console_error",
        summary: `${lines.length === 1 ? "A console error" : `${lines.length} console errors`} on ${route}: ${lines[0]?.replace(/^\[\w+\]\s*/, "").slice(0, 160)}`,
        route,
        evidence: lines.slice(0, 5),
        afterStep: items.length,
      });
  };

  /** A page that answered with an error, or that says it is one. */
  const errorPage = (observation: Observation, status: number | null, route: string) => {
    const heading =
      observation.elements.find((e) => e.role === "heading" && e.states.level === 1) ??
      observation.elements.find((e) => e.role === "heading");
    const said = labelOf(heading) ?? observation.title;
    if (status !== null && status >= 400)
      add({
        kind: status >= 500 ? "server_error" : "error_page",
        summary: `${route} answered ${status}${said ? ` ("${said}")` : ""}`,
        route,
        evidence: [`document ${route} → ${status}`, ...(said ? [`heading: ${said}`] : [])],
        afterStep: items.length,
      });
  };

  const checkLinks = async (observation: Observation) => {
    if (!origin) {
      try {
        origin = new URL(observation.url).origin;
      } catch {
        return;
      }
    }
    for (const element of observation.elements) {
      if (checked.size >= budget) return;
      if (element.role !== "link" || !element.url) continue;
      let url: URL;
      try {
        url = new URL(element.url, observation.url);
      } catch {
        continue;
      }
      if (url.origin !== origin || !/^https?:$/.test(url.protocol)) continue;
      const target = `${url.pathname}${url.search}`;
      if (checked.has(target)) continue;
      const answer = await session.hookRequest({ method: "GET", target });
      const status = answer.httpStatus ?? (answer.status === "ok" ? 200 : "failed");
      checked.set(target, status);
      if (status === "failed" || status >= 400)
        add({
          kind: "broken_link",
          summary: `The link "${labelOf(element) ?? target}" on ${routeOf(observation.url)} leads to ${target}, which ${status === "failed" ? "gave no answer" : `answered ${status}`}`,
          route: routeOf(observation.url),
          evidence: [`link "${labelOf(element) ?? ""}" → ${target} → ${status}`],
          afterStep: items.length,
        });
    }
  };

  const onObserve = async (observation: Observation) => {
    collectConsole(routeOf(observation.url));
    await checkLinks(observation);
    return findings.length
      ? [
          `findings so far (recorded, no need to report): ${findings
            .slice(-5)
            .map((f) => f.summary)
            .join("; ")}`,
        ]
      : undefined;
  };

  const onAction = async (info: { outcome: ActionOutcome; items: readonly DraftItem[] }) => {
    items = info.items;
    const { outcome } = info;
    const route = routeOf(outcome.post.urlAfter);
    if (outcome.status === "error" && /crash/i.test(outcome.message ?? ""))
      add({
        kind: "crash",
        summary: `The page crashed on ${route}`,
        route,
        evidence: [outcome.message ?? "crashed"],
        afterStep: items.length,
      });
    const document = [...outcome.post.requests]
      .reverse()
      .find((r) => r.resourceType === "document" && typeof r.status === "number");
    // Observing makes the drafter's refs stale: only after a navigation, where it drops them anyway.
    if (
      document &&
      typeof document.status === "number" &&
      document.status >= 400 &&
      outcome.post.urlAfter !== outcome.post.urlBefore
    ) {
      const observation = await session.observe();
      errorPage(observation, document.status, route);
    }
    for (const request of outcome.post.requests) {
      if (request.resourceType === "document") continue;
      if (!["fetch", "xhr"].includes(request.resourceType)) continue;
      const failed =
        request.status === "failed" ||
        (typeof request.status === "number" && request.status >= 500);
      if (!failed) continue;
      add({
        kind: request.status === "failed" ? "failed_request" : "server_error",
        summary: `${request.method} ${routeOf(request.url)} ${request.status === "failed" ? `failed${request.failure ? ` (${request.failure})` : ""}` : `answered ${request.status}`} after "${info.items.at(-1)?.text ?? "the action"}"`,
        route,
        evidence: [`${request.method} ${routeOf(request.url)} → ${request.status}`],
        afterStep: items.length,
      });
    }
    collectConsole(route);
  };

  const draft = await exploreDraft(goal, {
    ...options,
    prompt,
    onObserve,
    onAction,
  });
  collectConsole(routeOf(session.url));
  const notes = [...draft.notes];
  if (draft.status === "impossible")
    add({
      kind: "dead_end",
      summary: `Dead end on ${routeOf(session.url)}: ${draft.message ?? "the goal couldn't be reached"}`,
      route: routeOf(session.url),
      evidence: [draft.message ?? ""],
      afterStep: draft.items.length,
    });

  // Regression tests for what went wrong on the way, where one can be written.
  const proposals: DraftResult[] = [];
  const start = options.start?.trim() || "/";
  for (const finding of findings) {
    if (finding.kind !== "error_page" && finding.kind !== "server_error") continue;
    const heading = finding.evidence.find((e) => e.startsWith("heading: "))?.slice(9);
    if (!heading || !ERROR_WORDS.test(heading) || finding.afterStep === 0) continue;
    const steps = draft.items.slice(0, finding.afterStep).filter((i) => i.kind === "action");
    const name =
      `No error after ${steps.at(-1)?.text.replace(/^Click /, "clicking ") ?? "the steps"}`.slice(
        0,
        90,
      );
    const proposal = await assembleDraft({
      status: "incomplete",
      reason: "finding",
      message: `Proposed from finding ${finding.id}: fails until the app is fixed.`,
      sentence: finding.summary,
      name,
      path: `${options.testsDir ?? "tests"}/${slugOf(name)}.test.md`,
      start,
      items: [
        ...steps,
        {
          kind: "expect",
          text: `the page doesn't show "${heading}"`,
          check: { summary: `not "${heading}"` },
        },
      ],
      data: {},
      notes: [
        `Proposed from ${finding.id} (${finding.summary}). It fails now, by design: it passes once the app no longer shows "${heading}".`,
      ],
      modelCalls: [],
      actions: steps.length,
      durationMs: 0,
      config: options.config,
      readFile: options.readFile,
      promptVersion: EXPLORE_PROMPT_VERSION,
    });
    finding.proposal = proposal;
    proposals.push(proposal);
  }
  if (findings.some((f) => f.kind === "broken_link"))
    notes.push(
      "Broken links are listed with the page they are on; fix the link or the page it points to.",
    );

  return {
    goal,
    draft,
    findings,
    proposals,
    linksChecked: checked.size,
    modelCalls: draft.modelCalls,
    promptVersion: EXPLORE_PROMPT_VERSION,
    notes,
  };
}
