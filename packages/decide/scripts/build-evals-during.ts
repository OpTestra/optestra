// Builds packages/decide/evals/same_element.jsonl and miss_action.jsonl (DEC-3).
//   node packages/decide/scripts/build-evals-during.ts
// same_element: the FND-4 shop's elements as recorded on the `correct` build and
// seen live on the `cosmetic` build (bench/fixtures/shop/src/variants.ts: renamed
// classes, ids and test ids, moved buttons, reworded labels), plus hard negatives
// (neighbouring buttons, look-alikes in another section or dialog, opposite
// actions, a field in another frame). Labels are the truth about identity, not
// what the rules say. miss_action: the healing ladder (HEAL-1) over realistic
// replay situations.

import { writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
type Json = Record<string, unknown>;
interface Case {
  id: string;
  source: "shop-manifest" | "hand-written";
  note: string;
  input: Json;
  expected: string | boolean;
}

// ── same_element ─────────────────────────────────────────────────────────────

interface El {
  role: string;
  name: string;
  tag: string;
  attributes?: Record<string, string>;
  text?: string;
  anchorText: string;
  framePath?: Json[];
  box: [number, number, number, number] | null;
}
const el = (e: El) => ({
  role: e.role,
  name: e.name,
  tag: e.tag,
  attributes: e.attributes ?? {},
  text: e.text ?? "",
  anchorText: e.anchorText,
  framePath: e.framePath ?? [],
  box: e.box ? { x: e.box[0], y: e.box[1], width: e.box[2], height: e.box[3] } : null,
});
const PAY_FRAME = [{ kind: "css", selector: "iframe[title='Card details']" }];

/** Each element as recorded on `correct` and as it looks on `cosmetic`. */
const shop: Record<string, { correct: El; cosmetic: El; note: string }> = {};
const pair = (key: string, note: string, correct: El, cosmetic: El) => {
  shop[key] = { note, correct, cosmetic };
};
const button = (
  name: string,
  anchor: string,
  box: El["box"],
  cls: string,
  extra: Record<string, string> = {},
): El => ({
  role: "button",
  name,
  tag: "button",
  text: name,
  anchorText: anchor,
  box,
  attributes: { type: "submit", class: cls, ...extra },
});
const field = (
  name: string,
  anchor: string,
  box: El["box"],
  attrs: Record<string, string>,
): El => ({
  role: "textbox",
  name,
  tag: "input",
  anchorText: anchor,
  box,
  attributes: attrs,
});
const link = (name: string, href: string, anchor: string, box: El["box"]): El => ({
  role: "link",
  name,
  tag: "a",
  text: name,
  anchorText: anchor,
  box,
  attributes: { href },
});

// Pricing: three plan cards, reordered on cosmetic; the button label reworded.
const planX = { starter: 100, pro: 420, team: 740 };
const planXCosmetic = { team: 100, pro: 420, starter: 740 };
for (const plan of ["starter", "pro", "team"] as const) {
  const title = plan[0]?.toUpperCase() + plan.slice(1);
  pair(
    `plan-${plan}`,
    `Pricing: ${title}'s "Start free trial" → "Start your free trial", cards reordered`,
    button("Start free trial", title, [planX[plan], 520, 220, 44], "btn btn-primary"),
    button(
      "Start your free trial",
      title,
      [planXCosmetic[plan], 540, 240, 48],
      "button button--main",
    ),
  );
}
pair(
  "signup-email",
  "Sign-up email field, id signup-email → register-email",
  field("Email", "Create your account", [480, 260, 320, 40], {
    id: "signup-email",
    name: "email",
    type: "email",
    class: "field",
  }),
  field("Email", "Create your account", [480, 280, 360, 44], {
    id: "register-email",
    name: "email",
    type: "email",
    class: "form-row",
  }),
);
pair(
  "signup-password",
  "Sign-up password field, id renamed",
  field("Password", "Create your account", [480, 330, 320, 40], {
    id: "signup-password",
    name: "password",
    type: "password",
    class: "field",
  }),
  field("Password", "Create your account", [480, 356, 360, 44], {
    id: "register-password",
    name: "password",
    type: "password",
    class: "form-row",
  }),
);
pair(
  "signup-button",
  '"Sign up" → "Create account"',
  button("Sign up", "Create your account", [480, 400, 120, 44], "btn btn-primary"),
  button("Create account", "Create your account", [480, 430, 160, 48], "button button--main"),
);
pair(
  "signup-login-link",
  'The "Log in" link under the sign-up form',
  link("Log in", "/login", "Create your account", [650, 470, 50, 20]),
  link("Log in", "/login", "Create your account", [650, 500, 50, 20]),
);
pair(
  "verify-code",
  "Verification code field, id verify-code → otp",
  field("Verification code", "Check your email", [480, 260, 200, 40], {
    id: "verify-code",
    name: "code",
    class: "field",
  }),
  field("Verification code", "Check your email", [480, 280, 220, 44], {
    id: "otp",
    name: "code",
    class: "form-row",
  }),
);
pair(
  "verify-button",
  '"Verify" button, restyled',
  button("Verify", "Check your email", [480, 320, 100, 44], "btn btn-primary"),
  button("Verify", "Check your email", [480, 344, 110, 48], "button button--main"),
);
pair(
  "login-email",
  "Login email field, id login-email → signin-email",
  field("Email", "Log in", [480, 240, 320, 40], {
    id: "login-email",
    name: "email",
    type: "email",
    class: "field",
  }),
  field("Email", "Log in", [480, 262, 360, 44], {
    id: "signin-email",
    name: "email",
    type: "email",
    class: "form-row",
  }),
);
pair(
  "login-password",
  "Login password field, id renamed",
  field("Password", "Log in", [480, 300, 320, 40], {
    id: "login-password",
    name: "password",
    type: "password",
    class: "field",
  }),
  field("Password", "Log in", [480, 326, 360, 44], {
    id: "signin-password",
    name: "password",
    type: "password",
    class: "form-row",
  }),
);
pair(
  "login-button",
  '"Log in" → "Sign in"',
  button("Log in", "Log in", [480, 360, 100, 44], "btn btn-primary"),
  button("Sign in", "Log in", [480, 390, 110, 48], "button button--main"),
);
pair(
  "login-signup-link",
  'The "Sign up" link under the login form',
  link("Sign up", "/signup", "Log in", [620, 430, 60, 20]),
  link("Sign up", "/signup", "Log in", [620, 462, 60, 20]),
);
pair(
  "create-project",
  '"Create project" → "Add project", id renamed, moved below the list',
  button("Create project", "Projects", [880, 180, 150, 40], "btn btn-primary", {
    id: "create-project",
    type: "button",
  }),
  button("Add project", "Projects", [880, 620, 140, 44], "button button--main", {
    id: "add-project",
    type: "button",
  }),
);
pair(
  "dialog-name",
  "New project dialog: name field, id renamed",
  field("Project name", "New project", [500, 300, 300, 40], {
    id: "project-name",
    name: "name",
    class: "field",
  }),
  field("Project name", "New project", [500, 310, 320, 44], {
    id: "new-project-name",
    name: "name",
    class: "form-row",
  }),
);
pair(
  "dialog-cancel",
  "New project dialog: Cancel",
  button("Cancel", "New project", [500, 380, 90, 40], "btn", { type: "button" }),
  button("Cancel", "New project", [500, 392, 96, 44], "button", { type: "button" }),
);
pair(
  "dialog-create",
  'New project dialog: "Create" → "Save project" (same button, new words)',
  button("Create", "New project", [610, 380, 90, 40], "btn btn-primary"),
  button("Save project", "New project", [616, 392, 130, 44], "button button--main"),
);
for (const [name, href, x] of [
  ["Dashboard", "/dashboard", 300],
  ["Orders", "/orders", 420],
  ["Settings", "/settings", 520],
] as const)
  pair(
    `nav-${name.toLowerCase()}`,
    `Nav link "${name}", nav restyled`,
    link(name, href, "Main", [x, 20, 80, 24]),
    link(name, href, "Main", [x + 110, 18, 84, 26]),
  );
pair(
  "nav-logout",
  '"Log out" moved from the end of the nav to the start',
  button("Log out", "Main", [900, 18, 80, 28], "btn"),
  button("Log out", "Main", [300, 18, 84, 30], "button"),
);
pair(
  "profile-name",
  'Settings: "Full name" → "Your name", id renamed, sections reordered',
  field("Full name", "Profile", [480, 240, 320, 40], {
    id: "profile-name",
    name: "name",
    class: "field",
  }),
  field("Your name", "Profile", [480, 560, 340, 44], {
    id: "user-name",
    name: "name",
    class: "form-row",
  }),
);
pair(
  "profile-save",
  'Settings: "Save changes" → "Save profile"',
  button("Save changes", "Profile", [480, 360, 140, 44], "btn btn-primary"),
  button("Save profile", "Profile", [480, 680, 140, 48], "button button--main"),
);
pair(
  "avatar-upload",
  'Settings: "Upload avatar" → "Upload photo", section moved first',
  button("Upload avatar", "Avatar", [480, 620, 140, 40], "btn"),
  button("Upload photo", "Avatar", [480, 300, 140, 44], "button"),
);
pair(
  "delete-account",
  'Danger zone "Delete account", danger class renamed',
  button("Delete account", "Danger zone", [480, 820, 150, 40], "btn btn-danger", {
    type: "button",
  }),
  button("Delete account", "Danger zone", [480, 840, 160, 44], "button button--warn", {
    type: "button",
  }),
);
pair(
  "orders-refunded",
  'Orders: "Show refunded orders" → "Include refunded orders"',
  button("Show refunded orders", "Orders", [480, 200, 200, 36], "btn", { type: "button" }),
  button("Include refunded orders", "Orders", [480, 210, 220, 40], "button", { type: "button" }),
);
pair(
  "checkout-start",
  'Checkout: "Start trial" → "Start my trial", moved above the card frame',
  button("Start trial", "Start your Pro trial", [480, 620, 140, 44], "btn btn-primary"),
  button("Start my trial", "Start your Pro trial", [480, 380, 150, 48], "button button--main"),
);
for (const [name, y] of [
  ["Card number", 440],
  ["Expiry date", 500],
  ["CVC", 500],
] as const)
  pair(
    `card-${name.toLowerCase().replace(" ", "-")}`,
    `Card field "${name}" inside the payment iframe`,
    {
      ...field(name, "Card details", [490, y, 200, 36], {
        id: name.toLowerCase().replace(" ", "-"),
        class: "pay",
      }),
      framePath: PAY_FRAME,
    },
    {
      ...field(name, "Card details", [490, y - 230, 200, 36], {
        id: name.toLowerCase().replace(" ", "-"),
        class: "pay",
      }),
      framePath: PAY_FRAME,
    },
  );

const same: Case[] = [];
const addSame = (
  id: string,
  source: Case["source"],
  note: string,
  recorded: El,
  candidate: El,
  expected: boolean,
  found: Partial<{ foundBy: string; matches: number }> = {},
) =>
  same.push({
    id,
    source,
    note,
    input: {
      recorded: { ...el(recorded), text: "" },
      candidate: {
        ...el(candidate),
        foundBy: found.foundBy ?? "refind",
        matches: found.matches ?? 1,
      },
    },
    expected,
  });

// Positives: every documented cosmetic change, recorded on correct, found live on cosmetic.
for (const [key, p] of Object.entries(shop))
  addSame(`cosmetic-${key}`, "shop-manifest", p.note, p.correct, p.cosmetic, true);
// Positives: replaying on the unchanged build (found by the stored primary locator).
for (const key of [
  "plan-pro",
  "login-button",
  "create-project",
  "profile-save",
  "card-card-number",
])
  addSame(
    `unchanged-${key}`,
    "shop-manifest",
    `Unchanged build: ${shop[key]?.note}`,
    shop[key]?.correct as El,
    shop[key]?.correct as El,
    true,
    { foundBy: "primary" },
  );

// Hard negatives (expected: not the same element).
const s = (key: string, build: "correct" | "cosmetic" = "correct") => shop[key]?.[build] as El;
addSame(
  "neg-plan-pro-vs-starter",
  "shop-manifest",
  "Neighbouring plan card: Pro's button vs Starter's",
  s("plan-pro"),
  s("plan-starter", "cosmetic"),
  false,
);
addSame(
  "neg-plan-pro-vs-team",
  "shop-manifest",
  "Neighbouring plan card: Pro's vs Team's (same label)",
  s("plan-pro"),
  s("plan-team"),
  false,
);
addSame(
  "neg-plan-starter-vs-team-cosmetic",
  "shop-manifest",
  "Reordered cards: Starter recorded, Team now where Starter was",
  s("plan-starter"),
  s("plan-team", "cosmetic"),
  false,
);
addSame(
  "neg-email-vs-password",
  "hand-written",
  "Email field vs the password field below it",
  s("login-email"),
  s("login-password"),
  false,
);
addSame(
  "neg-email-vs-password-cosmetic",
  "hand-written",
  "Email field vs password field on the cosmetic build",
  s("signup-email"),
  s("signup-password", "cosmetic"),
  false,
);
addSame(
  "neg-login-button-vs-link",
  "hand-written",
  '"Log in" button vs a "Log in" link',
  s("login-button"),
  s("signup-login-link"),
  false,
);
addSame(
  "neg-signup-button-vs-link",
  "hand-written",
  '"Sign up" button vs the "Sign up" link',
  s("signup-button"),
  s("login-signup-link"),
  false,
);
addSame(
  "neg-page-create-vs-dialog-create",
  "hand-written",
  'Page "Create project" vs the dialog\'s "Create"',
  s("create-project"),
  s("dialog-create"),
  false,
);
addSame(
  "neg-dialog-create-vs-page-add",
  "hand-written",
  'Dialog "Create" vs the page\'s "Add project" (cosmetic)',
  s("dialog-create"),
  s("create-project", "cosmetic"),
  false,
);
addSame(
  "neg-dialog-cancel-vs-create",
  "hand-written",
  "Dialog Cancel vs the dialog's confirm button",
  s("dialog-cancel"),
  s("dialog-create"),
  false,
);
addSame(
  "neg-dialog-create-vs-cancel-cosmetic",
  "hand-written",
  'Dialog "Create" vs the dialog\'s Cancel on cosmetic',
  s("dialog-create"),
  s("dialog-cancel", "cosmetic"),
  false,
);
addSame(
  "neg-delete-vs-confirm",
  "hand-written",
  '"Delete account" vs the dialog\'s "Yes, delete my account"',
  s("delete-account"),
  button("Yes, delete my account", "Delete your account?", [560, 420, 200, 40], "btn btn-danger"),
  false,
);
addSame(
  "neg-cancel-create-vs-cancel-delete",
  "hand-written",
  "Cancel in the new-project dialog vs Cancel in the delete dialog",
  s("dialog-cancel"),
  button("Cancel", "Delete your account?", [440, 420, 90, 40], "btn", { type: "button" }),
  false,
);
addSame(
  "neg-save-vs-upload",
  "hand-written",
  '"Save changes" (Profile) vs "Upload avatar" (Avatar)',
  s("profile-save"),
  s("avatar-upload"),
  false,
);
addSame(
  "neg-save-vs-upload-cosmetic",
  "hand-written",
  '"Save changes" vs "Upload photo" on cosmetic',
  s("profile-save"),
  s("avatar-upload", "cosmetic"),
  false,
);
addSame(
  "neg-nav-orders-vs-settings",
  "hand-written",
  'Nav "Orders" vs "Settings"',
  s("nav-orders"),
  s("nav-settings", "cosmetic"),
  false,
);
addSame(
  "neg-nav-dashboard-vs-brand",
  "hand-written",
  'Nav "Dashboard" vs the "Acme Shop" brand link',
  s("nav-dashboard"),
  link("Acme Shop", "/", "Main", [40, 18, 120, 28]),
  false,
);
addSame(
  "neg-card-frame-vs-page",
  "hand-written",
  "Card number in the payment iframe vs a page field with the same label",
  s("card-card-number"),
  field("Card number", "Card details", [490, 440, 200, 36], { id: "card-number", class: "field" }),
  false,
);
addSame(
  "neg-show-vs-hide",
  "hand-written",
  '"Show refunded orders" vs "Hide refunded orders"',
  s("orders-refunded"),
  button("Hide refunded orders", "Orders", [480, 200, 200, 36], "btn", { type: "button" }),
  false,
);
addSame(
  "neg-login-vs-logout",
  "hand-written",
  '"Log in" vs "Log out"',
  button("Log in", "Main", [900, 18, 70, 28], "btn"),
  s("nav-logout"),
  false,
);
addSame(
  "neg-name-vs-timezone",
  "hand-written",
  '"Full name" field vs the "Time zone" select',
  s("profile-name"),
  {
    role: "combobox",
    name: "Time zone",
    tag: "select",
    anchorText: "Profile",
    box: [480, 300, 320, 40],
    attributes: { id: "profile-timezone", name: "timezone" },
  },
  false,
);
addSame(
  "neg-login-email-vs-signup-email",
  "hand-written",
  "The login page's Email field vs the sign-up page's",
  s("login-email"),
  s("signup-email", "cosmetic"),
  false,
);
addSame(
  "neg-sort-date-vs-total",
  "hand-written",
  'Orders table: "Date" sort button vs "Total"',
  button("Date", "Orders", [480, 260, 60, 24], "", { type: "button" }),
  button("Total", "Orders", [700, 260, 60, 24], "", { type: "button" }),
  false,
);
addSame(
  "neg-project-rows",
  "hand-written",
  "Two project rows sharing a test id: 'Launch plan' vs 'Q3 roadmap'",
  {
    role: "listitem",
    name: "Launch plan",
    tag: "li",
    anchorText: "Projects",
    box: [480, 240, 400, 32],
    attributes: { "data-testid": "project-row" },
  },
  {
    role: "listitem",
    name: "Q3 roadmap",
    tag: "li",
    anchorText: "Projects",
    box: [480, 280, 400, 32],
    attributes: { "data-testid": "project-row" },
  },
  false,
  { matches: 2 },
);
addSame(
  "neg-remove-rows-far",
  "hand-written",
  'Two "Remove" buttons in different cart rows (the locator matches both)',
  button("Remove", "Cart", [820, 240, 70, 28], "btn", { type: "button" }),
  button("Remove", "Cart", [820, 420, 70, 28], "btn", { type: "button" }),
  false,
  { foundBy: "fallback", matches: 2 },
);
addSame(
  "neg-testid-row-same-name",
  "hand-written",
  "Same test id and name on a duplicated row, far apart",
  button("Edit", "Team", [800, 240, 50, 28], "btn", { "data-testid": "row-edit" }),
  button("Edit", "Team", [800, 520, 50, 28], "btn", { "data-testid": "row-edit" }),
  false,
  { matches: 3 },
);
addSame(
  "neg-add-vs-remove",
  "hand-written",
  '"Add to cart" vs "Remove from cart"',
  button("Add to cart", "Canvas tote", [600, 400, 140, 40], "btn"),
  button("Remove from cart", "Canvas tote", [600, 400, 160, 40], "btn"),
  false,
);
addSame(
  "neg-link-other-page",
  "hand-written",
  '"Plans" link to /pricing vs "Plans" link to /billing/plans',
  link("Plans", "/pricing", "Main", [600, 20, 60, 24]),
  link("Plan details", "/billing/plans", "Main", [600, 20, 90, 24]),
  false,
);
addSame(
  "neg-verify-vs-resend",
  "hand-written",
  '"Verify" vs "Resend code"',
  s("verify-button"),
  button("Resend code", "Check your email", [600, 320, 120, 40], "btn", { type: "button" }),
  false,
);
addSame(
  "neg-password-vs-confirm",
  "hand-written",
  '"Password" vs "Confirm password"',
  s("signup-password"),
  field("Confirm password", "Create your account", [480, 380, 320, 40], {
    id: "signup-password-2",
    name: "password_confirm",
    type: "password",
    class: "field",
  }),
  false,
);
// Tricky positives.
addSame(
  "pos-ambiguous-but-same-spot",
  "hand-written",
  "Locator matched 2, but the candidate sits exactly where the recorded one was",
  s("dialog-cancel"),
  { ...s("dialog-cancel"), box: [502, 381, 90, 40] },
  true,
  { foundBy: "fallback", matches: 2 },
);
addSame(
  "pos-testid-kept",
  "hand-written",
  "Everything restyled and reworded, but the test id stayed",
  button("Pay now", "Payment", [480, 600, 120, 44], "btn", { "data-testid": "pay-button" }),
  button("Complete purchase", "Payment", [480, 360, 180, 48], "button--main", {
    "data-testid": "pay-button",
  }),
  true,
);

// ── miss_action ──────────────────────────────────────────────────────────────

const healthy = { isError: false, appDown: false, serverErrors: 0, networkFailures: 0 };
const base = {
  missReason: "not_found",
  refusal: null,
  usedElement: null,
  fallbacks: { total: 2, matched: 0, sameElement: null },
  ranking: { outcome: "none", bestScore: 0.1 },
  page: healthy,
  policy: "review",
  budgetLeftUsd: 0.8,
  fixerAvailable: true,
};
const miss: Case[] = [];
const addMiss = (
  id: string,
  note: string,
  patch: Json,
  expected: string,
  source: Case["source"] = "hand-written",
) => miss.push({ id, source, note, input: { ...base, ...patch }, expected });

// Shop scenarios.
addMiss(
  "shop-cosmetic-login-refind",
  "Cosmetic build: 'Log in' is now 'Sign in'; no fallback matched, re-find found it",
  { ranking: { outcome: "match", bestScore: 0.86 } },
  "refind",
  "shop-manifest",
);
addMiss(
  "shop-cosmetic-plan-fallback",
  "Cosmetic build: plan button's fallback (the card's test id) matched the same element",
  { fallbacks: { total: 2, matched: 1, sameElement: "same" } },
  "replay_fallback",
  "shop-manifest",
);
addMiss(
  "shop-cosmetic-dialog-fixer",
  "Cosmetic build: 'Create' → 'Save project'; re-find escalated, fixer available",
  { ranking: { outcome: "none", bestScore: 0.4 } },
  "call_fixer",
  "shop-manifest",
);
addMiss(
  "shop-cosmetic-dialog-strict",
  "Same, under a strict heal policy",
  { ranking: { outcome: "none", bestScore: 0.4 }, policy: "strict" },
  "no_heal",
  "shop-manifest",
);
addMiss(
  "shop-broken-signup",
  "broken-signup: the sign-up page is a 500 page",
  { page: { isError: true, appDown: false, serverErrors: 1, networkFailures: 0 } },
  "block",
  "shop-manifest",
);
addMiss(
  "shop-broken-login-redirect",
  "broken-login-redirect: the next step's element is missing on the error page",
  { page: { isError: true, appDown: false, serverErrors: 0, networkFailures: 0 } },
  "block",
  "shop-manifest",
);
addMiss(
  "shop-silent-click",
  "broken-silent-click: 'Create project' clicked, nothing happened; the element was the right one",
  { missReason: "post_state_mismatch", usedElement: "same" },
  "no_heal",
  "shop-manifest",
);
addMiss(
  "shop-env-flaky",
  "env-flaky: the projects API answered 503",
  {
    page: { isError: false, appDown: false, serverErrors: 1, networkFailures: 0 },
    missReason: "post_state_mismatch",
    usedElement: "same",
  },
  "block",
  "shop-manifest",
);

// Every rung of the ladder, with variations.
for (const [i, page] of [
  { isError: false, appDown: true, serverErrors: 0, networkFailures: 1 },
  { isError: true, appDown: false, serverErrors: 0, networkFailures: 0 },
  { isError: null, appDown: false, serverErrors: 2, networkFailures: 0 },
  { isError: false, appDown: false, serverErrors: 0, networkFailures: 3 },
].entries())
  addMiss(
    `unhealthy-${i}`,
    "The page is unhealthy: block even though healing looks possible",
    {
      page,
      fallbacks: { total: 1, matched: 1, sameElement: "same" },
      ranking: { outcome: "match", bestScore: 0.9 },
    },
    "block",
  );
for (const refusal of ["disallowed_domain", "missing_secret", "captcha"])
  addMiss(
    `refused-${refusal}`,
    `The action was refused (${refusal})`,
    { missReason: "action_refused", refusal },
    "block",
  );
addMiss(
  "post-state-same",
  "The right element did nothing: don't heal",
  {
    missReason: "post_state_mismatch",
    usedElement: "same",
    ranking: { outcome: "match", bestScore: 0.9 },
  },
  "no_heal",
);
addMiss(
  "post-state-not-same-refind",
  "Acted on the wrong element; re-find found the right one",
  {
    missReason: "post_state_mismatch",
    usedElement: "not_same",
    ranking: { outcome: "match", bestScore: 0.88 },
  },
  "refind",
);
addMiss(
  "post-state-unknown-fixer",
  "Post-state mismatch, element identity unknown, nothing clear on the page",
  {
    missReason: "post_state_mismatch",
    usedElement: "unknown",
    ranking: { outcome: "ambiguous", bestScore: 0.7 },
  },
  "call_fixer",
);
for (const reason of ["not_found", "multiple_matches", "fingerprint_mismatch"])
  addMiss(
    `fallback-same-${reason}`,
    `${reason}: a fallback matched the same element`,
    { missReason: reason, fallbacks: { total: 3, matched: 1, sameElement: "same" } },
    "replay_fallback",
  );
addMiss(
  "fallback-not-same-refind",
  "A fallback matched a different element; re-find found the right one",
  {
    fallbacks: { total: 2, matched: 1, sameElement: "not_same" },
    ranking: { outcome: "match", bestScore: 0.9 },
  },
  "refind",
);
addMiss(
  "fallback-unknown-fixer",
  "A fallback matched, identity unknown; nothing clear on the page",
  {
    fallbacks: { total: 2, matched: 1, sameElement: "unknown" },
    ranking: { outcome: "none", bestScore: 0.2 },
  },
  "call_fixer",
);
addMiss(
  "fallback-unknown-strict",
  "A fallback matched, identity unknown, strict policy",
  { fallbacks: { total: 2, matched: 1, sameElement: "unknown" }, policy: "strict" },
  "no_heal",
);
for (const policy of ["review", "auto"])
  addMiss(
    `refind-${policy}`,
    `Clear re-find under ${policy} policy`,
    { ranking: { outcome: "match", bestScore: 0.8 }, policy },
    "refind",
  );
addMiss(
  "refind-strict",
  "A clear re-find is allowed under strict (no AI involved)",
  { ranking: { outcome: "match", bestScore: 0.92 }, policy: "strict" },
  "refind",
);
addMiss(
  "ambiguous-strict",
  "Two equal matches, strict policy",
  { ranking: { outcome: "ambiguous", bestScore: 0.9 }, policy: "strict" },
  "no_heal",
);
addMiss(
  "ambiguous-fixer",
  "Two equal matches: the fixer decides",
  { ranking: { outcome: "ambiguous", bestScore: 0.9 } },
  "call_fixer",
);
addMiss("none-strict", "Nothing found, strict policy", { policy: "strict" }, "no_heal");
addMiss(
  "none-auto-fixer",
  "Nothing found, auto policy, fixer available",
  { policy: "auto" },
  "call_fixer",
);
addMiss("none-no-cap-fixer", "Nothing found, no budget cap", { budgetLeftUsd: null }, "call_fixer");
addMiss(
  "none-no-fixer",
  "Nothing found, no fixer model (no key)",
  { fixerAvailable: false },
  "block",
);
addMiss("none-budget-spent", "Nothing found, budget spent", { budgetLeftUsd: 0 }, "block");
addMiss(
  "none-budget-negative",
  "Nothing found, budget overspent",
  { budgetLeftUsd: -0.05 },
  "block",
);
addMiss(
  "not-run-fixer",
  "Re-find not run (no fingerprint), fixer available",
  {
    ranking: { outcome: "not_run", bestScore: null },
    fallbacks: { total: 0, matched: 0, sameElement: null },
  },
  "call_fixer",
);
addMiss(
  "not-run-no-fixer",
  "Re-find not run, no fixer",
  { ranking: { outcome: "not_run", bestScore: null }, fixerAvailable: false },
  "block",
);
addMiss(
  "multiple-no-fallbacks-fixer",
  "Primary matched 3 elements, no fallbacks, nothing clear",
  {
    missReason: "multiple_matches",
    fallbacks: { total: 0, matched: 0, sameElement: null },
    ranking: { outcome: "ambiguous", bestScore: 0.6 },
  },
  "call_fixer",
);
addMiss(
  "mismatch-refind",
  "Primary found an element whose fingerprint doesn't match; re-find found the right one",
  { missReason: "fingerprint_mismatch", ranking: { outcome: "match", bestScore: 0.87 } },
  "refind",
);
addMiss(
  "error-page-strict",
  "Error page under strict policy: still block (not the test's fault)",
  {
    page: { isError: true, appDown: false, serverErrors: 0, networkFailures: 0 },
    policy: "strict",
  },
  "block",
);
addMiss(
  "healthy-unknown-page-fixer",
  "page_is_error undecided, no 5xx: healthy enough to heal",
  { page: { isError: null, appDown: false, serverErrors: 0, networkFailures: 0 } },
  "call_fixer",
);

// ── write ────────────────────────────────────────────────────────────────────

for (const [task, cases, min] of [
  ["same_element", same, 60],
  ["miss_action", miss, 40],
] as const) {
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error(`${task}: duplicate ids`);
  if (cases.length < min) throw new Error(`${task}: only ${cases.length} cases (need ${min})`);
  writeFileSync(
    new URL(`evals/${task}.jsonl`, root),
    `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
  );
  console.log(`${task}: ${cases.length} cases`);
}
