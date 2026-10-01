import type {
  ActionOutcome,
  ObservedElement,
  PageCopy,
  RecordedTarget,
  RecordedUserEvent,
  RecordReply,
  Session,
} from "@optestra/browser";
import type { Config } from "@optestra/config";
import {
  type CheckRecording,
  type Command,
  checkKey,
  describeCheck,
  RECORDING_EPOCH,
  RECORDING_VERSION,
  type Recording,
  routeOf,
  type StepRecording,
  stepKey,
  type TemplateVariable,
} from "@optestra/recording";
import {
  expandTest,
  type FileReader,
  type Finding,
  mapReader,
  parseTest,
  type TestSpec,
} from "@optestra/spec";
import { commandOf, fingerprintOf, pageTemplate } from "../author/commands.js";
import { compileCheck } from "../checks/compile.js";
import type { DraftItem } from "../draft/draft.js";
import { finishDraft } from "../draft/draft.js";
import { type DraftedAction, labelOf, slugOf, stepText } from "../draft/phrasing.js";

// Record mode (AUT-8): the user clicks through the app in a headed browser and
// gets a test: the English `.test.md` (steps phrased like the drafter's) AND
// its recording (locators and fingerprints from the harness's candidates, the
// post-state and settle time of every click and Enter; typing and selects are
// the user's own), so it replays with no AI.
// Guarantee 2: typed values never land in the file as they are. A known
// secret becomes {{secret.NAME}}, a password with no known secret becomes
// {{secret.PASSWORD}} (declare and set it), an email becomes {{data.email}}
// ({{unique.email}} on a sign-up page), other text a `data` value to edit.
// Guarantee 1: the result is returned, not saved; the caller asks first.

export type RecordSession = Pick<
  Session,
  "record" | "act" | "observe" | "pageCopy" | "check" | "screenshot" | "url" | "browserName"
>;

export interface RecordTestOptions {
  session: RecordSession;
  /** Where recording starts (a path on the app, default "/"). */
  start?: string | undefined;
  name?: string | undefined;
  /** Default "tests". */
  testsDir?: string | undefined;
  /** The file's project-relative path for the test's name (default `<testsDir>/<slug>.test.md`). */
  pathFor?: ((name: string) => string) | undefined;
  config?: Config | undefined;
  readFile?: FileReader | undefined;
  meta: { engineVersion: string; device: string; environment: string | null };
  overlay?: boolean;
  /** Finish recording (e.g. Ctrl-C). The window closing or the overlay's Finish also do. */
  signal?: AbortSignal | undefined;
  onProgress?: ((line: RecordProgress) => void) | undefined;
  /** Test hook: a scripted person using the page (see Session.record). */
  user?: ((user: import("@optestra/browser").ScriptedUser) => void) | undefined;
  now?: () => Date;
}

export type RecordProgress =
  | { type: "step"; text: string }
  | { type: "expect"; text: string; summary: string }
  | { type: "refused"; text: string; message: string }
  | { type: "note"; message: string };

export interface RecordedTest {
  /** How it ended: the overlay's Finish, the window closed, or the signal. */
  ended: "finished" | "closed" | "stopped";
  name: string;
  path: string;
  text: string;
  spec: TestSpec;
  findings: Finding[];
  lintClean: boolean;
  recording: Recording;
  items: DraftItem[];
  /** What to do before it replays (declare a secret, copy an upload file). */
  notes: string[];
  /** Secrets the test uses that the project may not declare yet. */
  secrets: string[];
  /** Files to copy next to the test (tests/files/<name>). */
  files: string[];
}

const SIGN_UP = /sign ?up|register|create (an |your )?account|join/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** camelCase data key from a field label: "Project name" → projectName. */
export function dataKey(label: string, taken: ReadonlySet<string>): string {
  const words = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4);
  let key = words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
  if (!/^[a-z]/.test(key)) key = `value${key ? key.charAt(0).toUpperCase() + key.slice(1) : ""}`;
  let out = key;
  for (let n = 2; taken.has(out); n++) out = `${key}${n}`;
  return out;
}

/** UPPER_SNAKE secret name from a field label: "Password" → PASSWORD. */
export function secretName(label: string, taken: ReadonlySet<string>): string {
  let name = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[A-Z]/.test(name)) name = `SECRET${name ? `_${name}` : ""}`;
  let out = name;
  for (let n = 2; taken.has(out); n++) out = `${name}_${n}`;
  return out;
}

