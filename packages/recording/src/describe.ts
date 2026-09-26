import type { CheckOp, Locator } from "./schema.js";

// Plain-English summaries of checks (EVD-3): generated from the op alone, never
// from a model, so "what was checked" is always exactly what ran. Browser-safe;
// the apps show these next to every result.

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

/** Selectors the check compiler writes, in words. Anything else is shown as-is. */
const KNOWN_SELECTORS: Record<string, { one: string; many: string }> = {
  body: { one: "the visible text of the page", many: "the page" },
  "tbody tr:visible": { one: "data row", many: "visible data rows" },
  "tbody tr": { one: "data row", many: "data rows" },
};

const ROLE_WORDS: Record<string, string> = {
  status: "status message",
  alert: "alert",
  alertdialog: "alert dialog",
  img: "image",
  textbox: "text field",
  combobox: "drop-down",
  listitem: "list item",
  columnheader: "column header",
  rowheader: "row header",
};

const quote = (text: string) => `'${text}'`;
const article = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

function ordinal(nth: number): string {
  return ORDINALS[nth] ?? `number ${nth + 1}`;
}

/** "the main heading", "the button 'Save'", "the field labelled 'Email'"… */
export function describeLocator(locator: Locator, options: { plural?: boolean } = {}): string {
  let base: string;
  let definite = false;
  switch (locator.kind) {
    case "role": {
      const word = ROLE_WORDS[locator.role] ?? locator.role;
      if (locator.role === "heading" && locator.level === 1 && locator.name === undefined) {
        base = "main heading";
        definite = true;
      } else if (locator.role === "heading" && locator.level !== undefined) {
        base = `level-${locator.level} heading${locator.name !== undefined ? ` ${quote(locator.name)}` : ""}`;
        definite = locator.name !== undefined;
      } else if (locator.name !== undefined) {
        base = `${word} ${quote(locator.name)}`;
        definite = true;
      } else {
        base = options.plural ? `${word}s` : word;
      }
      break;
    }
    case "label":
      base = `field labelled ${quote(locator.text)}`;
      definite = true;
      break;
    case "placeholder":
      base = `field with placeholder ${quote(locator.text)}`;
      definite = true;
      break;
    case "alt":
      base = `image with alt text ${quote(locator.text)}`;
      definite = true;
      break;
    case "title":
      base = `element titled ${quote(locator.text)}`;
      definite = true;
      break;
    case "testId":
      base = `element with test id ${quote(locator.value)}`;
      definite = true;
      break;
    case "text":
      base = `text ${quote(locator.text)}`;
      definite = true;
      break;
    case "css": {
      const known = KNOWN_SELECTORS[locator.selector];
      if (known && locator.selector === "body") return known.one;
      base = known
        ? options.plural
          ? known.many
          : known.one
        : `element${options.plural ? "s" : ""} matching \`${locator.selector}\``;
      break;
    }
  }
  let phrase: string;
  if (locator.nth !== undefined) phrase = `the ${ordinal(locator.nth)} ${base}`;
  else if (definite || options.plural) phrase = options.plural ? base : `the ${base}`;
  else phrase = article(base);
  if (locator.frame?.length) {
    const frame = locator.frame[locator.frame.length - 1];
    phrase += ` inside the frame ${frame ? describeLocator(frame as Locator).replace(/^(the|an?) /, "") : ""}`;
  }
  return phrase;
}

function within(scope: Locator | undefined): string {
  if (!scope) return "";
  const where = describeLocator(scope).replace(/^an? /, "the ");
  return ` in ${where}`;
}

function countPhrase(op: Extract<CheckOp, { type: "count" }>): string {
  if (op.n !== undefined) return `exactly ${op.n}`;
  if (op.min !== undefined && op.max !== undefined) return `between ${op.min} and ${op.max}`;
  if (op.min !== undefined) return `at least ${op.min}`;
  if (op.max !== undefined) return `at most ${op.max}`;
  return "any number of";
}

const STATE_WORDS: Record<string, string> = {
  visible: "visible",
  hidden: "not visible",
  enabled: "enabled",
  disabled: "disabled",
  checked: "checked",
  unchecked: "not checked",
  focused: "focused",
  editable: "editable",
  empty: "empty",
};

/** One plain sentence saying what a check verifies, e.g. "Checked that the main heading is exactly 'Welcome to Pro'". */
export function describeCheck(op: CheckOp): string {
  switch (op.type) {
    case "text": {
      const subject = `${describeLocator(op.target)}${within(op.scope)}`;
      if (op.target.kind === "css" && op.target.selector === "body") {
        if (op.match === "contains") return `Checked that the page shows ${quote(op.value)}`;
        if (op.match === "equals")
          return `Checked that the page's visible text is exactly ${quote(op.value)}`;
      }
      if (op.match === "equals") return `Checked that ${subject} is exactly ${quote(op.value)}`;
      if (op.match === "contains") return `Checked that ${subject} contains ${quote(op.value)}`;
      return `Checked that the text of ${subject} matches the pattern /${op.value}/`;
    }
    case "url":
      if (op.match === "is") return `Checked that the URL is ${quote(op.value)}`;
      if (op.match === "contains") return `Checked that the URL contains ${quote(op.value)}`;
      return `Checked that the URL matches the pattern /${op.value}/`;
    case "element_state":
      return `Checked that ${describeLocator(op.target)}${within(op.scope)} is ${STATE_WORDS[op.state] ?? op.state}`;
    case "count":
      return `Checked that there are ${countPhrase(op)} ${describeLocator({ ...op.target, nth: undefined } as Locator, { plural: true })}${within(op.scope)}`;
    case "value": {
      const subject = `${describeLocator(op.target)}${within(op.scope)}`;
      return op.match === "equals"
        ? `Checked that ${subject} has the value ${quote(op.value)}`
        : `Checked that ${subject} contains ${quote(op.value)}`;
    }
    case "network":
      return `Checked that a ${op.method.toUpperCase()} request to ${op.url} was sent${op.status !== undefined ? ` and answered ${op.status}` : ""}`;
    case "aria_snapshot":
      return `Checked that the accessibility tree of ${describeLocator(op.target)}${within(op.scope)} matches the saved snapshot`;
    case "code":
      return "Ran the test's own Playwright check code";
    case "soft_judgment":
      return `Asked an AI model to judge ${op.screenshot === "element" && op.target ? `a screenshot of ${describeLocator(op.target)}` : "a screenshot of the page"}: ${quote(op.question)} (soft check: it can only warn)`;
    case "pending":
      return "Not checked: this expectation has no compiled check yet";
  }
}
