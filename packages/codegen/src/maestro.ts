import { brand } from "@optestra/brand";
import { ENV_PREFIX } from "@optestra/config";
import type { Command, Fingerprint, Locator } from "@optestra/recording";
import type { ExpandedStep, ExpandedTest, Hook } from "@optestra/spec";
import { type Header, withHeader } from "./header.js";
import type { CodegenCheck, CodegenRecording } from "./recording.js";
import {
  type FlowCall,
  flowTree,
  type GeneratedFile,
  type Item,
  isCheckStep,
  recordingFileName,
  recordingKey,
  sourceLine,
} from "./spec.js";
import { recordingParts } from "./values.js";

// Android recordings as Maestro flows (MOB-6, EXP-2): the portable copy of an
// Android test, run with the Maestro CLI alone (`maestro test <file>`). One flow
// per test, flows (`Use:`) inlined, each English step as a comment above its
// commands. Secrets are never in the file: `${NAME}` reads the Maestro env var of
// the same name at run time (`maestro test -e NAME=…`). What Maestro can't express
// faithfully is left out with a comment ("checked by <product> only"), never
// approximated; an action it can't do ends the flow there, since what follows
// would run on the wrong screen.

export const maestroFileName = (testId: string) => `${testId}.maestro.yaml`;

export interface MaestroSource {
  expanded: ExpandedTest;
  /** Where setup/teardown requests go (the environment's baseUrl). */
  baseUrl?: string;
}

export interface MaestroFlow extends GeneratedFile {
  /** The app's package (the flow's `appId`). */
  appId: string;
  /** Env vars the flow needs at run time without a default (secrets). */
  secrets: string[];
  /** What is only checked by the product, one line each (for the export README). */
  gaps: string[];
}

const BASE_URL = `${ENV_PREFIX}BASE_URL`;
const q = (text: string) => JSON.stringify(text);
const only = (reason: string) => `Checked by ${brand.productName} only: ${reason}.`;

/** Permission prompt buttons across Android versions (the harness's list), as one id pattern. */
const PERMISSION_IDS: Record<"allow" | "allow_once" | "deny", string> = {
  allow:
    ".*:id/(permission_allow_foreground_only_button|permission_allow_button|permission_allow_always_button)",
  allow_once:
    ".*:id/(permission_allow_one_time_button|permission_allow_foreground_only_button|permission_allow_button)",
  deny: ".*:id/(permission_deny_button|permission_deny_and_dont_ask_again_button)",
};
const KEYS: Record<string, string> = {
  Enter: "Enter",
  Backspace: "Backspace",
  Back: "Back",
  Home: "Home",
  Tab: "Tab",
};
const WAIT_MS = 10_000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const upperSnake = (text: string) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

/** A YAML map: scalars, or nested maps (`element:`, `from:`, `when: visible:`). */
type Scalar = string | number | boolean;
type Fields = Array<[string, Scalar | Fields]>;
/** A Maestro selector, as `key: value` fields. */
type Selector = { ok: true; fields: Array<[string, Scalar]> } | Unsupported;
type Unsupported = { ok: false; reason: string };

/** The resource id a fingerprint names, when its locators show it identifies the element. */
function resourceId(
  fingerprint: Fingerprint | null | undefined,
): { id: string; index?: number } | null {
  const rid = fingerprint?.attributes["resource-id"];
  // Android's own ids (android:id/text1 on every list row, android:id/button1) name a
  // kind of view, not this one: the element's text says more.
  if (!rid || rid.startsWith("android:")) return null;
  const locators = [fingerprint.primary, ...fingerprint.fallbacks];
  if (locators.some((l) => l.kind === "testId" && l.nth === undefined)) return { id: rid };
  const css = locators.find(
    (l) => l.kind === "css" && l.selector.includes(`[resource-id="${rid}"]`),
  );
  if (css) return css.nth === undefined ? { id: rid } : { id: rid, index: css.nth };
  return null;
}

function textPattern(text: string, exact: boolean | undefined): string {
  return exact === false ? `.*${escapeRegExp(text)}.*` : escapeRegExp(text);
}

