import type { Observation, ObservedElement } from "@optestra/browser";
import { renderForModel } from "@optestra/browser";
import type { ModelCall } from "@optestra/contract";
import { type Models, type ToolDefinition, toModelCall } from "@optestra/models";
import { z } from "zod";
import { compileCheck } from "../checks/compile.js";
import {
  assembleDraft,
  type DraftOptions,
  type DraftResult,
  type DraftSession,
  exploreDraft,
} from "./draft.js";
import prompt from "./drafter-prompt.json" with { type: "json" };
import { labelOf, slugOf } from "./phrasing.js";

// Starter tests for a new project (ONB-2): explore the home page and propose
// three drafts, e.g. "the home page loads", sign-up and login. The home page
// test needs no AI (its heading is read from the page and checked); sign-up and
// login are found from the page's links and buttons, and the planner proposes
// the rest in one call. Each proposal is drafted from a fresh session. Nothing
// is saved: the user reviews every draft first.

export interface StarterProposal {
  name: string;
  sentence: string;
  /** Where its draft starts (a path on the app). */
  start: string;
  /** How it was found: the page's links, or the planner. */
  source: "page" | "ai";
}

export interface StarterOptions
  extends Omit<DraftOptions, "session" | "start" | "path" | "pathFor" | "models"> {
  /** A fresh browser session per draft; each one is closed after its draft. */
  openSession: () => Promise<DraftSession & { close(): Promise<unknown> }>;
  /** Absent: only the home page test (no AI). */
  models?: Models | undefined;
  /** The home page (default "/"). */
  start?: string | undefined;
  /** How many starter tests (default 3). */
  count?: number | undefined;
  /** True when a project-relative path is already taken (drafts get another name). */
  taken?: ((path: string) => boolean) | undefined;
}

export interface StarterSuggestions {
  proposals: StarterProposal[];
  drafts: DraftResult[];
  notes: string[];
  /** Every model call, the proposal call included. */
  modelCalls: ModelCall[];
}

const SIGN_UP = /\b(sign ?up|register|create (an |your )?account|get started|join now)\b/i;
const LOG_IN = /\b(log ?in|sign ?in)\b/i;

const PROPOSE: ToolDefinition = {
  name: "propose_tests",
  description: "Propose starter tests: a short name and one sentence each.",
  parameters: {
    type: "object",
    properties: {
      tests: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, sentence: { type: "string" } },
          required: ["name", "sentence"],
          additionalProperties: false,
        },
      },
    },
    required: ["tests"],
    additionalProperties: false,
  },
};

const ProposalsSchema = z.object({
  tests: z.array(z.object({ name: z.string().min(1), sentence: z.string().min(1) })),
});

