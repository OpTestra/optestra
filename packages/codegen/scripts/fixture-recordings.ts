// Writes the hand-written recordings in fixtures/shop/tests/<data dir>/ that the
// golden specs and the plain-Playwright runs are generated from. They stand in
// for real LOOP-1 recordings (which will replace them): the commands are what
// the author records for the shop, the checks what LOOP-2 compiles.
//
//   node scripts/fixture-recordings.ts
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import {
  type CheckOp,
  type Command,
  checkKey,
  type Locator,
  RECORDING_EPOCH,
  RECORDING_VERSION,
  type RecordedAction,
  type Recording,
  routeOf,
  stepKey,
} from "@optestra/recording";
import { recordingPath } from "@optestra/recording/node";
import { loadTest } from "@optestra/spec/node";

const here = fileURLToPath(new URL("..", import.meta.url));
const SHOP = join(here, "../../bench/fixtures/shop");
const FIXTURE = join(here, "fixtures/shop");
const AT = "2026-09-26T12:00:00.000Z";

// ── building blocks ──────────────────────────────────────────────────────────

const role = (r: string, name?: string, extra: Partial<Locator> = {}): Locator =>
  ({
    kind: "role",
    role: r,
    ...(name === undefined ? {} : { name, exact: true }),
    ...extra,
  }) as Locator;
const label = (text: string): Locator => ({ kind: "label", text, exact: true });
const text = (value: string, exact = true): Locator => ({ kind: "text", text: value, exact });
const css = (selector: string): Locator => ({ kind: "css", selector });
const card = [{ kind: "title" as const, text: "Secure card payment", exact: true }];
const inCard = (locator: Locator): Locator => ({ ...locator, frame: card }) as Locator;

interface Post {
  url?: string;
  appeared?: Array<{ role: string; name: string }>;
  requests?: Array<{ method: string; route: string; status?: number }>;
}

/** One recorded command; `fallbacks` are the other unique candidates the harness found. */
function cmd(action: RecordedAction, post: Post = {}, fallbacks: Locator[] = []): Command {
  const target = "target" in action ? action.target : undefined;
  return {
    action,
    fingerprint: target
      ? {
          primary: target,
          fallbacks,
          role: target.kind === "role" ? target.role : "",
          name: target.kind === "role" ? (target.name ?? "") : "text" in target ? target.text : "",
          tag: "",
          attributes: {},
          anchorText: "",
          framePath: target.frame ?? [],
          box: null,
        }
      : null,
    expectPost: {
      ...(post.url ? { urlChange: post.url } : {}),
      ...(post.appeared ? { appeared: post.appeared } : {}),
      ...(post.requests ? { requests: post.requests } : {}),
    },
    wait: { settledMs: 320, waitedFor: { network: 120, dom: 300, busy: 0 } },
  };
}

type Plan = Array<{ match: RegExp; commands?: Command[]; check?: CheckOp }>;

const heading = css("h1");
const nav = (name: string, url: string) =>
  cmd(
    { type: "click", target: role("link", name) },
    { url, appeared: [{ role: "heading", name }] },
    [text(name), css(`nav a[href="${url}"]`)],
  );

const login: Plan = [
  { match: /^Go to \/login$/, commands: [cmd({ type: "goto", url: "/login" })] },
  {
    match: /^Fill "Email"/,
    commands: [
      cmd({ type: "fill", target: role("textbox", "Email"), value: "{{params.email}}" }, {}, [
        label("Email"),
        css("#login-email"),
      ]),
    ],
  },
  {
    match: /^Fill "Password"/,
    commands: [
      cmd({ type: "fill", target: label("Password"), value: "{{params.password}}" }, {}, [
        css("#login-password"),
      ]),
    ],
  },
  {
    match: /^Click "Log in"$/,
    commands: [
      cmd(
        { type: "click", target: role("button", "Log in") },
        { url: "/dashboard", appeared: [{ role: "heading", name: "Dashboard" }] },
        [text("Log in"), css("#login-form > button")],
      ),
    ],
  },
  {
    match: /^the page heading is "Dashboard"$/,
    check: { type: "text", target: heading, match: "equals", value: "Dashboard" },
  },
];

const saved = (message: string): Plan[number] => ({
  match: new RegExp(`^a message says "${message}"$`),
  check: { type: "element_state", target: text(message), state: "visible" },
});

