import type { ToolDefinition } from "@testament/models";
import { z } from "zod";

// The planner's tools mirror LOOP-0's closed action set exactly, plus three
// control tools. Schemas are small and explicit so cheap models can use them
// (MOD-9). Targets are refs from the latest observation; values are literals or
// `{{ns.name}}` templates of the step's variables. read_inbox (AUTH-1) returns
// only a handle to an email's code or link, never the value.

const ref = { type: "string", description: "Element ref from the page snapshot, e.g. e12." };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const PLANNER_TOOLS: ToolDefinition[] = [
  { name: "click", description: "Click an element.", parameters: object({ ref }, ["ref"]) },
  {
    name: "dblclick",
    description: "Double-click an element.",
    parameters: object({ ref }, ["ref"]),
  },
  {
    name: "fill",
    description:
      "Replace the text of a field. value: the exact text, or a template like {{data.email}} / {{secret.NAME}}.",
    parameters: object({ ref, value: { type: "string" } }, ["ref", "value"]),
  },
  {
    name: "select",
    description: "Choose an option in a dropdown, by its label.",
    parameters: object({ ref, option: { type: "string" } }, ["ref", "option"]),
  },
  {
    name: "check",
    description: "Tick a checkbox or radio button.",
    parameters: object({ ref }, ["ref"]),
  },
  { name: "uncheck", description: "Untick a checkbox.", parameters: object({ ref }, ["ref"]) },
  {
    name: "press",
    description:
      "Press a key (Enter, Tab, Escape, ArrowDown, Control+A…), optionally in an element.",
    parameters: object({ key: { type: "string" }, ref }, ["key"]),
  },
  {
    name: "hover",
    description: "Move the mouse over an element.",
    parameters: object({ ref }, ["ref"]),
  },
  {
    name: "scroll",
    description: "Scroll an element into view (ref), or the page up/down.",
    parameters: object({ ref, direction: { type: "string", enum: ["up", "down"] } }),
  },
  {
    name: "upload",
    description: "Upload a file from the test's folder into a file field or upload button.",
    parameters: object(
      {
        ref,
        file: {
          type: "string",
          description: "Path relative to the test file, e.g. files/avatar.png.",
        },
      },
      ["ref", "file"],
    ),
  },
  {
    name: "goto",
    description: "Open a page of the site, e.g. /settings.",
    parameters: object({ url: { type: "string" } }, ["url"]),
  },
  { name: "back", description: "Go back one page.", parameters: object({}) },
  { name: "reload", description: "Reload the page.", parameters: object({}) },
  {
    name: "wait_for",
    description: "Wait until a text (or element) is visible.",
    parameters: object({ text: { type: "string" }, ref, seconds: { type: "number" } }),
  },
  {
    name: "read_inbox",
    description:
      "Wait for the email the app sent to the test's address and get its verification code or link as a handle ({{inbox.code}} / {{inbox.link}}). The value is never shown: fill {{inbox.code}} into the field, or goto {{inbox.link}}. to: optional, the address template, e.g. {{data.email}}.",
    parameters: object(
      { want: { type: "string", enum: ["code", "link"] }, to: { type: "string" } },
      ["want"],
    ),
  },
  {
    name: "look",
    description:
      "Get a screenshot of the page with the next snapshot, when the snapshot isn't enough.",
    parameters: object({}),
  },
  {
    name: "step_done",
    description: "The step is done. visible_effect: what changed on the page because of it.",
    parameters: object({ visible_effect: { type: "string" } }, ["visible_effect"]),
  },
  {
    name: "step_impossible",
    description: "The step can't be done on this page. reason: why, in one sentence.",
    parameters: object({ reason: { type: "string" } }, ["reason"]),
  },
];