/** How Maestro finds the element: its resource id when recorded, else its visible text. */
function selectorFor(target: Locator, fingerprint?: Fingerprint | null): Selector {
  const index = (nth: number | undefined): Array<[string, number]> =>
    nth === undefined ? [] : [["index", nth]];
  const byId = resourceId(fingerprint);
  if (byId) return { ok: true, fields: [["id", byId.id], ...index(byId.index)] };
  switch (target.kind) {
    case "testId":
      return { ok: true, fields: [["id", target.value], ...index(target.nth)] };
    case "role":
      if (target.name === undefined)
        return { ok: false, reason: `a ${target.role} without a name has no Maestro selector` };
      return {
        ok: true,
        fields: [["text", textPattern(target.name, target.exact)], ...index(target.nth)],
      };
    case "text":
    case "label":
    case "placeholder":
    case "alt":
    case "title":
      return {
        ok: true,
        fields: [["text", textPattern(target.text, target.exact)], ...index(target.nth)],
      };
    case "css": {
      const rid = /\[resource-id="([^"]+)"\]/.exec(target.selector)?.[1];
      if (rid) return { ok: true, fields: [["id", rid], ...index(target.nth)] };
      return { ok: false, reason: `the CSS locator ${target.selector} has no Maestro selector` };
    }
  }
}

class FlowWriter {
  readonly lines: string[] = [];
  readonly env = new Map<string, string>();
  readonly secrets = new Set<string>();
  readonly gaps: string[] = [];
  /** Set when an action couldn't be exported: the rest is comments only. */
  stopped: string | null = null;
  readonly recorded: Map<string, CodegenRecording["steps"][number]>;
  readonly checks: Map<string, CodegenCheck>;

  constructor(
    readonly recording: CodegenRecording,
    readonly source: MaestroSource,
  ) {
    this.recorded = new Map(recording.steps.map((step) => [step.textKey, step]));
    this.checks = new Map(recording.checks.map((check) => [check.textKey, check]));
  }

  comment(text: string, indent = ""): void {
    for (const line of text.split("\n")) this.lines.push(`${indent}# ${line}`.trimEnd());
  }

  /** `- name:` with a nested map, `- name: value`, or `- name`. */
  command(
    name: string,
    value?: string | Fields,
    out: string[] = this.lines,
    indent = "",
  ): undefined {
    if (value === undefined) out.push(`${indent}- ${name}`);
    else if (typeof value === "string") out.push(`${indent}- ${name}: ${value}`);
    else {
      out.push(`${indent}- ${name}:`);
      FlowWriter.map(value, `${indent}    `, out);
    }
  }

  static map(fields: Fields, indent: string, out: string[]): void {
    for (const [key, v] of fields) {
      if (Array.isArray(v)) {
        out.push(`${indent}${key}:`);
        FlowWriter.map(v, `${indent}  `, out);
      } else out.push(`${indent}${key}: ${typeof v === "string" ? q(v) : v}`);
    }
  }

  gap(line: string, reason: string): undefined {
    this.comment(only(reason));
    this.gaps.push(`${line}: ${reason}`);
  }

  stop(line: string, reason: string): undefined {
    this.comment(`${only(reason)} Maestro stops here: the steps below need it.`);
    this.gaps.push(`${line}: ${reason} (the rest of the test is not exported)`);
    this.stopped = reason;
  }