const plans: Record<string, Plan> = {
  "tests/create-project.test.md": [
    ...login,
    {
      match: /^Click "Create project"$/,
      commands: [
        cmd(
          { type: "click", target: role("button", "Create project") },
          { appeared: [{ role: "dialog", name: "New project" }] },
          [text("Create project"), css("#create-project")],
        ),
      ],
    },
    {
      match: /^a dialog titled "New project" is open$/,
      check: { type: "element_state", target: role("dialog", "New project"), state: "visible" },
    },
    {
      match: /^Fill "Project name"/,
      commands: [
        cmd({ type: "fill", target: label("Project name"), value: "Q3 roadmap" }, {}, [
          role("textbox", "Project name"),
          css("#project-name"),
        ]),
      ],
    },
    {
      match: /^Click "Create"$/,
      commands: [
        cmd(
          { type: "click", target: role("button", "Create") },
          {
            appeared: [{ role: "status", name: "Project created" }],
            requests: [{ method: "POST", route: "/api/projects", status: 201 }],
          },
          [text("Create")],
        ),
      ],
    },
    saved("Project created"),
    {
      match: /^the projects list shows "Q3 roadmap"$/,
      check: {
        type: "element_state",
        target: text("Q3 roadmap"),
        state: "visible",
        scope: role("list", "Projects"),
      },
    },
    { match: /^Reload the page$/, commands: [cmd({ type: "reload" })] },
  ],

  "tests/checkout-trial.test.md": [
    {
      match: /^Click "Start free trial" on the Pro plan$/,
      commands: [
        cmd(
          { type: "click", target: role("button", "Start free trial", { nth: 1 }) },
          { url: "/signup", appeared: [{ role: "heading", name: "Create your account" }] },
          [css('[data-testid="plan-pro"] button')],
        ),
      ],
    },
    {
      match: /^Sign up with/,
      commands: [
        cmd({ type: "fill", target: label("Email"), value: "{{data.email}}" }, {}, [
          css("#signup-email"),
        ]),
        cmd({ type: "fill", target: label("Password"), value: "{{secret.SHOP_PASSWORD}}" }, {}, [
          css("#signup-password"),
        ]),
        cmd(
          { type: "click", target: role("button", "Sign up") },
          { url: "/verify", appeared: [{ role: "heading", name: "Check your email" }] },
          [text("Sign up")],
        ),
      ],
    },
    {
      match: /^the page heading is "Check your email"$/,
      check: { type: "text", target: heading, match: "equals", value: "Check your email" },
    },
    {
      match: /^Enter the code/,
      commands: [
        cmd({ type: "fill", target: label("Verification code"), value: "{{inbox.code}}" }, {}, [
          css("#verify-code"),
        ]),
        cmd(
          { type: "click", target: role("button", "Verify") },
          { url: "/checkout", appeared: [{ role: "heading", name: "Start your Pro trial" }] },
          [text("Verify")],
        ),
      ],
    },
    {
      match: /^Fill the card form/,
      commands: [
        cmd({
          type: "fill",
          target: inCard(role("textbox", "Card number")),
          value: "4242 4242 4242 4242",
        }),
        cmd({ type: "fill", target: inCard(role("textbox", "Expiry date")), value: "12/34" }),
        cmd({ type: "fill", target: inCard(role("textbox", "CVC")), value: "123" }),
      ],
    },
    {
      match: /^Click "Start trial"$/,
      commands: [
        cmd(
          { type: "click", target: role("button", "Start trial") },
          { url: "/dashboard", appeared: [{ role: "heading", name: "Welcome to Pro" }] },
          [text("Start trial")],
        ),
      ],
    },
    {
      match: /^the page heading is "Welcome to Pro"$/,
      check: { type: "text", target: heading, match: "equals", value: "Welcome to Pro" },
    },
    {
      match: /^the URL contains \/dashboard$/,
      check: { type: "url", match: "contains", value: "/dashboard" },
    },
    { match: /^Go to the billing page$/, commands: [nav("Billing", "/billing")] },
    {
      match: /^the page shows "\$0\.00 due today"$/,
      check: { type: "element_state", target: text("$0.00 due today"), state: "visible" },
    },
  ],

  "tests/settings-profile.test.md": [
    ...login,
    { match: /^Go to the settings page$/, commands: [nav("Settings", "/settings")] },
    {
      match: /^Fill "Full name"/,
      commands: [
        cmd({ type: "fill", target: label("Full name"), value: "Ada King" }, {}, [
          css("#profile-name"),
        ]),
      ],
    },
    {
      match: /^Select "Europe\/London"/,
      commands: [
        cmd({ type: "select", target: label("Time zone"), option: "Europe/London" }, {}, [
          role("combobox", "Time zone"),
          css("#profile-timezone"),
        ]),
      ],
    },
    {
      match: /^Click "Save changes"$/,
      commands: [
        cmd(
          { type: "click", target: role("button", "Save changes") },
          { appeared: [{ role: "status", name: "Profile saved" }] },
          [text("Save changes")],
        ),
      ],
    },
    saved("Profile saved"),
    { match: /^Reload the page$/, commands: [cmd({ type: "reload" })] },
    {
      match: /^"Full name" contains "Ada King"$/,
      check: { type: "text", target: label("Full name"), match: "contains", value: "Ada King" },
    },
    {
      match: /^"Time zone" is "Europe\/London"$/,
      check: { type: "text", target: label("Time zone"), match: "equals", value: "Europe/London" },
    },
  ],

  "tests/sort-orders.test.md": [
    ...login,
    { match: /^Go to the orders page$/, commands: [nav("Orders", "/orders")] },
    {
      match: /^the orders table shows 5 orders$/,
      check: {
        type: "count",
        target: role("rowheader"),
        n: 5,
        scope: role("table", "Your orders"),
      },
    },
    {
      match: /^Click the "Total" column header( again)?$/,
      commands: [
        cmd({ type: "click", target: role("button", "Total") }, {}, [
          text("Total"),
          css("th:nth-of-type(4) > button"),
        ]),
      ],
    },
    {
      match: /^the first order in the table is A-1002/,
      check: {
        type: "text",
        target: role("rowheader", undefined, { nth: 0 }),
        match: "equals",
        value: "A-1002",
        scope: role("table", "Your orders"),
      },
    },
    {
      match: /^the first order in the table is A-1004/,
      check: {
        type: "text",
        target: role("rowheader", undefined, { nth: 0 }),
        match: "equals",
        value: "A-1004",
        scope: role("table", "Your orders"),
      },
    },
    {
      match: /^Click "Show refunded orders"$/,
      commands: [
        cmd({ type: "click", target: text("Show refunded orders") }, {}, [css("div.fake-link")]),
      ],
    },
    {
      match: /^the orders table shows 6 orders$/,
      check: {
        type: "count",
        target: role("rowheader"),
        n: 6,
        scope: role("table", "Your orders"),
      },
    },
  ],

  "tests/delete-account-guard.test.md": [
    ...login,
    { match: /^Go to the settings page$/, commands: [nav("Settings", "/settings")] },
    {
      match: /^a "Delete account" button is shown$/,
      check: { type: "element_state", target: role("button", "Delete account"), state: "visible" },
    },
    {
      match: /^Select "Asia\/Tokyo"/,
      commands: [
        cmd({ type: "select", target: label("Time zone"), option: "Asia/Tokyo" }, {}, [
          role("combobox", "Time zone"),
          css("#profile-timezone"),
        ]),
      ],
    },
    {
      match: /^Click "Save changes"$/,
      commands: [
        cmd(
          { type: "click", target: role("button", "Save changes") },
          { appeared: [{ role: "status", name: "Profile saved" }] },
          [text("Save changes")],
        ),
      ],
    },
    saved("Profile saved"),
  ],

  "tests/billing-zero-due.test.md": [
    ...login,
    { match: /^Go to the billing page$/, commands: [nav("Billing", "/billing")] },
    {
      match: /^the page shows "Pro plan"$/,
      check: { type: "element_state", target: text("Pro plan", false), state: "visible" },
    },
    {
      match: /^the page shows "\$0\.00 due today"$/,
      check: { type: "element_state", target: text("$0.00 due today"), state: "visible" },
    },
  ],

  "tests/avatar-upload.test.md": [
    ...login,
    { match: /^Go to the settings page$/, commands: [nav("Settings", "/settings")] },
    {
      match: /^Upload files\/avatar\.png/,
      commands: [
        cmd({ type: "upload", target: label("Choose an image"), files: ["files/avatar.png"] }, {}, [
          css("#avatar-file"),
        ]),
      ],
    },
    {
      match: /^Click "Upload avatar"$/,
      commands: [
        cmd(
          { type: "click", target: role("button", "Upload avatar") },
          { appeared: [{ role: "status", name: "Avatar updated" }] },
          [text("Upload avatar")],
        ),
      ],
    },
    saved("Avatar updated"),
    {
      match: /^the image "Your avatar" is visible$/,
      check: { type: "element_state", target: role("img", "Your avatar"), state: "visible" },
    },
  ],

  "tests/allowed-hosts.test.md": [
    {
      match: /^Click "Sign up" in the menu$/,
      commands: [
        cmd(
          { type: "click", target: role("link", "Sign up") },
          { url: "/signup", appeared: [{ role: "heading", name: "Create your account" }] },
          [text("Sign up")],
        ),
      ],
    },
    {
      match: /^Fill "Email"/,
      commands: [
        cmd({ type: "fill", target: label("Email"), value: "{{data.email}}" }, {}, [
          css("#signup-email"),
        ]),
      ],
    },
    {
      match: /^the sign-up page was requested/,
      check: { type: "network", method: "GET", url: "/signup", status: 200 },
    },
    {
      match: /^the sign-up form looks tidy$/,
      // A model-judged check (LOOP-2): the spec can't run it, only note it.
      check: {
        type: "soft_judgment",
        question: "Does the sign-up form look tidy?",
        screenshot: "page",
      } as never,
    },
    {
      match: /^"Email" contains/,
      check: { type: "text", target: label("Email"), match: "contains", value: "{{data.email}}" },
    },
  ],
};

