import { z } from "zod";

// The recording format (REP-1). Browser-safe: the apps display recordings.
// Key order in every object here is the order written to disk, so files stay
// stable and diff-friendly. Commands are learned, never results (LRN-1): nothing
// here says a step passed.

export const RECORDING_VERSION = 1;

// ── Locators ─────────────────────────────────────────────────────────────────

const exact = z.boolean().optional();

/** One way to find an element, without a frame path (used inside frame paths). */
export const FrameLocatorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role"),
    role: z.string().min(1),
    name: z.string().optional(),
    exact,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("label"),
    text: z.string(),
    exact,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("placeholder"),
    text: z.string(),
    exact,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("alt"),
    text: z.string(),
    exact,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("title"),
    text: z.string(),
    exact,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("testId"),
    value: z.string(),
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    exact,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("css"),
    selector: z.string().min(1),
    nth: z.number().int().min(0).optional(),
  }),
]);
export type FrameLocator = z.infer<typeof FrameLocatorSchema>;

const framePath = z.array(FrameLocatorSchema).optional();

/**
 * A locator spec, the same shape as `@testament/browser`'s `LocatorSpec`:
 * `frame` is the iframe path from the page to the element's frame.
 */
export const LocatorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role"),
    role: z.string().min(1),
    name: z.string().optional(),
    exact,
    /** Heading level (`getByRole("heading", { level })`); checks only. */
    level: z.number().int().min(1).max(6).optional(),
    frame: framePath,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("label"),
    text: z.string(),
    exact,
    frame: framePath,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("placeholder"),
    text: z.string(),
    exact,
    frame: framePath,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("alt"),
    text: z.string(),
    exact,
    frame: framePath,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("title"),
    text: z.string(),
    exact,
    frame: framePath,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("testId"),
    value: z.string(),
    frame: framePath,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    exact,
    frame: framePath,
    nth: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("css"),
    selector: z.string().min(1),
    frame: framePath,
    nth: z.number().int().min(0).optional(),
  }),
]);
export type Locator = z.infer<typeof LocatorSchema>;

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * A value as a template: literal text, `{{data.email}}`-style references, and
 * `{{secret.NAME}}` for secrets (typed by the driver at replay). Literal `{{`
 * is written `\{{`. Never a resolved variable value (REP-7).
 */
export const TemplateSchema = z.string();