  /**
   * A recording template as Maestro text: literal text, `${NAME}` for a secret,
   * `${DATA_X}` / `${<prefix>VAR_X}` (with defaults) for data and environment vars.
   */
  value(template: string, step: ExpandedStep): { ok: true; text: string } | Unsupported {
    let out = "";
    const bound = new Map<string, string>();
    for (const segment of step.bound)
      if (segment.kind === "value") bound.set(segment.ref, segment.text);
    const secrets = step.bound.filter((s) => s.kind === "secret").map((s) => s.name);
    for (const part of recordingParts(template)) {
      if ("text" in part) {
        if (part.text.includes("${"))
          return {
            ok: false,
            reason: "the text contains `${`, which Maestro would read as a variable",
          };
        out += part.text;
        continue;
      }
      const [ns, ...rest] = part.ref.split(".");
      const key = rest.join(".");
      if (ns === "secret") {
        this.secrets.add(key);
        out += `\${${key}}`;
      } else if (ns === "unique" || ns === "faker") {
        return { ok: false, reason: `{{${part.ref}}} is made fresh on every run` };
      } else if (ns === "inbox") {
        return { ok: false, reason: `{{${part.ref}}} is read from an email` };
      } else if (ns === "data" || ns === "env") {
        const text = bound.get(part.ref);
        if (text === undefined) return { ok: false, reason: `{{${part.ref}}} has no value here` };
        const name =
          ns === "data" ? `DATA_${upperSnake(key)}` : `${ENV_PREFIX}VAR_${upperSnake(key)}`;
        this.env.set(name, text);
        out += `\${${name}}`;
      } else if (ns === "params") {
        const text = bound.get(part.ref);
        if (text !== undefined) out += text;
        else if (secrets.length === 1) {
          // A param holding a secret: the step shows it as the secret itself.
          this.secrets.add(secrets[0] as string);
          out += `\${${secrets[0]}}`;
        } else return { ok: false, reason: `{{${part.ref}}} has no value here` };
      } else return { ok: false, reason: `{{${part.ref}}} has no Maestro equivalent` };
    }
    return { ok: true, text: out };
  }

  // ── actions ──

