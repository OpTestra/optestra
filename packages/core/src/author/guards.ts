import words from "./destructive-words.json" with { type: "json" };

// Guards are checked before every action (AUT-2, SAF-4). Rule-based for now;
// DEC-2 improves it. Two sources:
// - the test's `Never:` lines, matched on the quoted text (or the description)
//   against the target's role, accessible name and text;
// - in production environments, destructive intents (delete, pay, send, invite,
//   cancel) found in the target's name/text, unless the test allows them.

export type DestructiveIntent = "delete" | "pay" | "send" | "invite" | "cancel";

export const DESTRUCTIVE_WORDS: Readonly<Record<DestructiveIntent, readonly string[]>> = {
  delete: words.delete,
  pay: words.pay,
  send: words.send,
  invite: words.invite,
  cancel: words.cancel,
};

/** What the agent is about to do, described for matching. */
export interface ProposedAction {
  /** Harness action type: click, fill, goto… */
  type: string;
  /** The target element, when there is one. */
  target?: { role: string; name: string; text?: string };
  /** For goto. */
  url?: string;
}

export interface Guard {
  /** The `Never:` line as written. */
  text: string;
  verb: "click" | "fill" | "select" | "visit" | "check" | "upload" | null;
  /** Quoted parts, or the description when nothing is quoted. Normalized. */
  targets: string[];
}

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; kind: "never"; guard: string; message: string }
  | { allowed: false; kind: "destructive"; intent: DestructiveIntent; message: string };

const VERBS: Record<string, Guard["verb"]> = {
  click: "click",
  tap: "click",
  press: "click",
  submit: "click",
  push: "click",
  fill: "fill",
  type: "fill",
  enter: "fill",
  select: "select",
  choose: "select",
  pick: "select",
  visit: "visit",
  open: "visit",
  go: "visit",
  navigate: "visit",
  check: "check",
  tick: "check",
  upload: "upload",
};

const FILLER =
  /^(to|on|in|into|the|a|an|button|link|field|page|menu item|option)\s+|\s+(button|link|field|page|menu item|option)$/g;

export const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[“”‘’"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function parseGuard(text: string): Guard {
  const trimmed = text.trim();
  const first = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const verb = VERBS[first] ?? null;
  const quoted = [...trimmed.matchAll(/["“”']([^"“”']+)["“”']/g)].map((m) =>
    normalize(m[1] as string),
  );
  let targets = quoted;
  if (targets.length === 0) {
    let description = normalize(verb ? trimmed.slice(first.length) : trimmed);
    for (let i = 0; i < 3; i++) description = description.replace(FILLER, "").trim();
    targets = description ? [description] : [];
  }
  return { text: trimmed, verb, targets };
}

const containsPhrase = (haystack: string, phrase: string): boolean =>
  phrase !== "" &&
  new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(
    haystack,
  );

function verbMatches(verb: Guard["verb"], type: string): boolean {
  switch (verb) {
    case null:
      return true;
    case "click":
      return type === "click" || type === "dblclick" || type === "press";
    case "fill":
      return type === "fill";
    case "select":
      return type === "select";
    case "visit":
      return type === "goto" || type === "click";
    case "check":
      return type === "check" || type === "uncheck";
    case "upload":
      return type === "upload";
  }
}

function matchesGuard(guard: Guard, action: ProposedAction): boolean {
  if (!verbMatches(guard.verb, action.type)) return false;
  const texts: string[] = [];
  if (action.target) {
    texts.push(normalize(action.target.name));
    if (action.target.text) texts.push(normalize(action.target.text));
  }
  if (action.url) texts.push(normalize(action.url));
  return guard.targets.some((target) =>
    texts.some((text) => text === target || containsPhrase(text, target)),
  );
}

/** Destructive intent of an action in production mode, from its target's name and text. */
export function destructiveIntent(action: ProposedAction): DestructiveIntent | undefined {
  if (!action.target || !["click", "dblclick", "press"].includes(action.type)) return undefined;
  const text = normalize(`${action.target.name} ${action.target.text ?? ""}`);
  for (const [intent, list] of Object.entries(DESTRUCTIVE_WORDS) as [
    DestructiveIntent,
    readonly string[],
  ][]) {
    if (list.some((word) => containsPhrase(text, normalize(word)))) return intent;
  }
  return undefined;
}

export interface GuardContext {
  guards: readonly Guard[];
  production: boolean;
  allowDestructive: readonly string[];
}

/** Decides before acting. A refusal carries a message for the model and the report. */
export function checkGuards(action: ProposedAction, context: GuardContext): GuardDecision {
  for (const guard of context.guards) {
    if (matchesGuard(guard, action)) {
      return {
        allowed: false,
        kind: "never",
        guard: guard.text,
        message: `Refused: the test says "Never: ${guard.text}". Do something else, or call step_impossible.`,
      };
    }
  }
  if (context.production) {
    const intent = destructiveIntent(action);
    if (intent && !context.allowDestructive.includes(intent)) {
      return {
        allowed: false,
        kind: "destructive",
        intent,
        message: `Refused: this looks like a destructive action (${intent}) and this is a production environment. The test must list "${intent}" in allowDestructive to allow it.`,
      };
    }
  }
  return { allowed: true };
}
