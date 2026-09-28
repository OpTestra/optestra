import { printExactOp } from "../exact.js";
import type { ExpandedStep } from "../expand.js";
import type { FlowStep, Range, Step, TextStep } from "../model.js";
import { specSteps } from "../model.js";
import {
  frontmatterEnd,
  insertLines,
  isCheckStep,
  protectedLines,
  rangeInStep,
  replaceLines,
  stepLines,
} from "./source.js";
import type { Fix, LintRule, RuleContext, TextEdit } from "./types.js";
import type { CompiledWords } from "./words.js";

// ── shared heuristics ─────────────────────────────────────────────────────────

const QUOTED = /"[^"\n]+"|“[^”\n]+”|(?:^|[\s(])'[^'\n]+'(?=$|[\s.,;:!?)])/;
const URL_OR_PATH = /https?:\/\/\S+|(?:^|\s)\/[\w\-./?=&#%]*/;
const DIGIT = /\d/;
const VARIABLE = /\{\{\s*[A-Za-z_]+\.[A-Za-z_][\w-]*\s*\}\}/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Quoted text, a URL or path, a count, a variable, an element noun or a state. */
export function isObservable(text: string, words: CompiledWords): boolean {
  return (
    QUOTED.test(text) ||
    URL_OR_PATH.test(text) ||
    DIGIT.test(text) ||
    VARIABLE.test(text) ||
    words.noun.test(text) ||
    words.state.test(text)
  );
}

const hasTarget = (text: string, words: CompiledWords) =>
  QUOTED.test(text) || URL_OR_PATH.test(text) || words.noun.test(text) || VARIABLE.test(text);

/** Text of a step as a rule should read it. */
function stepText(step: Step): string {
  switch (step.kind) {
    case "flow":
      return step.path;
    case "exact":
      return step.exact.form === "op" ? printExactOp(step.exact.op, (t) => t.raw) : step.exact.code;
    default:
      return step.text.raw;
  }
}

const own = (ctx: RuleContext) => specSteps(ctx.spec);
const textSteps = (ctx: RuleContext, ...kinds: TextStep["kind"][]) =>
  own(ctx).filter(
    (s): s is TextStep => s.kind !== "flow" && s.kind !== "exact" && kinds.includes(s.kind),
  );

/** Splits on " and " outside quotes. */
function splitAnd(text: string): string[] {
  const parts: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quote) {
      if (ch === quote || (quote === "“" && ch === "”")) quote = undefined;
    } else if (ch === '"' || ch === "“") quote = ch;
    else if (/^\s+and\s+/i.test(text.slice(i)) && /\s/.test(ch)) {
      parts.push(text.slice(start, i).trim());
      const skip = /^\s+and\s+/i.exec(text.slice(i))?.[0].length ?? 0;
      start = i + skip;
      i = start - 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((p) => p !== "");
}

/** Edits that renumber the numbered steps after `after` by `delta`. */
function renumberAfter(ctx: RuleContext, after: Step, delta: number): TextEdit[] {
  const edits: TextEdit[] = [];
  let past = false;
  for (const step of own(ctx)) {
    if (step === after) {
      past = true;
      continue;
    }
    if (!past || step.number === null || !step.at) continue;
    const { line, column } = step.at.range.start;
    const digits = String(step.number).length;
    edits.push({
      range: { start: { line, column }, end: { line, column: column + digits } },
      newText: String(step.number + delta),
    });
  }
  return edits;
}

/** Numbered steps after `step`, for deciding whether renumbering touches a check line. */
function laterNumbered(ctx: RuleContext, step: Step): Step[] {
  const all = own(ctx);
  return all.slice(all.indexOf(step) + 1).filter((s) => s.number !== null);
}

function nameRange(ctx: RuleContext): Range | undefined {
  return ctx.spec.fields?.name ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } };
}

/** Where a new frontmatter line goes: before the closing `---`. */
function frontmatterInsert(ctx: RuleContext, newLines: string[]): TextEdit | undefined {
  const end = frontmatterEnd(ctx.lines);
  return end === undefined ? undefined : insertLines(end, newLines);
}