const shared = (name: string) => {
  const tool = PLANNER_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

/**
 * The Android tools (MOB-1): the Android harness's action set, worded for an app
 * screen. tap and type are the web's click and fill (recorded the same way).
 */
export const ANDROID_TOOLS: ToolDefinition[] = [
  {
    name: "tap",
    description: "Tap an element on the screen.",
    parameters: object({ ref }, ["ref"]),
  },
  {
    name: "long_press",
    description: "Press and hold an element (for menus or selection).",
    parameters: object({ ref }, ["ref"]),
  },
  {
    name: "type",
    description:
      "Type into a text field, replacing what it has. value: a literal, or a variable's template.",
    parameters: object({ ref, value: { type: "string" } }, ["ref", "value"]),
  },
  { name: "clear", description: "Empty a text field.", parameters: object({ ref }, ["ref"]) },
  {
    name: "press",
    description: "Press a key (Enter, Tab, Backspace, Escape, Search…), optionally in a field.",
    parameters: object({ key: { type: "string" }, ref }, ["key"]),
  },
  {
    name: "swipe",
    description: "Swipe the screen (or an element) up, down, left or right.",
    parameters: object(
      { direction: { type: "string", enum: ["up", "down", "left", "right"] }, ref },
      ["direction"],
    ),
  },
  {
    name: "scroll",
    description: "Scroll an element into view (ref), or the screen up/down.",
    parameters: object({ ref, direction: { type: "string", enum: ["up", "down"] } }),
  },
  { name: "back", description: "Press Android's Back.", parameters: object({}) },
  { name: "home", description: "Press Android's Home (leaves the app).", parameters: object({}) },
  {
    name: "launch_app",
    description: "Open the app under test again (e.g. after Home).",
    parameters: object({}),
  },
  {
    name: "rotate",
    description: "Turn the device to portrait or landscape.",
    parameters: object({ orientation: { type: "string", enum: ["portrait", "landscape"] } }, [
      "orientation",
    ]),
  },
  {
    name: "open_link",
    description: "Open a link (deep link) in the app, e.g. myapp://orders/42.",
    parameters: object({ url: { type: "string" } }, ["url"]),
  },
  {
    name: "permission",
    description:
      "Answer Android's permission prompt: allow (while using the app), allow_once, or deny.",
    parameters: object({ decision: { type: "string", enum: ["allow", "allow_once", "deny"] } }, [
      "decision",
    ]),
  },
  {
    name: "wait_for",
    description: "Wait until a text (or element) is visible on the screen.",
    parameters: object({ text: { type: "string" }, ref, seconds: { type: "number" } }),
  },
  shared("read_inbox"),
  {
    name: "look",
    description:
      "Get a screenshot of the screen with the next snapshot, when the snapshot isn't enough.",
    parameters: object({}),
  },
  {
    name: "step_done",
    description: "The step is done. visible_effect: what changed on the screen because of it.",
    parameters: object({ visible_effect: { type: "string" } }, ["visible_effect"]),
  },
  {
    name: "step_impossible",
    description: "The step can't be done on this screen. reason: why, in one sentence.",
    parameters: object({ reason: { type: "string" } }, ["reason"]),
  },
];

/** The tools for a project's target. */
export function toolsFor(target: "web" | "android" | undefined): ToolDefinition[] {
  return target === "android" ? ANDROID_TOOLS : PLANNER_TOOLS;
}

const refField = z.string().regex(/^e\d+$/, "a ref like e12");

/** Parsed tool calls. Anything that doesn't validate is reported back to the model. */
export const ToolCallSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("click"), input: z.object({ ref: refField }) }),
  z.object({ name: z.literal("dblclick"), input: z.object({ ref: refField }) }),
  z.object({ name: z.literal("fill"), input: z.object({ ref: refField, value: z.string() }) }),
  z.object({ name: z.literal("select"), input: z.object({ ref: refField, option: z.string() }) }),
  z.object({ name: z.literal("check"), input: z.object({ ref: refField }) }),
  z.object({ name: z.literal("uncheck"), input: z.object({ ref: refField }) }),
  z.object({
    name: z.literal("press"),
    input: z.object({ key: z.string().min(1), ref: refField.optional() }),
  }),
  z.object({ name: z.literal("hover"), input: z.object({ ref: refField }) }),
  z.object({
    name: z.literal("scroll"),
    input: z.object({ ref: refField.optional(), direction: z.enum(["up", "down"]).optional() }),
  }),
  z.object({
    name: z.literal("upload"),
    input: z.object({ ref: refField, file: z.string().min(1) }),
  }),
  z.object({ name: z.literal("goto"), input: z.object({ url: z.string().min(1) }) }),
  z.object({ name: z.literal("back"), input: z.object({}).loose() }),
  z.object({ name: z.literal("reload"), input: z.object({}).loose() }),
  z.object({
    name: z.literal("wait_for"),
    input: z.object({
      text: z.string().optional(),
      ref: refField.optional(),
      seconds: z.number().positive().max(30).optional(),
    }),
  }),
  z.object({
    name: z.literal("read_inbox"),
    input: z.object({ want: z.enum(["code", "link"]), to: z.string().min(1).optional() }),
  }),
  z.object({ name: z.literal("look"), input: z.object({}).loose() }),
  z.object({ name: z.literal("step_done"), input: z.object({ visible_effect: z.string() }) }),
  z.object({ name: z.literal("step_impossible"), input: z.object({ reason: z.string() }) }),
  // Android (MOB-1).
  z.object({ name: z.literal("tap"), input: z.object({ ref: refField }) }),
  z.object({ name: z.literal("long_press"), input: z.object({ ref: refField }) }),
  z.object({ name: z.literal("type"), input: z.object({ ref: refField, value: z.string() }) }),
  z.object({ name: z.literal("clear"), input: z.object({ ref: refField }) }),
  z.object({
    name: z.literal("swipe"),
    input: z.object({
      direction: z.enum(["up", "down", "left", "right"]),
      ref: refField.optional(),
    }),
  }),
  z.object({ name: z.literal("home"), input: z.object({}).loose() }),
  z.object({ name: z.literal("launch_app"), input: z.object({}).loose() }),
  z.object({
    name: z.literal("rotate"),
    input: z.object({ orientation: z.enum(["portrait", "landscape"]) }),
  }),
  z.object({ name: z.literal("open_link"), input: z.object({ url: z.string().min(1) }) }),
  z.object({
    name: z.literal("permission"),
    input: z.object({ decision: z.enum(["allow", "allow_once", "deny"]) }),
  }),
]);
export type PlannerToolCall = z.infer<typeof ToolCallSchema>;
/** A call of the web tools (PLANNER_TOOLS): no Android-only tool. */
export type WebToolCall = Exclude<
  PlannerToolCall,
  {
    name:
      | "tap"
      | "long_press"
      | "type"
      | "clear"
      | "swipe"
      | "home"
      | "launch_app"
      | "rotate"
      | "open_link"
      | "permission";
  }