/** The element as the phrasing sees it. */
function elementOf(target: RecordedTarget): ObservedElement {
  const facts = target.candidates.facts;
  return {
    role: facts?.role ?? "generic",
    name: facts?.name ?? "",
    ...(facts?.text ? { text: facts.text } : {}),
    depth: 0,
    states: {},
    interactive: true,
    frame: 0,
  };
}

/** An outcome for what the user did natively (typing a password, choosing a file, an address). */
function nativeOutcome(action: ActionOutcome["action"], url: string, before = url): ActionOutcome {
  return {
    action,
    status: "ok",
    ms: 0,
    settledMs: 0,
    settle: {
      settledMs: 0,
      timedOut: false,
      waitedFor: { network: 0, dom: 0, busy: 0 },
      inflight: 0,
    },
    post: {
      urlBefore: before,
      urlAfter: url,
      added: [],
      removed: [],
      requests: [],
      dialogs: [],
      popups: [],
      refused: [],
      changed: before !== url,
      reordered: false,
    },
  } as ActionOutcome;
}

const portable = (url: string, current: string) => {
  try {
    const target = new URL(url, current);
    const here = new URL(current);
    if (target.origin === here.origin) return `${target.pathname}${target.search}${target.hash}`;
  } catch {}
  return url;
};