/** Replaces a frontmatter entry `key: …` (single-line) with new text, or inserts it. */
function setFrontmatterEntry(ctx: RuleContext, key: string, line: string): TextEdit | undefined {
  const range = ctx.spec.fields?.[key];
  if (range && range.start.line === range.end.line) {
    const indent = " ".repeat(range.start.column - 1);
    return replaceLines(ctx.lines, range.start.line, range.end.line, [indent + line.trimStart()]);
  }
  if (range) return undefined; // a block value: leave it to the user
  return frontmatterInsert(ctx, [line]);
}

function hostOf(ctx: RuleContext): string {
  for (const env of Object.values(ctx.config?.environments ?? {})) {
    if (env.baseUrl) {
      try {
        return new URL(env.baseUrl).hostname;
      } catch {
        // fall through
      }
    }
  }
  return "your-app.example.com";
}

// ── rules ─────────────────────────────────────────────────────────────────────

const vagueStep: LintRule = {
  id: "vague-step",
  severity: "warning",
  summary: "A step that doesn't say exactly what to do.",
  why: 'A step like "Log in normally" or "Click it" can be done many ways, so a pass proves little and the recording may do the wrong thing.',
  bad: "1. Log in normally",
  good: '1. Fill "Email" with {{data.email}}\n2. Fill "Password" with {{secret.TEST_PASSWORD}}\n3. Click "Log in"',
  check(ctx) {
    for (const step of textSteps(ctx, "action")) {
      const text = step.text.raw;
      const phrase = ctx.words.vague.exec(text);
      if (phrase) {
        ctx.report({
          range: rangeInStep(ctx.lines, step, phrase[0]) ?? step.at?.range,
          message: `"${text}" doesn't say exactly what to do, so the step can't be checked properly.`,
          fix: 'Spell out each action: what to click or fill, with the visible label in quotes (e.g. Click "Log in"), or reuse a flow with Use: flows/login.test.md.',
        });
      } else if (ctx.words.verbOnly.test(text)) {
        ctx.report({
          range: step.text.at?.range ?? step.at?.range,
          message: `"${text}" doesn't say what to act on.`,
          fix: 'Name the target by its visible label, e.g. Click "Save changes" or Tap "Continue".',
        });
      }
    }
  },
};

const expectNotObservable: LintRule = {
  id: "expect-not-observable",
  severity: "warning",
  summary: "An Expect: with nothing a check could look at.",
  why: '"Expect: it works" names nothing on the screen, so it can\'t fail: the test passes even when the app is broken.',
  bad: "5. Expect: it works",
  good: '5. Expect: the page heading is "Order confirmed"',
  check(ctx) {
    for (const step of textSteps(ctx, "expect")) {
      if (isObservable(step.text.raw, ctx.words)) continue;
      ctx.report({
        range: step.text.at?.range ?? step.at?.range,
        message: `"${step.text.raw}" names nothing a check could look at, so it would pass no matter what.`,
        fix: 'Say what should be on screen: quoted text, a URL, an element (heading, button, message…), a count or a state, e.g. Expect: the heading is "Welcome".',
      });
    }
  },
};

/** Real checks in the expanded test: observable Expect:, exact expect ops, and soft checks. */
function checks(steps: readonly ExpandedStep[], words: CompiledWords) {
  let hard = 0;
  let soft = 0;
  for (const step of steps) {
    if (step.kind === "expect" && isObservable(step.text, words)) hard++;
    else if (
      step.kind === "exact" &&
      step.exact?.form === "op" &&
      step.exact.op.op.startsWith("expect")
    )
      hard++;
    else if (step.kind === "soft") soft++;
  }
  return { hard, soft };
}

const noExpectations: LintRule = {
  id: "no-expectations",
  severity: "error",
  summary: "A test with no real check.",
  why: "Without an Expect: that looks at something, the test only proves that the steps could be clicked through, not that the app did the right thing.",
  bad: '1. Click "Start trial"\n2. Fill the card form',
  good: '1. Click "Start trial"\n2. Fill the card form\n3. Expect: the page heading is "Welcome to Pro"',
  check(ctx) {
    if (ctx.spec.frontmatter.kind !== "test" || ctx.expanded.steps.length === 0) return;
    const { hard, soft } = checks(ctx.expanded.steps, ctx.words);
    if (hard > 0 || soft > 0) return;
    ctx.report({
      range: nameRange(ctx),
      message:
        "This test checks nothing: it has no Expect: step that looks at something, so it would pass even if the app is broken.",
      fix: 'Add at least one Expect: step naming what should be on screen, e.g. Expect: the page heading is "Order confirmed".',
    });
  },
};