/** A LOOP-0 action with its target as a locator (never a ref) and values as templates. */
export const RecordedActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: TemplateSchema }),
  z.object({ type: z.literal("click"), target: LocatorSchema }),
  z.object({ type: z.literal("dblclick"), target: LocatorSchema }),
  z.object({ type: z.literal("fill"), target: LocatorSchema, value: TemplateSchema }),
  z.object({
    type: z.literal("select"),
    target: LocatorSchema,
    option: z.union([TemplateSchema, z.array(TemplateSchema)]),
  }),
  z.object({ type: z.literal("check"), target: LocatorSchema }),
  z.object({ type: z.literal("uncheck"), target: LocatorSchema }),
  z.object({ type: z.literal("press"), key: z.string().min(1), target: LocatorSchema.optional() }),
  z.object({ type: z.literal("hover"), target: LocatorSchema }),
  z.object({
    type: z.literal("scroll"),
    target: LocatorSchema.optional(),
    direction: z.enum(["up", "down"]).optional(),
    pixels: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("upload"),
    target: LocatorSchema,
    files: z.array(z.string().min(1)).min(1),
  }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("reload") }),
  z.object({
    type: z.literal("waitFor"),
    text: TemplateSchema.optional(),
    target: LocatorSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);
export type RecordedAction = z.infer<typeof RecordedActionSchema>;

const BoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

/** What identifies the element, for re-finding it without AI (HEAL-1 `refind`). */
export const FingerprintSchema = z.object({
  primary: LocatorSchema,
  fallbacks: z.array(LocatorSchema),
  role: z.string(),
  name: z.string(),
  tag: z.string(),
  attributes: z.record(z.string(), z.string()),
  anchorText: z.string(),
  framePath: z.array(FrameLocatorSchema),
  box: BoxSchema.nullable(),
});
export type Fingerprint = z.infer<typeof FingerprintSchema>;

export const ElementRefSchema = z.object({
  role: z.string(),
  name: z.string(),
  text: z.string().optional(),
});

/** What replay should see after the command (VER-5). */
export const ExpectPostSchema = z.object({
  /** The route after the command, when the command changed it. */
  urlChange: z.string().optional(),
  appeared: z.array(ElementRefSchema).optional(),
  removed: z.array(ElementRefSchema).optional(),
  /** Requests the command caused, as METHOD + route (no query, no host). */
  requests: z
    .array(z.object({ method: z.string(), route: z.string(), status: z.number().int().optional() }))
    .optional(),
  /** The same elements as before, in another order (a table sort): replay expects a reorder too. */
  reordered: z.literal(true).optional(),
});
export type ExpectPost = z.infer<typeof ExpectPostSchema>;

/** How long the page took to settle after the command (LRN-4). */
export const WaitSchema = z.object({
  settledMs: z.number().int().min(0),
  waitedFor: z.object({
    network: z.number().int().min(0),
    dom: z.number().int().min(0),
    busy: z.number().int().min(0),
  }),
  /** A learned wait condition, when one is known (LOOP-4 fills this in). */
  until: z.string().optional(),
});
export type Wait = z.infer<typeof WaitSchema>;

export const CommandSchema = z.object({
  action: RecordedActionSchema,
  /** Null for actions without an element (goto, back, reload, page-level press/scroll/wait). */
  fingerprint: FingerprintSchema.nullable(),
  expectPost: ExpectPostSchema,
  wait: WaitSchema,
});
export type Command = z.infer<typeof CommandSchema>;

// ── Steps ────────────────────────────────────────────────────────────────────

export const StepRecordingSchema = z.object({
  /** StepResult.key = hash(textKey + route + epoch). */
  key: z.string().regex(/^[0-9a-f]{16}$/),
  textKey: z.string(),
  /** Normalized path of the page when the step began (see `routeOf`). */
  route: z.string(),
  /** The English line, for humans (secrets as `{{secret.NAME}}`). */
  text: z.string(),
  kind: z.enum(["action", "exact"]),
  commands: z.array(CommandSchema),
  /** The model's short note (EVD-1), scrubbed. */
  reasoning: z.string().optional(),
  source: z.enum(["ai", "exact", "record"]),
  recordedAt: z.string(),
});
export type StepRecording = z.infer<typeof StepRecordingSchema>;

// ── Checks (LOOP-2) ──────────────────────────────────────────────────────────

const scope = LocatorSchema.optional();

/**
 * A typed check (VER-1). Every op with a target may be scoped to a container
 * (which carries the frame path). Evaluating any op except `soft_judgment` needs
 * no model: it is deterministic code (VER-2).
 */
export const CheckOpSchema = z.discriminatedUnion("type", [
  /** The visible text (innerText, whitespace collapsed) of the target. `matches` is a regex source. */
  z.object({
    type: z.literal("text"),
    target: LocatorSchema,
    match: z.enum(["equals", "contains", "matches"]),
    value: TemplateSchema,
    scope,
  }),
  z.object({
    type: z.literal("url"),
    match: z.enum(["is", "contains", "matches"]),
    value: TemplateSchema,
  }),
  z.object({
    type: z.literal("element_state"),
    target: LocatorSchema,
    state: z.enum([
      "visible",
      "hidden",
      "enabled",
      "disabled",
      "checked",
      "unchecked",
      "focused",
      "editable",
      "empty",
    ]),
    scope,
  }),
  z.object({
    type: z.literal("count"),
    target: LocatorSchema,
    n: z.number().int().min(0).optional(),
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
    scope,
  }),
  /** A form field's current value (a select's chosen option label). */
  z.object({
    type: z.literal("value"),
    target: LocatorSchema,
    match: z.enum(["equals", "contains"]),
    value: TemplateSchema,
    scope,
  }),
  z.object({
    type: z.literal("network"),
    method: z.string(),
    url: z.string(),
    status: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("aria_snapshot"),
    target: LocatorSchema,
    snapshot: z.string(),
    scope,
  }),
  /** Verbatim Playwright code (from an Exact code block). Runs from the generated spec only. */
  z.object({ type: z.literal("code"), code: z.string() }),
  /**
   * A model's yes/no judgment of a screenshot, for `Soft:` lines that can't be
   * pinned (VER-3). Allowed only on soft checks; its result can only warn.
   */
  z.object({
    type: z.literal("soft_judgment"),
    /** The question put to the model: the expectation as written. */
    question: z.string().min(1),
    /** What the model sees: the whole page, or one element (`target`). */
    screenshot: z.enum(["page", "element"]),
    target: LocatorSchema.optional(),
  }),
  /** Not compiled (yet): the line has no check. `problem` on the recording says why. */
  z.object({ type: z.literal("pending") }),
]);
export type CheckOp = z.infer<typeof CheckOpSchema>;
export type CheckOpType = CheckOp["type"];

/** How a check was made: phrase rules, the AI compiler, or a typed `Exact:` op. */
export const CheckSourceSchema = z.enum(["ai", "exact", "rules"]);

/** One sanity probe (VER-6): `failed` is good, `passed` means the check proved nothing there. */
export const SanityProbeSchema = z.object({
  result: z.enum(["failed", "passed", "skipped"]),
  note: z.string().optional(),
});

export const SanitySchema = z.object({
  /** On an empty page (about:blank). */
  empty: SanityProbeSchema,
  /** On the page as it was before the preceding action. */
  before: SanityProbeSchema,
  provesNothing: z.boolean(),
});
export type Sanity = z.infer<typeof SanitySchema>;

export const CheckRecordingSchema = z
  .object({
    key: z.string().regex(/^[0-9a-f]{16}$/),
    textKey: z.string(),
    /** The Expect/Soft line verbatim (secrets as `{{secret.NAME}}`). Never rewritten (HEAL-3). */
    text: z.string(),
    soft: z.boolean(),
    check: CheckOpSchema,
    generatedBy: CheckSourceSchema,
    /** Plain English, generated from the op by `describeCheck` (EVD-3). */
    summary: z.string().optional(),
    /** The phrase rule that compiled the line (generatedBy "rules"). */
    rule: z.string().optional(),
    sanity: SanitySchema.optional(),
    /** Set when the check failed the one time it was evaluated while authoring. */
    failedAtAuthoring: z
      .object({ expected: z.string().nullable(), actual: z.string().nullable() })
      .optional(),
    /** Why the line has no trustworthy check (not compiled, or proves nothing). For the user. */
    problem: z.string().optional(),
    recordedAt: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.check.type === "soft_judgment" && !value.soft) {
      ctx.addIssue({
        code: "custom",
        path: ["check", "type"],
        message: "soft_judgment is only allowed on Soft: lines (VER-3).",
      });
    }
    if (
      value.check.type === "soft_judgment" &&
      value.check.screenshot === "element" &&
      !value.check.target
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["check", "target"],
        message: "An element screenshot needs a target.",
      });
    }
  });
export type CheckRecording = z.infer<typeof CheckRecordingSchema>;

// ── The file ─────────────────────────────────────────────────────────────────

export const RecordedWithSchema = z.object({
  engineVersion: z.string(),
  /** RECORDING_EPOCH at record time. */
  epoch: z.number().int().positive(),
  browser: z.string(),
  device: z.string(),
  environment: z.string().nullable(),
  /** "provider/model" of the last model that recorded a step; null when no AI was used. */
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
});
export type RecordedWith = z.infer<typeof RecordedWithSchema>;

export const RecordingSchema = z.object({
  recordingVersion: z.literal(RECORDING_VERSION),
  testId: z.string().min(1),
  /** Project-relative path of the test file, with "/". */
  testPath: z.string().min(1),
  target: z.enum(["web", "android"]),
  recordedWith: RecordedWithSchema,
  updatedAt: z.string(),
  /** In test order. */
  steps: z.array(StepRecordingSchema),
  checks: z.array(CheckRecordingSchema),
});
export type Recording = z.infer<typeof RecordingSchema>;