/** A same-origin link's path, to start its test there. */
function pathOf(element: ObservedElement, page: string): string | undefined {
  if (!element.url) return undefined;
  try {
    const url = new URL(element.url, page);
    if (url.origin !== new URL(page).origin) return undefined;
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

/** Sign-up and login, from the page's links and buttons. */
export function proposalsFromPage(observation: Observation, start: string): StarterProposal[] {
  const out: StarterProposal[] = [];
  const find = (pattern: RegExp) =>
    observation.elements.find(
      (e) => (e.role === "link" || e.role === "button") && pattern.test(labelOf(e) ?? ""),
    );
  const signUp = find(SIGN_UP);
  if (signUp)
    out.push({
      name: "New visitor can sign up",
      sentence: "a new visitor can sign up for an account",
      start: pathOf(signUp, observation.url) ?? start,
      source: "page",
    });
  const logIn = find(LOG_IN);
  if (logIn)
    out.push({
      name: "Returning user can log in",
      sentence: "a returning user can log in",
      start: pathOf(logIn, observation.url) ?? start,
      source: "page",
    });
  return out;
}

/** Proposes and drafts the starter tests. Saves nothing. */
export async function exploreStarters(options: StarterOptions): Promise<StarterSuggestions> {
  const count = options.count ?? 3;
  const start = options.start?.trim() || "/";
  const testsDir = options.testsDir ?? "tests";
  const notes: string[] = [];
  const modelCalls: ModelCall[] = [];
  const drafts: DraftResult[] = [];
  const used = new Set<string>();
  const pathFor = (name: string) => {
    const slug = slugOf(name);
    for (let n = 1; ; n++) {
      const path = `${testsDir}/${slug}${n === 1 ? "" : `-${n}`}.test.md`;
      if (!used.has(path) && !options.taken?.(path)) {
        used.add(path);
        return path;
      }
    }
  };

  // 1. The home page, with no AI: its heading, checked on the page.
  const proposals: StarterProposal[] = [];
  const session = await options.openSession();
  let observation: Observation;
  try {
    const opened = await session.act({ type: "goto", url: start });
    if (opened.status !== "ok") {
      notes.push(
        `The home page ${start} could not be opened (${opened.message ?? opened.status}). Start the app, then try again.`,
      );
      return { proposals, drafts, notes, modelCalls };
    }
    observation = await session.observe();
    const heading = observation.elements.find((e) => e.role === "heading" && labelOf(e));
    const began = Date.now();
    const candidates = [
      ...(heading ? [`the page heading is "${labelOf(heading)}"`] : []),
      ...(observation.title ? [`the page shows "${observation.title}"`] : []),
    ];
    for (const text of candidates) {
      const compiled = await compileCheck(
        { text, soft: false },
        { session, values: {}, timeoutMs: 2_000 },
      );
      if (compiled.op.type === "pending" || compiled.problem || !compiled.evaluation?.passed)
        continue;
      const home: StarterProposal = {
        name: "The home page loads",
        sentence: "the home page loads",
        start,
        source: "page",
      };
      proposals.push(home);
      drafts.push(
        await assembleDraft({
          status: "drafted",
          sentence: home.sentence,
          name: home.name,
          path: pathFor(home.name),
          start,
          items: [
            {
              kind: "expect",
              text,
              check: {
                summary: compiled.summary,
                ...(compiled.rule ? { rule: compiled.rule } : {}),
              },
            },
          ],
          data: {},
          notes: [],
          modelCalls: [],
          actions: 0,
          durationMs: Date.now() - began,
          config: options.config,
          readFile: options.readFile,
        }),
      );
      break;
    }
    if (drafts.length === 0)
      notes.push("The home page has no heading or title a check could use: no home page test.");
  } finally {
    await session.close();
  }

  // 2. Sign-up and login from the page; the planner proposes the rest.
  for (const proposal of proposalsFromPage(observation, start))
    if (proposals.length < count) proposals.push(proposal);
  if (!options.models) {
    notes.push("No AI model is set up: only the tests that need no exploring were drafted.");
    return { proposals, drafts, notes, modelCalls };
  }
  if (proposals.length < count) {
    const reply = await options.models.complete("planner", {
      system: prompt.starters_system,
      messages: [
        {
          role: "user",
          content: prompt.starters_turn
            .replace("{count}", String(count - proposals.length))
            .replace("{chosen}", proposals.map((p) => `- ${p.sentence}`).join("\n") || "(none)")
            .replace("{page}", renderForModel(observation)),
        },
      ],
      tools: [PROPOSE],
      maxOutputTokens: 500,
      temperature: 0,
      ...(options.budget ? { budgets: [options.budget] } : {}),
      tags: { ...options.tags, task: "starters" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    modelCalls.push(toModelCall(reply.record));
    if (!reply.ok) notes.push(`No more proposals: ${reply.message}`);
    else {
      const call = reply.toolCalls.find((c) => c.name === "propose_tests");
      const parsed = ProposalsSchema.safeParse(call?.input);
      if (!parsed.success) notes.push("The model's proposals couldn't be read.");
      else
        for (const test of parsed.data.tests) {
          if (proposals.length >= count) break;
          if (proposals.some((p) => slugOf(p.name) === slugOf(test.name))) continue;
          proposals.push({
            name: test.name.trim().slice(0, 100),
            sentence: test.sentence.trim().slice(0, 300),
            start,
            source: "ai",
          });
        }
    }
  }

  // 3. A draft per proposal that needs exploring, each from a clean browser.
  for (const proposal of proposals) {
    if (drafts.some((d) => d.sentence === proposal.sentence)) continue;
    const fresh = await options.openSession();
    try {
      const draft = await exploreDraft(proposal.sentence, {
        ...options,
        models: options.models,
        session: fresh,
        start: proposal.start,
        path: pathFor(proposal.name),
      });
      modelCalls.push(...draft.modelCalls);
      drafts.push(draft);
      if (draft.status === "stopped") {
        notes.push(`Stopped drafting: ${draft.message ?? draft.reason}`);
        break;
      }
    } finally {
      await fresh.close();
    }
  }
  return { proposals, drafts, notes, modelCalls };
}