  action(cmd: Command, step: ExpandedStep, line: string): undefined {
    const action = cmd.action;
    const target = "target" in action ? (action.target as Locator | undefined) : undefined;
    const sel = target ? selectorFor(target, cmd.fingerprint) : undefined;
    if (sel && !sel.ok) return this.stop(line, sel.reason);
    const fields = sel?.ok ? sel.fields : [];
    switch (action.type) {
      case "click":
        this.command("tapOn", fields);
        return this.effect(cmd);
      case "dblclick":
        this.command("doubleTapOn", fields);
        return this.effect(cmd);
      case "long_press":
        this.command("longPressOn", fields);
        return this.effect(cmd);
      case "fill": {
        if (typeof action.value !== "string")
          return this.stop(line, "the value isn't text Maestro can type");
        const value = this.value(action.value, step);
        if (!value.ok) return this.stop(line, value.reason);
        this.command("tapOn", fields);
        // A fill replaces what the field holds.
        this.command("eraseText");
        return this.command("inputText", q(value.text));
      }
      case "clear":
        this.command("tapOn", fields);
        return this.command("eraseText");
      case "check":
      case "uncheck": {
        // Tap only when the box isn't already in that state, as the harness does.
        const state = action.type === "check";
        this.command("runFlow", [["when", [["visible", [...fields, ["checked", !state]]]]]]);
        this.lines.push("    commands:");
        this.command("tapOn", fields, this.lines, "      ");
        return;
      }
      case "press": {
        const key = KEYS[action.key];
        if (!key) return this.stop(line, `Maestro has no key "${action.key}"`);
        if (target) this.command("tapOn", fields);
        return this.command("pressKey", key);
      }
      case "scroll":
        if (target)
          return this.command("scrollUntilVisible", [
            ["element", fields],
            ["direction", action.direction === "up" ? "UP" : "DOWN"],
          ]);
        if (action.direction === "up") return this.command("swipe", [["direction", "DOWN"]]);
        return this.command("scroll");
      case "swipe":
        return this.command("swipe", [
          ...(target ? [["from", fields] as [string, Fields]] : []),
          ["direction", action.direction.toUpperCase()],
        ]);
      case "back":
        return this.command("back");
      case "home":
        return this.command("pressKey", "Home");
      case "launch_app":
        return this.command("launchApp");
      case "goto":
      case "open_deep_link": {
        if (typeof action.url !== "string")
          return this.stop(line, "the link is read from an email");
        const url = this.value(action.url, step);
        if (!url.ok) return this.stop(line, url.reason);
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url.text))
          return this.stop(line, `"${url.text}" is not a link (a deep link needs its scheme)`);
        return this.command("openLink", q(url.text));
      }
      case "permission":
        return this.command("tapOn", [["id", PERMISSION_IDS[action.decision]]]);
      case "waitFor": {
        const timeout = action.timeoutMs ?? WAIT_MS;
        let visible: Array<[string, Scalar]> = fields;
        if (!target && action.text !== undefined) {
          const text = this.value(action.text, step);
          if (!text.ok) return this.stop(line, text.reason);
          visible = [["text", `.*${escapeRegExp(text.text)}.*`]];
        }
        if (visible.length === 0) return this.stop(line, "a wait with nothing to wait for");
        return this.command("extendedWaitUntil", [
          ["visible", visible],
          ["timeout", timeout],
        ]);
      }
      case "rotate":
        return this.stop(line, "Maestro has no rotation command");
      default:
        return this.stop(line, `\`${action.type}\` has no Maestro command`);
    }
  }

  /**
   * The tap's recorded effect, as far as Maestro can see it (VER-5): when the tapped
   * element itself went away (the screen changed), wait until it has. A tap that
   * does nothing then fails here, as it does in the replay, not at a later check
   * that could find the same text elsewhere (the field it was typed into).
   */
  effect(cmd: Command): undefined {
    const fingerprint = cmd.fingerprint;
    const id = resourceId(fingerprint);
    if (!fingerprint || !id || id.index !== undefined) return;
    const gone = (cmd.expectPost.removed ?? []).some(
      (e) => e.role === fingerprint.role && e.name === fingerprint.name,
    );
    if (!gone) return;
    this.command("extendedWaitUntil", [
      ["notVisible", [["id", id.id]]],
      ["timeout", WAIT_MS],
    ]);
  }

  // ── checks ──

  /** Did the step before this check show `text` on screen (a view, not a toast)? */
  shownOnScreen(step: ExpandedStep, text: string): boolean {
    const steps = this.source.expanded.steps;
    for (let i = steps.indexOf(step) - 1; i >= 0; i--) {
      const before = steps[i] as ExpandedStep;
      if (isCheckStep(before)) continue;
      const recorded = this.recorded.get(before.textKey);
      const appeared = recorded?.commands.at(-1)?.expectPost.appeared ?? [];
      return appeared.some((e) => `${e.name} ${e.text ?? ""}`.includes(text));
    }
    return false;
  }

  check(check: CodegenCheck | undefined, step: ExpandedStep, line: string): undefined {
    if (!check) return this.gap(line, "the check isn't compiled yet");
    const op = check.check as { type: string; [key: string]: unknown };
    const soft = check.soft;
    // A Soft: check only warns: Maestro's `optional` reports it without failing the flow.
    const assert = (name: "assertVisible" | "assertNotVisible", fields: Array<[string, Scalar]>) =>
      this.command(name, [...fields, ...(soft ? [["optional", true] as [string, boolean]] : [])]);
    const target = op.target as Locator | undefined;
    if (op.scope !== undefined) return this.gap(line, "Maestro can't look inside a container");
    switch (op.type) {
      case "text":
      case "value": {
        const value = this.value(String(op.value ?? ""), step);
        if (!value.ok) return this.gap(line, value.reason);
        if (check.rule === "message" && !this.shownOnScreen(step, value.text))
          return this.gap(line, "the message is a toast, and Maestro can't see toasts");
        if (target?.kind === "role" && (target.role === "status" || target.role === "alert"))
          return this.gap(line, "the message is a toast, and Maestro can't see toasts");
        const match = op.type === "value" ? "equals" : String(op.match);
        const pattern =
          match === "matches"
            ? value.text
            : match === "contains"
              ? `.*${escapeRegExp(value.text)}.*`
              : escapeRegExp(value.text);
        const id = target ? selectorFor(target) : undefined;
        const byId = id?.ok ? id.fields.filter(([k]) => k === "id" || k === "index") : [];
        return assert("assertVisible", [...byId, ["text", pattern]]);
      }
      case "element_state": {
        const sel = target ? selectorFor(target) : undefined;
        if (!sel?.ok) return this.gap(line, sel?.reason ?? "no element to check");
        switch (op.state) {
          case "visible":
            return assert("assertVisible", sel.fields);
          case "hidden":
            return assert("assertNotVisible", sel.fields);
          case "enabled":
          case "disabled":
            return assert("assertVisible", [...sel.fields, ["enabled", op.state === "enabled"]]);
          case "checked":
          case "unchecked":
            return assert("assertVisible", [...sel.fields, ["checked", op.state === "checked"]]);
          case "focused":
            return assert("assertVisible", [...sel.fields, ["focused", true]]);
          default:
            return this.gap(line, `Maestro can't check that an element is ${op.state}`);
        }
      }
      case "count":
        return this.gap(line, "Maestro can't count elements");
      case "url":
        return this.gap(line, "Maestro can't check which screen (activity) is open");
      case "network":
        return this.gap(line, "Maestro can't see the app's requests");
      case "soft_judgment":
        return this.gap(line, "a model judges it from a screenshot");
      case "pending":
        return this.gap(line, "the check isn't compiled yet");
      default:
        return this.gap(line, `a \`${op.type}\` check has no Maestro assertion`);
    }
  }

  // ── steps, flows, hooks ──

  step(step: ExpandedStep): undefined {
    const line = sourceLine(step);
    this.lines.push("");
    this.comment(line);
    if (this.stopped) return;
    if (step.kind === "guard") return this.gap(line, "`Never:` rules are enforced by the harness");
    if (isCheckStep(step)) return this.check(this.checks.get(step.textKey), step, line);
    if (step.kind === "exact" && step.exact?.form === "code")
      return this.stop(line, "a code block runs in a browser");
    const recorded = this.recorded.get(step.textKey);
    if (!recorded)
      return this.stop(line, `the step is not recorded yet (run ${brand.cliName} author)`);
    for (const cmd of recorded.commands) {
      if (this.stopped) return;
      this.action(cmd, step, line);
    }
  }

  items(items: readonly Item[]): void {
    for (const item of items) {
      if (item.kind === "step") this.step(item.step);
      else this.flow(item);
    }
  }

  flow(call: FlowCall): void {
    this.lines.push("");
    // The path as the test writes it: relative to the including file's folder.
    const from = call.use.file.split("/").slice(0, -1);
    const to = call.flowPath.split("/");
    let shared = 0;
    while (shared < from.length && from[shared] === to[shared]) shared++;
    const written = [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
    this.comment(`${call.use.number === null ? "" : `${call.use.number}. `}Use: ${written}`);
    this.items(call.items);
  }

  /** A request hook as a Maestro script (run on this machine, like the harness does). */
  hook(hook: Hook, phase: "setup" | "teardown", n: number, out: string[], indent: string): boolean {
    if (hook.type !== "request") {
      const what = hook.type === "run" ? `run ${hook.script}` : `sql ${hook.statement}`;
      out.push(
        `${indent}# ${phase}: ${what}. ${only(`\`${hook.type}\` hooks run in ${brand.productName}`)}`,
      );
      this.gaps.push(`${phase}: ${what}: \`${hook.type}\` hooks run in ${brand.productName}`);
      return false;
    }
    this.env.set(BASE_URL, this.source.baseUrl ?? "");
    const url = /^https?:\/\//.test(hook.target)
      ? q(hook.target)
      : `${BASE_URL} + ${q(hook.target)}`;
    const headers: Record<string, string> = { ...(hook.headers ?? {}) };
    if (hook.body !== undefined && typeof hook.body !== "string" && !headers["content-type"])
      headers["Content-Type"] = "application/json";
    // Maestro's http API needs an options object (and a body) for a POST or PUT.
    const sendsBody = hook.method !== "GET" && hook.method !== "HEAD" && hook.method !== "DELETE";
    const body =
      hook.body === undefined
        ? sendsBody
          ? q("")
          : undefined
        : typeof hook.body === "string"
          ? q(hook.body)
          : `JSON.stringify(${JSON.stringify(hook.body)})`;
    const options = [
      Object.keys(headers).length ? `headers: ${JSON.stringify(headers)}` : "",
      body ? `body: ${body}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const method = hook.method.toLowerCase();
    const request = ["get", "post", "put", "delete"].includes(method)
      ? `http.${method}(${url}${options ? `, { ${options} }` : ""})`
      : `http.request(${url}, { method: ${q(hook.method)}${options ? `, ${options}` : ""} })`;
    const name = `${phase}${n}`;
    out.push(`${indent}# ${phase}: ${hook.method} ${hook.target}`);
    out.push(`${indent}- evalScript: ${q(`\${output.${name} = ${request}.status}`)}`);
    out.push(`${indent}- assertTrue: ${q(`\${output.${name} >= 200 && output.${name} < 300}`)}`);
    return true;
  }

  write(): { config: string[]; body: string[] } {
    const test = this.source.expanded;
    const setup: string[] = [];
    let ready = true;
    test.setup.forEach((hook, i) => {
      if (!this.hook(hook, "setup", i + 1, setup, "")) ready = false;
    });
    const teardown: string[] = [];
    test.teardown.forEach((hook, i) => {
      this.hook(hook, "teardown", i + 1, teardown, "  ");
    });
    // Like the harness: a fresh install (no data), and Android's own permission prompts.
    this.lines.push("- launchApp:");
    this.lines.push("    clearState: true");
    this.lines.push("    permissions:");
    this.lines.push("      all: unset");
    if (setup.length) this.lines.unshift(...setup, "");
    if (!ready) {
      this.stopped = "a setup hook runs in the product only";
      this.comment(`${only("a setup hook")} Maestro stops here.`);
    }
    if (test.start && !this.stopped) {
      const url = test.start.display;
      this.lines.push("");
      this.comment(`Start: ${url}`);
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) this.command("openLink", q(url));
      else this.stop(`Start: ${url}`, `"${url}" is not a deep link`);
    }
    this.items(flowTree(test.steps));
    for (const guard of test.guards) {
      this.lines.push("");
      this.comment(`Never: ${guard.text}`);
      this.gap(`Never: ${guard.text}`, "`Never:` rules are enforced by the harness");
    }
    return { config: teardown, body: this.lines };
  }
}