const softOnly: LintRule = {
  id: "soft-only",
  severity: "error",
  summary: "Every check is Soft:, so the test can never fail.",
  why: "Soft checks only warn (VER-3). A test whose only checks are soft passes no matter what the app does.",
  bad: "3. Soft: the dashboard looks right",
  good: '3. Expect: the page heading is "Dashboard"\n4. Soft: the chart looks reasonable',
  check(ctx) {
    if (ctx.spec.frontmatter.kind !== "test") return;
    const { hard, soft } = checks(ctx.expanded.steps, ctx.words);
    if (hard > 0 || soft === 0) return;
    ctx.report({
      range: nameRange(ctx),
      message:
        "Every check in this test is Soft:, and soft checks only warn, so the test can never fail.",
      fix: "Add at least one Expect: step for something that must be true; keep Soft: for things that can't be pinned down.",
    });
  },
};

const missingStart: LintRule = {
  id: "missing-start",
  severity: "warning",
  summary: "The test doesn't say where it starts.",
  why: "Without a start page (or a first step that navigates), the test begins wherever the browser happens to be, which changes from run to run.",
  bad: '---\nname: Profile is saved\n---\n\n1. Fill "Full name" with Ada',
  good: '---\nname: Profile is saved\nstart: /settings\n---\n\n1. Fill "Full name" with Ada',
  fixDescription:
    'Adds "start: /" to the frontmatter for you to complete (not applied automatically).',
  check(ctx) {
    if (ctx.spec.frontmatter.kind !== "test" || ctx.spec.frontmatter.start) return;
    // An Android test starts on the app's launcher screen, freshly installed: a known place.
    if (ctx.config?.project.target === "android") return;
    const first = ctx.expanded.steps[0];
    if (!first) return;
    const navigates =
      (first.kind === "action" && ctx.words.navigation.test(first.text)) ||
      (first.kind === "exact" && first.exact?.form === "op" && first.exact.op.op === "goto");
    if (navigates) return;
    const insert = frontmatterInsert(ctx, ["start: /"]);
    ctx.report({
      range: first.origin[0]?.range,
      message: "The test doesn't say where it starts, so it begins on whatever page is open.",
      fix: 'Add a start page to the frontmatter (e.g. "start: /settings"), or make the first step navigate (e.g. "Go to /settings").',
      fixes: insert
        ? [{ title: 'Add "start: /" to the frontmatter', edits: [insert], safe: false }]
        : [],
    });
  },
};

const compoundExpect: LintRule = {
  id: "compound-expect",
  severity: "info",
  summary: "One Expect: checks several things.",
  why: "When one line checks two things and fails, the verdict can't say which one broke. One check per line points at the exact problem.",
  bad: '4. Expect: the page shows "Pro plan" and the URL contains /billing',
  good: '4. Expect: the page shows "Pro plan"\n5. Expect: the URL contains /billing',
  fixDescription: "Offers to split it into one Expect: per line (never applied automatically).",
  check(ctx) {
    for (const step of textSteps(ctx, "expect")) {
      const parts = splitAnd(step.text.raw);
      if (parts.length < 2 || !parts.every((p) => isObservable(p, ctx.words))) continue;
      const span = stepLines(step);
      const fixes: Fix[] = [];
      if (span && step.number !== null) {
        const pad = " ".repeat(Math.max(0, (step.at?.range.start.column ?? 1) - 1));
        const newLines = parts.map((part, i) => `${pad}${(step.number ?? 0) + i}. Expect: ${part}`);
        fixes.push({
          title: `Split into ${parts.length} Expect: steps`,
          edits: [
            replaceLines(ctx.lines, span[0], span[1], newLines),
            ...renumberAfter(ctx, step, parts.length - 1),
          ],
          safe: false,
        });
      }
      ctx.report({
        range: step.text.at?.range ?? step.at?.range,
        message: `This expectation checks ${parts.length} things at once; if it fails, the result can't say which.`,
        fix: "Write one Expect: per thing to check.",
        fixes,
      });
    }
  },
};

interface CredentialHit {
  literal: string;
  /** Text to replace (the literal with its quotes, if any). */
  replace: string;
  name: string;
  quoted: boolean;
}