>;

export type ParsedTool = { ok: true; call: PlannerToolCall } | { ok: false; error: string };

export function parseToolCall(
  name: string,
  input: unknown,
  tools: readonly ToolDefinition[] = PLANNER_TOOLS,
): ParsedTool {
  // Only the tools offered to this model exist for it (a web tool isn't an Android one).
  if (!tools.some((tool) => tool.name === name)) {
    return { ok: false, error: `There is no tool "${name}".` };
  }
  const result = ToolCallSchema.safeParse({ name, input: input ?? {} });
  if (result.success) return { ok: true, call: result.data };
  const issue = result.error.issues[0];
  return {
    ok: false,
    error:
      `Invalid ${name} input: ${issue?.path.slice(1).join(".") || "input"} ${issue?.message ?? ""}`.trim(),
  };
}

/** Tools that act on the page (count towards the action limit). */
export const ACTION_TOOLS = new Set([
  "click",
  "dblclick",
  "fill",
  "select",
  "check",
  "uncheck",
  "press",
  "hover",
  "scroll",
  "upload",
  "goto",
  "back",
  "reload",
  "wait_for",
  "tap",
  "long_press",
  "type",
  "clear",
  "swipe",
  "home",
  "launch_app",
  "rotate",
  "open_link",
  "permission",
]);