const quote = (text: string) =>
  text.replace(/["“”]/g, "'").replace(/\s+/g, " ").trim().slice(0, 120);

/** Records what the user does until they finish; returns the test and its recording. Saves nothing. */
export async function recordTest(options: RecordTestOptions): Promise<RecordedTest> {
  const session = options.session;
  const now = options.now ?? (() => new Date());
  const start = options.start?.trim() || "/";
  const items: DraftItem[] = [];
  const captured: { route: string; commands: Command[] }[] = [];
  const compiled: Omit<CheckRecording, "key" | "textKey">[] = [];
  const notes: string[] = [];
  const secrets = new Set<string>();
  const files = new Set<string>();
  /** data key → value as written (literal, or {{unique.email}}). */
  const values = new Map<string, string>();
  /** field label + typed value → key, so the same value typed again reuses it. */
  const byTyped = new Map<string, string>();
  let before: PageCopy | undefined;
  const progress = options.onProgress ?? (() => {});

  const variables = (): TemplateVariable[] => [
    ...[...values].map(([key, value]) => ({ ref: `data.${key}`, value })),
    ...[...secrets].map((name) => ({ ref: `secret.${name}` })),
  ];
  const addStep = (drafted: DraftedAction, command: Command, route: string) => {
    const text = stepText(drafted);
    items.push({ kind: "action", text });
    captured.push({ route, commands: [command] });
    progress({ type: "step", text });
  };

  const opened = await session.act({ type: "goto", url: start });
  if (opened.status !== "ok")
    throw new Error(
      `The start page ${start} could not be opened: ${opened.message ?? opened.status}`,
    );

  const onEvent = async (event: RecordedUserEvent): Promise<RecordReply | undefined> => {
    const route = routeOf(session.url);
    switch (event.type) {
      case "click":
      case "check":
      case "uncheck": {
        const found = fingerprintOf(event.target.candidates);
        if (!found) return { ok: false, message: "That element can't be recorded." };
        before = await session.pageCopy();
        const outcome = await session.act({ type: event.type, target: event.target.act });
        if (outcome.status !== "ok")
          return { ok: false, message: `Not recorded: ${outcome.message ?? outcome.status}` };
        addStep(
          { type: event.type, element: elementOf(event.target) },
          commandOf(
            { type: event.type, target: found.primary },
            found.fingerprint,
            outcome,
            variables(),
          ),
          route,
        );
        return undefined;
      }
      case "press": {
        const found = fingerprintOf(event.target.candidates);
        before = await session.pageCopy();
        const outcome = await session.act({
          type: "press",
          key: event.key,
          target: event.target.act,
        });
        if (outcome.status !== "ok")
          return { ok: false, message: `Not recorded: ${outcome.message ?? outcome.status}` };
        addStep(
          { type: "press", key: event.key, element: elementOf(event.target) },
          commandOf(
            { type: "press", key: event.key, ...(found ? { target: found.primary } : {}) },
            found?.fingerprint ?? null,
            outcome,
            variables(),
          ),
          route,
        );
        return undefined;
      }
      case "fill": {
        const found = fingerprintOf(event.target.candidates);
        if (!found) return { ok: false, message: "That field can't be recorded." };
        const label = labelOf(elementOf(event.target)) ?? "value";
        let template: string;
        if (event.secret) {
          secrets.add(event.secret);
          template = `{{secret.${event.secret}}}`;
        } else if (event.sensitive) {
          // Never the literal: a secret the user declares, then sets.
          const name = secretName(label, secrets);
          secrets.add(name);
          template = `{{secret.${name}}}`;
          const line = `The password typed into "${label}" is not in the file: it is {{secret.${name}}}. Declare ${name} in the project's secrets and set its value before running the test.`;
          notes.push(line);
          progress({ type: "note", message: line });
        } else {
          const value = event.value ?? "";
          const typedKey = `${label}\u0000${value}`;
          let key = byTyped.get(typedKey);
          if (!key) {
            const email = EMAIL.test(value.trim());
            key = dataKey(email ? "email" : label, new Set(values.keys()));
            const onSignUp =
              email &&
              (SIGN_UP.test(route) ||
                SIGN_UP.test((await session.observe()).title) ||
                SIGN_UP.test(label));
            values.set(key, onSignUp ? "{{unique.email}}" : value);
            byTyped.set(typedKey, key);
          }
          template = `{{data.${key}}}`;
        }
        // The user typed it already: it isn't typed again (that would take their focus).
        const outcome = nativeOutcome(
          { type: "fill", target: event.target.act, value: "" },
          session.url,
        );
        addStep(
          { type: "fill", element: elementOf(event.target), value: template },
          commandOf(
            { type: "fill", target: found.primary, value: template },
            found.fingerprint,
            outcome,
            variables(),
          ),
          route,
        );
        return undefined;
      }
      case "select": {
        const found = fingerprintOf(event.target.candidates);
        if (!found) return { ok: false, message: "That list can't be recorded." };
        // Chosen already by the user, like typing.
        const outcome = nativeOutcome(
          { type: "select", target: event.target.act, option: event.option },
          session.url,
        );
        const option = pageTemplate(event.option, variables());
        addStep(
          { type: "select", element: elementOf(event.target), option },
          commandOf(
            { type: "select", target: found.primary, option },
            found.fingerprint,
            outcome,
            variables(),
          ),
          route,
        );
        return undefined;
      }
      case "upload": {
        const found = fingerprintOf(event.target.candidates);
        if (!found || event.files.length === 0) return undefined;
        const paths = event.files.map((name) => `files/${name.replace(/[\\/]/g, "_")}`);
        for (const path of paths) files.add(path);
        const line = `Copy ${event.files.join(", ")} to the test's files/ folder: the upload reads ${paths.join(", ")}.`;
        notes.push(line);
        progress({ type: "note", message: line });
        addStep(
          { type: "upload", element: elementOf(event.target), file: paths[0] as string },
          commandOf(
            { type: "upload", target: found.primary, files: paths },
            found.fingerprint,
            nativeOutcome({ type: "upload", target: event.target.act, files: paths }, session.url),
            variables(),
          ),
          route,
        );
        return undefined;
      }
      case "goto": {
        const url = portable(event.url, session.url);
        const previous = captured.at(-1);
        addStep(
          { type: "goto", url },
          commandOf(
            { type: "goto", url },
            null,
            nativeOutcome({ type: "goto", url }, event.url, previous ? session.url : event.url),
            variables(),
          ),
          route,
        );
        return undefined;
      }
      case "mark": {
        const candidates: string[] = [];
        if (event.kind === "url") {
          const path = routeOf(session.url).split("?")[0] ?? "/";
          candidates.push(`the URL contains ${path}`);
        } else if (event.kind === "text" && event.text) {
          candidates.push(`the page shows "${quote(event.text)}"`);
        } else if (event.target) {
          const element = elementOf(event.target);
          const label = labelOf(element) ?? (event.text ? quote(event.text) : undefined);
          if (label) {
            if (element.role === "heading")
              candidates.push(`the page heading is "${quote(label)}"`);
            if (element.role === "status" || element.role === "alert")
              candidates.push(`a message says "${quote(event.text || label)}"`);
            if (["button", "link", "checkbox"].includes(element.role))
              candidates.push(`the "${quote(label)}" ${element.role} is shown`);
            candidates.push(`the page shows "${quote(event.text || label)}"`);
          }
        }
        if (candidates.length === 0)
          return {
            ok: false,
            message: "Select some text, or click an element with text, to expect it.",
          };
        let why = "";
        for (const text of candidates) {
          const check = await compileCheck(
            { text, soft: false },
            {
              session,
              values: Object.fromEntries(
                variables()
                  .filter((v) => v.value !== undefined)
                  .map((v) => [v.ref, v.value as string]),
              ),
              before,
              timeoutMs: 2_000,
            },
          );
          if (check.op.type === "pending") {
            why = check.problem ?? "no check can be made from it";
            continue;
          }
          if (check.problem || check.evaluation?.passed !== true) {
            why =
              check.problem ??
              `it doesn't hold now (saw ${JSON.stringify(check.evaluation?.actual ?? null)})`;
            continue;
          }
          items.push({
            kind: "expect",
            text,
            check: { summary: check.summary, ...(check.rule ? { rule: check.rule } : {}) },
          });
          compiled.push({
            text,
            soft: false,
            check: check.op,
            generatedBy: "rules",
            summary: check.summary,
            ...(check.rule ? { rule: check.rule } : {}),
            ...(check.sanity ? { sanity: check.sanity } : {}),
            recordedAt: now().toISOString(),
          });
          progress({ type: "expect", text, summary: check.summary });
          return { ok: true, message: `Added: Expect: ${text}` };
        }
        progress({ type: "refused", text: candidates[0] as string, message: why });
        return { ok: false, message: `Not added: ${why}` };
      }
      default:
        return undefined;
    }
  };

  const control = await session.record({
    onEvent,
    ...(options.overlay !== undefined ? { overlay: options.overlay } : {}),
    ...(options.user ? { user: options.user } : {}),
  });
  const stopped = new Promise<"stopped">((resolve) => {
    if (options.signal?.aborted) resolve("stopped");
    options.signal?.addEventListener("abort", () => resolve("stopped"), { once: true });
  });
  const ended = await Promise.race([control.finished, stopped]);
  await control.stop();

  const name = options.name?.trim() || `Recorded on ${routeOf(start).split("?")[0]}`;
  const path = options.pathFor?.(name) ?? `${options.testsDir ?? "tests"}/${slugOf(name)}.test.md`;
  if (!items.some((i) => i.kind === "expect"))
    notes.push(
      "No expectation was marked: add an Expect: line (or record again and mark one) so the test can fail.",
    );
  const finished = await finishDraft({
    name,
    start,
    items,
    data: {},
    values: Object.fromEntries(values),
    path,
    config: options.config,
    readFile: options.readFile,
  });

  // The recording, keyed like authoring's: the printed file's steps, in order.
  const readFile = options.readFile ?? mapReader({ [path]: finished.text });
  const parsed = parseTest(finished.text, path, { config: options.config });
  const expanded = await expandTest(parsed.spec, {
    readFile: (p) => (p === path ? finished.text : readFile(p)),
    seed: "record",
    config: options.config,
  });
  const steps: StepRecording[] = [];
  const checks: CheckRecording[] = [];
  let a = 0;
  let c = 0;
  const at = now().toISOString();
  for (const step of expanded.steps) {
    if (step.kind === "action") {
      const got = captured[a++];
      if (!got) continue;
      steps.push({
        key: stepKey(step.textKey, got.route),
        textKey: step.textKey,
        route: got.route,
        text: step.text,
        kind: "action",
        commands: got.commands,
        source: "record",
        recordedAt: at,
      });
    } else if (step.kind === "expect") {
      const got = compiled[c++];
      if (!got) continue;
      checks.push({ key: checkKey(step.textKey), textKey: step.textKey, ...got, text: step.text });
    }
  }
  for (const step of expanded.steps.filter((s) => s.kind === "expect").slice(c))
    checks.push({
      key: checkKey(step.textKey),
      textKey: step.textKey,
      text: step.text,
      soft: false,
      check: { type: "pending" },
      generatedBy: "rules",
      summary: describeCheck({ type: "pending" }),
      recordedAt: at,
    });
  const recording: Recording = {
    recordingVersion: RECORDING_VERSION,
    testId: expanded.id,
    testPath: path,
    target: "web",
    recordedWith: {
      engineVersion: options.meta.engineVersion,
      epoch: RECORDING_EPOCH,
      browser: session.browserName,
      device: options.meta.device,
      environment: options.meta.environment,
      model: null,
      promptVersion: null,
    },
    updatedAt: at,
    steps,
    checks,
  };
  for (const finding of finished.findings.filter((f) => f.severity !== "info"))
    notes.push(`Lint: ${finding.rule ?? finding.code}: ${finding.message}`);
  return {
    ended,
    name,
    path,
    ...finished,
    recording,
    items,
    notes,
    secrets: [...secrets],
    files: [...files],
  };
}