const CONNECTOR = /^(?:["”']?\s*(?:field|box|input)?["”']?)\s*(?:with|to|as|is|:|=)\s+/i;
const ARTICLE =
  /^(?:the|a|an|your|my|their|his|her|its|our|valid|invalid|wrong|new|old|same|correct|incorrect)\b/i;

/** Password- or token-looking literals in a piece of text. */
export function findCredentials(source: string, words: CompiledWords): CredentialHit[] {
  const hits: CredentialHit[] = [];
  // Variable references are never literals: blank them out, keeping offsets.
  const text = source.replace(/\{\{[^}]*\}\}/g, (ref) => " ".repeat(ref.length));
  const min = words.source.credentialMinLength;
  const field = new RegExp(words.credentialField.source, "gi");
  for (const match of text.matchAll(field)) {
    const name =
      words.source.credentialFields[(match[1] ?? "").toLowerCase().replace(/\s+/g, " ")] ??
      "SECRET";
    const after = text.slice((match.index ?? 0) + match[0].length);
    const connector = CONNECTOR.exec(after);
    const rest = connector ? after.slice(connector[0].length) : after.replace(/^\s+/, "");
    const quoted = /^"([^"]+)"/.exec(rest) ?? /^'([^']+)'/.exec(rest);
    const token = quoted
      ? (quoted[1] ?? "")
      : (/^[^\s,;]+/.exec(rest)?.[0] ?? "").replace(/[.)]+$/, "");
    if (token === "" || token.includes("{{") || ARTICLE.test(token) || token.length < min) continue;
    // Without "with/is/:" the next word must look like a credential (digits or symbols).
    if (!connector && !/[\d\W_]/.test(token.replace(/["'”]/g, ""))) continue;
    hits.push({ literal: token, replace: quoted ? quoted[0] : token, name, quoted: !!quoted });
  }
  for (const pattern of words.tokens) {
    for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
      if (!hits.some((h) => h.literal === match[0])) {
        hits.push({ literal: match[0], replace: match[0], name: "API_TOKEN", quoted: false });
      }
    }
  }
  return hits;
}

const literalCredential: LintRule = {
  id: "literal-credential",
  severity: "warning",
  summary: "A password or token written into the test.",
  why: "Test files are shared, committed and shown to the AI. Credentials belong in secrets, which the driver types in without anyone seeing them (SEC-1).",
  bad: '2. Fill "Password" with hunter2hunter2',
  good: '2. Fill "Password" with {{secret.TEST_PASSWORD}}',
  fixDescription:
    "Offers to replace it with {{secret.NAME}}; you then declare NAME in the project's secrets.",
  check(ctx) {
    const declared = new Set(Object.keys(ctx.config?.secrets ?? {}));
    const advice = (name: string) =>
      declared.has(name)
        ? `Replace it with {{secret.${name}}} (already declared in the project settings).`
        : `Replace it with {{secret.${name}}} and declare it in the project settings:\nsecrets:\n  ${name}: { domains: [${hostOf(ctx)}] }`;
    const report = (range: Range | undefined, hit: CredentialHit, where: string) => {
      const ref = `{{secret.${hit.name}}}`;
      ctx.report({
        range,
        message: `${where} contains what looks like a real ${hit.name === "API_TOKEN" ? "key or token" : hit.name.toLowerCase().replace(/_/g, " ")}. Credentials in test files leak into history, logs and AI prompts.`,
        fix: advice(hit.name),
        fixes: range
          ? [
              {
                title: `Use ${ref} instead`,
                edits: [{ range, newText: hit.quoted ? `"${ref}"` : ref }],
                safe: false,
              },
            ]
          : [],
      });
    };
    for (const step of own(ctx)) {
      const texts =
        step.kind === "flow"
          ? Object.values(step.params).map((p) => p.raw)
          : step.kind === "exact" && step.exact.form === "code"
            ? []
            : [stepText(step)];
      for (const text of texts) {
        for (const hit of findCredentials(text, ctx.words)) {
          report(
            rangeInStep(ctx.lines, step, hit.replace) ?? rangeInStep(ctx.lines, step, hit.literal),
            hit,
            "This step",
          );
        }
      }
    }
    const dataSets: [string, Record<string, { raw: string }>][] = [
      ["data", ctx.spec.frontmatter.data],
      ...Object.entries(ctx.spec.frontmatter.environments).map(
        ([env, o]) =>
          [`environments.${env}.data`, o.data ?? {}] as [string, Record<string, { raw: string }>],
      ),
    ];
    for (const [prefix, data] of dataSets) {
      for (const [key, value] of Object.entries(data)) {
        if (value.raw.includes("{{")) continue;
        const field = ctx.words.credentialField.exec(
          key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " "),
        );
        const tokens = findCredentials(value.raw, ctx.words).filter((h) => h.name === "API_TOKEN");
        const name = field
          ? (ctx.words.source.credentialFields[(field[1] ?? "").toLowerCase()] ?? "SECRET")
          : tokens[0]?.name;
        if (!name || (field && value.raw.length < ctx.words.source.credentialMinLength)) continue;
        const range = (value as { at?: { range: Range } }).at?.range;
        report(
          range,
          { literal: value.raw, replace: value.raw, name, quoted: false },
          `${prefix}.${key}`,
        );
      }
    }
  },
};

