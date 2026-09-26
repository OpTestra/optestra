/** Hover and completion text for frontmatter fields, exact ops and namespaces. */

export const FIELD_DOCS: Record<string, string> = {
  name: "**name** (required): what this test checks, in plain words. Shown in results and reports.",
  kind: "**kind**: `test` (default) or `flow`. Flows are reusable steps included with `Use:`; they are not run on their own in a suite.",
  params:
    "**params** (flows only): name → default value. Leave a value empty to make it required. Callers pass params with `Use: path { name: value }`.",
  tags: "**tags**: a list like `[smoke, payments]`, for filtering runs.",
  start:
    "**start**: where the test begins: a path (`/pricing`), an absolute URL, or for Android a screen or deep link.",
  auth: "**auth**: the auth profile to start logged in with, or `none`.",
  data: '**data**: values for `{{data.name}}`. They may use other data, `{{env.X}}`, `{{secret.X}}`, `{{unique.email}}` and `{{faker.name}}`, e.g. `email: "{{unique.email}}"`.',
  setup:
    "**setup**: hooks run before the test, outside the UI: `request: POST /api/seed` (with `body`, `headers`), `run: scripts/seed.sh` or `sql: …`.",
  teardown: "**teardown**: hooks run after the test: `request:`, `run:` or `sql:`.",
  timeout: '**timeout**: the longest the test may take, like `"90s"`, `"3m"` or `"1h"`.',
  heal: "**heal**: fix policy. `strict`: never heal, fail on a miss. `review` (default): heal, mark Healed, ask for approval. `auto`: heal and accept (only for low-risk tests).",
  allowDestructive:
    "**allowDestructive**: destructive actions this test may do in production environments: `delete`, `pay`, `send`, `invite`, `cancel`. Undeclared ones are Blocked there.",
  dataset: "**dataset**: a CSV or JSON file; the test runs once per row.",
  environments:
    "**environments**: per-environment overrides of `start`, `data` and `timeout`, e.g. `staging: { timeout: 5m }`.",
};

export const OP_DOCS: Record<string, string> = {
  goto: "**goto** `<url>`: open a path or URL. `Exact: goto /settings`",
  click: '**click** `<locator>`: click an element. `Exact: click role=button[name="Save"]`',
  fill: '**fill** `<locator>` **with** `<value>`: type into a field. `Exact: fill label="Email" with {{data.email}}`',
  select:
    '**select** `<option>` **in** `<locator>`: choose an option. `Exact: select "Europe/London" in label="Time zone"`',
  press: "**press** `<key>`: press a key. `Exact: press Enter`, `Exact: press Control+A`",
  expect:
    '**expect**: a pinned check. `expect url contains|is <value>`, `expect <locator> text|contains "<value>"`, `expect <locator> visible|hidden|enabled|disabled`, `expect <locator> count <n>`.',
};

export const LOCATORS: [string, string][] = [
  ["role=", 'By ARIA role and name, e.g. role=button[name="Save"]'],
  ['label="', 'By the field\'s label, e.g. label="Email"'],
  ["testid=", "By data-testid, e.g. testid=save"],
  ['text="', 'By visible text, e.g. text="Save"'],
  ['placeholder="', 'By placeholder, e.g. placeholder="Search"'],
  ["css=", "By CSS selector, e.g. css=.order-row"],
];

export const ROLES = [
  "button",
  "link",
  "heading",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "dialog",
  "tab",
  "menuitem",
  "listitem",
  "row",
  "cell",
  "img",
  "alert",
];

export const KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Space",
  "ArrowDown",
  "ArrowUp",
  "Control+A",
];

export const NAMESPACE_DOCS: Record<string, string> = {
  data: "Values from this file's data: frontmatter.",
  env: "The selected environment's vars from the project settings.",
  secret: "A secret by NAME. Typed in by the driver; never shown to the AI or in logs.",
  params: "This flow's params.",
  unique: "A fresh value for every run (unique.email, unique.id, unique.name).",
  faker: "A realistic made-up value (faker.name, faker.email, …).",
};

export const PREFIX_DOCS: [string, string][] = [
  ["Expect: ", 'A check that must be true, e.g. Expect: the heading is "Welcome"'],
  ["Soft: ", "A check that only warns, for things that can't be pinned down"],
  ["Never: ", "Something the agent must never do, for the whole test"],
  ["Use: ", "Include a flow, e.g. Use: flows/login.test.md"],
  ["Exact: ", 'A step in the fixed syntax, e.g. Exact: click role=button[name="Save"]'],
];
