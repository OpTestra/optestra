import type { ToolDefinition } from "@optestra/models";
import { z } from "zod";
import { PLANNER_TOOLS, parseToolCall, type WebToolCall } from "../author/tools.js";

// The drafter's tools (AGT-0): the planner's closed action set (SAF-2), without
// read_inbox (drafts have no test inbox) and without the step control tools,
// plus `expect`, `look`, `draft_done` and `draft_impossible`. Nothing else: no
// HTTP, no code, no file access.

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const LEFT_OUT = new Set(["read_inbox", "step_done", "step_impossible"]);

export const DRAFT_TOOLS: ToolDefinition[] = [
  ...PLANNER_TOOLS.filter((tool) => !LEFT_OUT.has(tool.name)),
  {
    name: "expect",
    description:
      'Add an expectation to the test, e.g. the page heading is "Dashboard". Checked on the page now; quote visible text.',
    parameters: object({ text: { type: "string" } }, ["text"]),
  },
  {
    name: "draft_done",
    description: "The test shows the goal. name: a short test name saying what it proves.",
    parameters: object({ name: { type: "string" } }, ["name"]),
  },
  {
    name: "draft_impossible",
    description: "The goal can't be done on this app. reason: why, in one sentence.",
    parameters: object({ reason: { type: "string" } }, ["reason"]),
  },
];

export type DraftToolCall =
  | Exclude<WebToolCall, { name: "read_inbox" | "step_done" | "step_impossible" | "look" }>
  | { name: "look"; input: Record<string, never> }
  | { name: "expect"; input: { text: string } }
  | { name: "draft_done"; input: { name: string } }
  | { name: "draft_impossible"; input: { reason: string } };

const OWN = {
  expect: z.object({ text: z.string().trim().min(1) }),
  draft_done: z.object({ name: z.string() }),
  draft_impossible: z.object({ reason: z.string() }),
} as const;

export function parseDraftCall(
  name: string,
  input: unknown,
): { ok: true; call: DraftToolCall } | { ok: false; error: string } {
  if (name in OWN) {
    const parsed = OWN[name as keyof typeof OWN].safeParse(input ?? {});
    if (parsed.success) return { ok: true, call: { name, input: parsed.data } as DraftToolCall };
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error:
        `Invalid ${name} input: ${issue?.path.join(".") || "input"} ${issue?.message ?? ""}`.trim(),
    };
  }
  if (LEFT_OUT.has(name) || !DRAFT_TOOLS.some((tool) => tool.name === name))
    return { ok: false, error: `There is no tool "${name}".` };
  const parsed = parseToolCall(name, input);
  if (!parsed.ok) return parsed;
  return { ok: true, call: parsed.call as DraftToolCall };
}