const fixedEmail: LintRule = {
  id: "fixed-email",
  severity: "info",
  summary: "A fixed email address in a sign-up.",
  why: "A sign-up with the same email every time fails as soon as two runs overlap, or on the second run (ENV-3). A generated address is new each run.",
  bad: '1. Fill "Email" with ada@example.com\n2. Click "Sign up"',
  good: 'data:\n  email: "{{unique.email}}"\n…\n1. Fill "Email" with {{data.email}}\n2. Click "Sign up"',
  fixDescription:
    'Adds `email: "{{unique.email}}"` to data and uses {{data.email}} in the steps. Applied by --fix when the address appears in no Expect:, Soft: or Never: line.',
  check(ctx) {
    const fm = ctx.spec.frontmatter;
    const testLevel = [fm.name, fm.start?.raw ?? "", ...fm.tags].some((t) =>
      ctx.words.signup.test(t),
    );
    const guarded = protectedLines(ctx.spec);
    const checkText = own(ctx).filter(isCheckStep).map(stepText).join("\n");

    const found = new Map<string, { step?: Step; dataKey?: string }>();
    for (const step of own(ctx)) {
      if (isCheckStep(step) || (step.kind === "exact" && step.exact.form === "code")) continue;
      const text =
        step.kind === "flow"
          ? Object.values((step as FlowStep).params)
              .map((p) => p.raw)
              .join(" ")
          : stepText(step);
      if (!testLevel && !ctx.words.signup.test(text)) continue;
      for (const match of text.replace(/\{\{[^}]*\}\}/g, " ").matchAll(EMAIL)) {
        if (!found.has(match[0])) found.set(match[0], { step });
      }
    }
    if (testLevel) {
      for (const [key, value] of Object.entries(fm.data)) {
        const match = /^[^\s{]+@[^\s{]+\.[A-Za-z]{2,}$/.exec(value.raw.trim());
        if (match) found.set(match[0], { ...found.get(match[0]), dataKey: key });
      }
    }

    for (const [email, where] of found) {
      const edits: TextEdit[] = [];
      let key = where.dataKey;
      if (key) {
        const edit = setFrontmatterEntry(ctx, `data.${key}`, `  ${key}: "{{unique.email}}"`);
        if (edit) edits.push(edit);
      } else {
        key = ["email", "signupEmail", "email2", "email3"].find((k) => !(k in fm.data)) ?? "email4";
        const dataRange = ctx.spec.fields?.data;
        const firstKey = Object.keys(fm.data)[0];
        const indent = " ".repeat((ctx.spec.fields?.[`data.${firstKey}`]?.start.column ?? 3) - 1);
        const edit =
          dataRange && firstKey
            ? insertLines(dataRange.end.line + 1, [`${indent}${key}: "{{unique.email}}"`])
            : frontmatterInsert(ctx, ["data:", `  ${key}: "{{unique.email}}"`]);
        if (edit) edits.push(edit);
      }
      for (const step of own(ctx)) {
        if (isCheckStep(step)) continue;
        for (let n = 0; ; n++) {
          const range = rangeInStep(ctx.lines, step, email, n);
          if (!range || range === step.at?.range) break;
          if (!guarded.has(range.start.line)) edits.push({ range, newText: `{{data.${key}}}` });
        }
      }
      const safe = !checkText.includes(email) && edits.length > 0;
      const range = where.step
        ? rangeInStep(ctx.lines, where.step, email)
        : ctx.spec.fields?.[`data.${where.dataKey}`];
      ctx.report({
        range,
        message: `${email} is the same on every run, so a second or parallel sign-up with it will collide.`,
        fix: `Generate a fresh address per run: add email: "{{unique.email}}" under data: and use {{data.${key}}} in the steps.`,
        fixes: [{ title: `Use a generated email ({{data.${key}}})`, edits, safe }],
      });
    }
  },
};

const destructiveUndeclared: LintRule = {
  id: "destructive-undeclared",
  severity: "warning",
  summary: "A destructive step (delete, pay, send, invite, cancel) that the test doesn't declare.",
  why: "In production environments, destructive actions are blocked unless the test declares them (SAF-4). Undeclared, this step will be Blocked there.",
  bad: '3. Click "Delete project"',
  good: 'allowDestructive: [delete]\n…\n3. Click "Delete project"',
  fixDescription:
    "Offers to add the action to allowDestructive (never applied automatically: it is a safety decision).",
  check(ctx) {
    const fm = ctx.spec.frontmatter;
    if (fm.kind !== "test") return;
    const allowed = new Set<string>(fm.allowDestructive);
    const seen = new Set<string>();
    const check = (text: string, range: Range | undefined, via?: string) => {
      for (const { action, pattern } of ctx.words.destructive) {
        const match = pattern.exec(text);
        if (!match || allowed.has(action) || seen.has(`${action}|${range?.start.line}`)) continue;
        seen.add(`${action}|${range?.start.line}`);
        const list = [...fm.allowDestructive, action];
        const edit = setFrontmatterEntry(
          ctx,
          "allowDestructive",
          `allowDestructive: [${list.join(", ")}]`,
        );
        ctx.report({
          range,
          message: `${via ? `${via} has a step that looks like it will ${action}` : `This step looks like it will ${action}`} ("${match[0]}"), but "${action}" is not in allowDestructive. In production environments it will be Blocked.`,
          fix: `If the test is meant to ${action}, add it to the frontmatter: allowDestructive: [${list.join(", ")}]. Otherwise change the step.`,
          fixes: edit
            ? [{ title: `Add "${action}" to allowDestructive`, edits: [edit], safe: false }]
            : [],
        });
      }
    };
    for (const step of own(ctx)) {
      if (step.kind === "action") check(step.text.raw, rangeInStepOrText(ctx, step));
      else if (
        step.kind === "exact" &&
        step.exact.form === "op" &&
        !step.exact.op.op.startsWith("expect")
      ) {
        check(stepText(step), step.at?.range);
      }
    }
    for (const step of ctx.expanded.steps) {
      if (step.flowPath.length === 0 || (step.kind !== "action" && step.kind !== "exact")) continue;
      if (step.exact?.form === "op" && step.exact.op.op.startsWith("expect")) continue;
      check(step.text, step.origin[0]?.range, step.flowPath[step.flowPath.length - 1]);
    }
  },
};

function rangeInStepOrText(_ctx: RuleContext, step: TextStep): Range | undefined {
  return step.text.at?.range ?? step.at?.range;
}

const vagueGuard: LintRule = {
  id: "vague-guard",
  severity: "warning",
  summary: "A Never: that names nothing specific.",
  why: '"Never: break anything" can\'t be enforced: the agent needs a concrete action or element to avoid.',
  bad: "Never: break anything",
  good: 'Never: click "Delete account"',
  check(ctx) {
    for (const step of textSteps(ctx, "guard")) {
      const text = step.text.raw;
      if (hasTarget(text, ctx.words) || !ctx.words.vagueGuard.test(text)) continue;
      ctx.report({
        range: step.text.at?.range ?? step.at?.range,
        message: `"${text}" doesn't name anything specific to avoid, so it can't be enforced.`,
        fix: 'Name the action and its target, e.g. Never: click "Delete account", or Never: go to /admin.',
      });
    }
  },
};

const fixedWait: LintRule = {
  id: "fixed-wait",
  severity: "warning",
  summary: 'A fixed wait like "Wait 5 seconds".',
  why: "Fixed waits are the most common cause of flaky tests: too short on a slow day, wasted time on a fast one. Runs learn how long each step needs to settle (LRN-4).",
  bad: "4. Wait 5 seconds",
  good: '4. Expect: the message "Saved" is shown',
  fixDescription:
    "Removes the step and renumbers the ones after it. Applied by --fix only when no Expect:, Soft: or Never: line would be renumbered.",
  check(ctx) {
    for (const step of own(ctx)) {
      let text: string | undefined;
      if (step.kind === "action") text = step.text.raw;
      else if (step.kind === "exact" && step.exact.form === "code") text = step.exact.code;
      if (text === undefined) continue;
      const match = ctx.words.fixedWait.map((p) => p.exec(text)).find(Boolean);
      if (!match) continue;
      const span = stepLines(step);
      const later = laterNumbered(ctx, step);
      const fixes: Fix[] = [];
      if (span) {
        const remove: TextEdit = {
          range: { start: { line: span[0], column: 1 }, end: { line: span[1] + 1, column: 1 } },
          newText: "",
        };
        const renumber = step.number === null ? [] : renumberAfter(ctx, step, -1);
        fixes.push({
          title: "Remove the fixed wait",
          edits: [remove, ...renumber],
          safe: step.number === null || !later.some(isCheckStep),
        });
      }
      ctx.report({
        range:
          step.kind === "action"
            ? (rangeInStep(ctx.lines, step, match[0]) ?? step.at?.range)
            : step.at?.range,
        message: `"${match[0]}" waits a fixed time, which makes tests slow and flaky.`,
        fix: 'Remove it, or say what to wait for, e.g. Expect: the message "Saved" is shown. Runs learn how long pages take to settle.',
        fixes,
      });
    }
  },
};

const duplicateTestName: LintRule = {
  id: "duplicate-test-name",
  severity: "warning",
  summary: "Two tests with the same name.",
  why: "Results, reports and PR comments show tests by name. Two with the same name can't be told apart.",
  bad: "tests/a.test.md: name: Checkout works\ntests/b.test.md: name: Checkout works",
  good: "tests/a.test.md: name: Guest checkout works\ntests/b.test.md: name: Member checkout works",
  checkProject(ctx) {
    const byName = new Map<string, (typeof ctx.files)[number][]>();
    for (const file of ctx.files) {
      if (file.spec.frontmatter.kind !== "test" || file.spec.frontmatter.name === "") continue;
      const key = file.spec.frontmatter.name.trim().toLowerCase().replace(/\s+/g, " ");
      byName.set(key, [...(byName.get(key) ?? []), file]);
    }
    for (const files of byName.values()) {
      if (files.length < 2) continue;
      for (const file of files) {
        const others = files.filter((f) => f !== file).map((f) => f.path);
        ctx.report({
          file: file.path,
          range: file.spec.fields?.name,
          message: `Another test has the same name "${file.spec.frontmatter.name}": ${others.join(", ")}.`,
          fix: "Give each test a name that says what makes it different.",
        });
      }
    }
  },
};

const unusedFlow: LintRule = {
  id: "unused-flow",
  severity: "info",
  summary: "A flow no test uses.",
  why: "An unused flow is never run, so it quietly goes stale.",
  bad: "tests/flows/old-login.test.md (kind: flow), not in any Use: step",
  good: "Use it from a test (Use: flows/old-login.test.md), or delete it.",
  checkProject(ctx) {
    const used = new Set(
      ctx.files.filter((f) => f.spec.frontmatter.kind === "test").flatMap((f) => f.expanded.files),
    );
    for (const file of ctx.files) {
      if (file.spec.frontmatter.kind !== "flow" || used.has(file.path)) continue;
      ctx.report({
        file: file.path,
        range: file.spec.fields?.name ?? {
          start: { line: 1, column: 1 },
          end: { line: 1, column: 4 },
        },
        message: `No test uses the flow "${file.spec.frontmatter.name || file.path}".`,
        fix: `Include it from a test with Use: ${file.path.split("/").slice(1).join("/")}, or delete it.`,
      });
    }
  },
};

/** Every rule, in documentation order. */
export const LINT_RULES: readonly LintRule[] = [
  vagueStep,
  expectNotObservable,
  noExpectations,
  softOnly,
  missingStart,
  compoundExpect,
  literalCredential,
  fixedEmail,
  destructiveUndeclared,
  vagueGuard,
  fixedWait,
  duplicateTestName,
  unusedFlow,
];