// ── assembling ───────────────────────────────────────────────────────────────

const project = mkdtempSync(join(tmpdir(), "codegen-fixtures-"));
try {
  cpSync(join(SHOP, "tests"), join(project, "tests"), {
    recursive: true,
    filter: (source) => !source.includes(brand.dataDirName),
  });
  for (const name of readdirSync(join(FIXTURE, "tests"))) {
    if (name.endsWith(".test.md"))
      cpSync(join(FIXTURE, "tests", name), join(project, "tests", name));
  }
  for (const [path, plan] of Object.entries(plans)) {
    const loaded = await loadTest(project, path, undefined, { seed: "fixtures" });
    if (!loaded) throw new Error(`no ${path}`);
    const test = loaded.expanded;
    let route = routeOf(test.start?.display ?? "about:blank");
    const recording: Recording = {
      recordingVersion: RECORDING_VERSION,
      testId: test.id,
      testPath: path,
      target: "web",
      recordedWith: {
        engineVersion: "0.1.0",
        epoch: RECORDING_EPOCH,
        browser: "chromium",
        device: "laptop",
        environment: "local",
        model: "fixture/hand-written",
        promptVersion: "planner-v1",
      },
      updatedAt: AT,
      steps: [],
      checks: [],
    };
    for (const step of test.steps) {
      const entry = plan.find((item) => item.match.test(step.text));
      if (step.kind === "expect" || step.kind === "soft") {
        if (!entry?.check) throw new Error(`${path}: no check for "${step.text}"`);
        recording.checks.push({
          key: checkKey(step.textKey),
          textKey: step.textKey,
          text: step.text,
          soft: step.kind === "soft",
          check: entry.check,
          generatedBy: "ai",
          recordedAt: AT,
        });
        continue;
      }
      if (step.kind === "exact" && step.exact?.form === "code") continue;
      if (!entry?.commands) throw new Error(`${path}: no commands for "${step.text}"`);
      recording.steps.push({
        key: stepKey(step.textKey, route),
        textKey: step.textKey,
        route,
        text: step.text,
        kind: "action",
        commands: entry.commands,
        source: "ai",
        recordedAt: AT,
      });
      for (const command of entry.commands) {
        if (command.action.type === "goto") route = routeOf(command.action.url);
        if (command.expectPost.urlChange) route = command.expectPost.urlChange;
      }
    }
    // Written as the recording package writes files (2-space JSON, schema key
    // order), without its validation: one fixture uses LOOP-2's soft_judgment op,
    // which the recording schema on this branch doesn't know yet.
    writeFileSync(
      recordingPath(join(FIXTURE, "tests"), test.id),
      `${JSON.stringify(recording, null, 2)}\n`,
    );
    console.log(
      `wrote ${test.id} (${recording.steps.length} steps, ${recording.checks.length} checks)`,
    );
  }
} finally {
  rmSync(project, { recursive: true, force: true });
}