/** The app's package, from the recording's element facts (the fingerprints). */
export function recordedAppId(recording: CodegenRecording): string | null {
  for (const step of recording.steps)
    for (const cmd of step.commands) {
      const pkg = cmd.fingerprint?.attributes.package;
      if (pkg && pkg !== "android" && !/permissioncontroller$/.test(pkg)) return pkg;
    }
  return null;
}

/** A Maestro flow for an Android test's recording. `null` when the app's package isn't recorded. */
export function generateMaestroFlow(
  recording: CodegenRecording,
  source: MaestroSource,
): MaestroFlow | { error: string } {
  const appId = recordedAppId(recording);
  if (!appId) return { error: "the recording doesn't name the app's package (record it again)" };
  const writer = new FlowWriter(recording, source);
  const { config: teardown, body } = writer.write();
  const test = source.expanded;
  const config: string[] = [`appId: ${appId}`, `name: ${q(test.name)}`];
  if (test.tags.length) config.push("tags:", ...test.tags.map((tag) => `  - ${q(tag)}`));
  if (writer.env.size) {
    config.push("env:");
    for (const [name, value] of [...writer.env].sort(([a], [b]) => a.localeCompare(b)))
      config.push(`  ${name}: ${q(value)}`);
  }
  if (teardown.length) config.push("onFlowComplete:", ...teardown);
  const secrets = [...writer.secrets].sort();
  const intro = [
    `# Run: maestro test ${maestroFileName(recording.testId)}${secrets.map((s) => ` -e ${s}=…`).join("")}`,
    ...(secrets.length
      ? [
          `# Secrets are read from Maestro env vars (${secrets.join(", ")}); no value is in this file.`,
        ]
      : []),
    "# The app must be installed first (adb install <apk>).",
  ];
  const header: Header = {
    from: test.path,
    recording: recordingFileName(recording.testId),
    recordingKey: recordingKey(recording),
    comment: "#",
  };
  const text = [...intro, ...config, "---", ...body].join("\n").replace(/\n{3,}/g, "\n\n");
  return {
    name: maestroFileName(recording.testId),
    content: withHeader(`${text}\n`, header),
    appId,
    secrets,
    gaps: writer.gaps,
  };
}
