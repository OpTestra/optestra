import { findPlan, type Order, type Plan, TIMEZONES, type User } from "./store.js";
import type { Bugs, Surface } from "./variants.js";

// Server-rendered HTML. Pages read class names, ids, labels and layout from the
// variant's Surface, and JS hooks from stable `data-js` attributes.

export interface PageContext {
  s: Surface;
  bugs: Bugs;
  user: User | undefined;
  path: string;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function longDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${day}, ${year}`;
}

function navLink(ctx: PageContext, href: string, text: string): string {
  const current = ctx.path === href ? ' aria-current="page"' : "";
  return `<li><a href="${href}"${current}>${text}</a></li>`;
}

function header(ctx: PageContext): string {
  const { s, user } = ctx;
  if (!user) {
    const links = [
      navLink(ctx, "/pricing", "Pricing"),
      navLink(ctx, "/login", "Log in"),
      navLink(ctx, "/signup", "Sign up"),
    ];
    return `<header class="${s.cls.header}"><a class="brand" href="/">Acme Shop</a>
<nav class="${s.cls.nav}" aria-label="Main"><ul>${links.join("")}</ul></nav></header>`;
  }
  const links = [
    navLink(ctx, "/dashboard", "Dashboard"),
    navLink(ctx, "/orders", "Orders"),
    navLink(ctx, "/billing", "Billing"),
    navLink(ctx, "/settings", "Settings"),
  ];
  const logout = `<li><form method="post" action="/logout"><button type="submit" class="${s.cls.button}">Log out</button></form></li>`;
  const items = s.layout.logoutLast ? [...links, logout] : [logout, ...links];
  return `<header class="${s.cls.header}"><a class="brand" href="/">Acme Shop</a>
<nav class="${s.cls.nav}" aria-label="Main"><ul>${items.join("")}</ul></nav></header>`;
}

export function layout(
  ctx: PageContext,
  page: { title: string; body: string; scripts?: string[] },
): string {
  const scripts = (page.scripts ?? [])
    .map((name) => `<script type="module" src="/assets/${name}"></script>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} · Acme Shop</title>
<link rel="stylesheet" href="/assets/${ctx.s.stylesheet}">
</head>
<body>
${header(ctx)}
<main class="${ctx.s.cls.main}">
${page.body}
</main>
<div class="${ctx.s.cls.toasts}" data-js="toasts" role="status" aria-live="polite"></div>
${scripts}
</body>
</html>
`;
}

interface FieldOptions {
  id: string;
  name: string;
  label: string;
  type?: string;
  value?: string;
  error?: string | undefined;
  hint?: string;
  autocomplete?: string;
  readonly?: boolean;
}

function field(s: Surface, o: FieldOptions): string {
  const described: string[] = [];
  if (o.hint) described.push(`${o.id}-hint`);
  if (o.error) described.push(`${o.id}-error`);
  const attrs = [
    `id="${o.id}"`,
    `name="${o.name}"`,
    `type="${o.type ?? "text"}"`,
    `value="${esc(o.value ?? "")}"`,
    o.autocomplete ? `autocomplete="${o.autocomplete}"` : "",
    o.readonly ? "readonly" : "",
    o.error ? 'aria-invalid="true"' : "",
    described.length ? `aria-describedby="${described.join(" ")}"` : "",
  ].filter(Boolean);
  return `<div class="${s.cls.field}">
<label for="${o.id}">${o.label}</label>
<input ${attrs.join(" ")}>
${o.hint ? `<p class="hint" id="${o.id}-hint">${o.hint}</p>` : ""}
${o.error ? `<p class="${s.cls.error}" id="${o.id}-error">${esc(o.error)}</p>` : ""}
</div>`;
}

export function homePage(ctx: PageContext, deleted: boolean): string {
  const notice = deleted ? '<p role="status">Your account has been deleted.</p>' : "";
  return layout(ctx, {
    title: "Home",
    body: `${notice}<h1>Acme Shop</h1>
<p>Simple project tracking for small teams.</p>
<p><a href="/pricing">See pricing</a></p>`,
  });
}

function planCard(ctx: PageContext, plan: Plan): string {
  const { s } = ctx;
  const action = ctx.user ? "/checkout" : "/signup";
  const features = plan.features.map((f) => `<li>${f}</li>`).join("");
  return `<article class="${s.cls.plan} ${s.cls.plan}--${plan.id}" data-testid="${s.testid.plan(plan.id)}" aria-labelledby="plan-${plan.id}-name">
<h2 id="plan-${plan.id}-name">${plan.name}</h2>
<p class="price">${money(plan.priceCents)}<span>/month</span></p>
<ul>${features}</ul>
<form method="get" action="${action}"><input type="hidden" name="plan" value="${plan.id}">
<button type="submit" class="${s.cls.button} ${s.cls.primary}">${s.label.startTrial}</button></form>
</article>`;
}

export function pricingPage(ctx: PageContext): string {
  const plans = ctx.s.layout.planOrder
    .map((id) => findPlan(id))
    .filter((plan): plan is Plan => plan !== undefined)
    .map((plan) => planCard(ctx, plan))
    .join("\n");
  return layout(ctx, {
    title: "Pricing",
    body: `<h1>Pricing</h1>
<p>Every plan starts with a 14-day free trial.</p>
<div class="${ctx.s.cls.plans}">${plans}</div>`,
  });
}

export interface SignupState {
  email: string;
  plan: string | null;
  errors: { email?: string; password?: string };
}

export function signupPage(ctx: PageContext, state: SignupState): string {
  const { s } = ctx;
  const plan = findPlan(state.plan);
  const trial = plan ? `<p>You're starting a free trial of ${plan.name}.</p>` : "";
  return layout(ctx, {
    title: "Sign up",
    body: `<h1>Create your account</h1>
${trial}
<form id="${s.id.signupForm}" class="${s.cls.panel}" method="post" action="/signup" novalidate>
${plan ? `<input type="hidden" name="plan" value="${plan.id}">` : ""}
${field(s, { id: s.id.signupEmail, name: "email", label: "Email", type: "email", value: state.email, error: state.errors.email, autocomplete: "email" })}
${field(s, { id: s.id.signupPassword, name: "password", label: "Password", type: "password", error: state.errors.password, hint: "At least 8 characters.", autocomplete: "new-password" })}
<button type="submit" class="${s.cls.button} ${s.cls.primary}">${s.label.signUpButton}</button>
</form>
<p>Already have an account? <a href="/login">Log in</a></p>`,
  });
}

export function verifyPage(
  ctx: PageContext,
  state: { email: string; plan: string | null; error?: string },
): string {
  const { s } = ctx;
  return layout(ctx, {
    title: "Verify your email",
    body: `<h1>Check your email</h1>
<p>We sent a 6-digit code to <strong>${esc(state.email)}</strong>.</p>
<form class="${s.cls.panel}" method="post" action="/verify" novalidate>
<input type="hidden" name="email" value="${esc(state.email)}">
${state.plan ? `<input type="hidden" name="plan" value="${esc(state.plan)}">` : ""}
${field(s, { id: s.id.verifyCode, name: "code", label: "Verification code", error: state.error, autocomplete: "one-time-code" })}
<button type="submit" class="${s.cls.button} ${s.cls.primary}">Verify</button>
</form>`,
  });
}

export function loginPage(
  ctx: PageContext,
  state: { email: string; next: string; error?: string },
): string {
  const { s } = ctx;
  const error = state.error ? `<p role="alert" class="${s.cls.error}">${esc(state.error)}</p>` : "";
  return layout(ctx, {
    title: "Log in",
    body: `<h1>Log in</h1>
${error}
<form id="${s.id.loginForm}" class="${s.cls.panel}" method="post" action="/login" novalidate>
<input type="hidden" name="next" value="${esc(state.next)}">
${field(s, { id: s.id.loginEmail, name: "email", label: "Email", type: "email", value: state.email, autocomplete: "email" })}
${field(s, { id: s.id.loginPassword, name: "password", label: "Password", type: "password", autocomplete: "current-password" })}
<button type="submit" class="${s.cls.button} ${s.cls.primary}">${s.label.logInButton}</button>
</form>
<p>New here? <a href="/signup">Sign up</a></p>`,
  });
}

/** Two-factor login: the authentication code from an authenticator app (TOTP). */
export function loginCodePage(
  ctx: PageContext,
  state: { token: string; next: string; error?: string },
): string {
  const { s } = ctx;
  return layout(ctx, {
    title: "Two-factor authentication",
    body: `<h1>Two-factor authentication</h1>
<p>Enter the 6-digit code from your authenticator app.</p>
<form class="${s.cls.panel}" method="post" action="/login/code" novalidate>
<input type="hidden" name="token" value="${esc(state.token)}">
<input type="hidden" name="next" value="${esc(state.next)}">
${field(s, { id: "login-code", name: "code", label: "Authentication code", error: state.error, autocomplete: "one-time-code" })}
<button type="submit" class="${s.cls.button} ${s.cls.primary}">Verify</button>
</form>`,
  });
}

export function dashboardPage(ctx: PageContext, welcomePlan: Plan | undefined): string {
  const { s, bugs } = ctx;
  const hook = bugs.createButtonUnwired ? "" : ' data-js="open-create"';
  const create = `<button type="button" id="${s.id.createProject}" class="${s.cls.button} ${s.cls.primary}"${hook}>${s.label.createProject}</button>`;
  return layout(ctx, {
    title: "Dashboard",
    body: `<h1>${welcomePlan ? `Welcome to ${welcomePlan.name}` : "Dashboard"}</h1>
<section class="${s.cls.panel}" aria-labelledby="projects-heading">
<div class="toolbar"><h2 id="projects-heading">Projects</h2>${s.layout.createAboveList ? create : ""}</div>
<ul data-testid="${s.testid.projects}" data-js="project-list" aria-labelledby="projects-heading" aria-busy="true">
<li data-js="loading">Loading projects…</li>
</ul>
${s.layout.createAboveList ? "" : create}
</section>
<dialog data-js="create-dialog" aria-labelledby="new-project-title">
<form data-js="create-form" novalidate>
<h2 id="new-project-title">New project</h2>
${field(s, { id: s.id.projectName, name: "name", label: "Project name" })}
<p class="${s.cls.error}" data-js="create-error" role="alert" hidden></p>
<div class="actions">
<button type="button" class="${s.cls.button}" data-js="cancel-create">Cancel</button>
<button type="submit" class="${s.cls.button} ${s.cls.primary}">${s.label.createConfirm}</button>
</div>
</form>
</dialog>`,
    scripts: ["dashboard.js"],
  });
}

export function checkoutPage(ctx: PageContext, plan: Plan): string {
  const { s } = ctx;
  const button = `<button type="submit" class="${s.cls.button} ${s.cls.primary}">${s.label.startCheckout}</button>`;
  return layout(ctx, {
    title: "Checkout",
    body: `<h1>Start your ${plan.name} trial</h1>
<p>14 days free, then ${money(plan.priceCents)}/month. You won't be charged today.</p>
<form class="${s.cls.panel}" data-js="checkout-form" data-plan="${plan.id}" novalidate>
${s.layout.checkoutButtonBelow ? "" : button}
<iframe src="/pay/frame" title="Secure card payment" data-js="card-frame" width="420" height="230"></iframe>
<p class="${s.cls.error}" data-js="checkout-error" role="alert" hidden></p>
${s.layout.checkoutButtonBelow ? button : ""}
</form>`,
    scripts: ["checkout.js"],
  });
}

/** The card form inside the iframe, like a payment provider's hosted fields. */
export function payFramePage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Card details</title><link rel="stylesheet" href="/assets/pay-frame.css"></head>
<body>
<form data-js="card-form" novalidate>
<label for="card-number">Card number</label>
<input id="card-number" name="number" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234">
<div class="row">
<div><label for="card-expiry">Expiry date</label>
<input id="card-expiry" name="expiry" inputmode="numeric" autocomplete="cc-exp" placeholder="MM / YY"></div>
<div><label for="card-cvc">CVC</label>
<input id="card-cvc" name="cvc" inputmode="numeric" autocomplete="cc-csc" placeholder="123"></div>
</div>
<p class="error" data-js="card-error" role="alert" hidden></p>
</form>
<script type="module" src="/assets/pay-frame.js"></script>
</body>
</html>
`;
}

export function billingPage(ctx: PageContext): string {
  const { s, user, bugs } = ctx;
  const subscription = user?.subscription;
  const plan = findPlan(subscription?.planId);
  let body: string;
  if (subscription && plan) {
    const dueToday = bugs.trialChargesToday ? plan.priceCents : 0;
    body = `<p>${plan.name} plan · free trial until ${longDate(subscription.trialEndsOn)}</p>
<p class="due" data-testid="${s.testid.dueToday}">${money(dueToday)} due today</p>
<p>Then ${money(plan.priceCents)}/month.</p>`;
  } else {
    body = `<p>You're on the free plan.</p><p><a href="/pricing">See plans</a></p>`;
  }
  return layout(ctx, {
    title: "Billing",
    body: `<h1>Billing</h1>
<section class="${s.cls.panel}" aria-labelledby="plan-heading">
<h2 id="plan-heading">Current plan</h2>
${body}
</section>`,
  });
}

export function settingsPage(ctx: PageContext): string {
  const { s } = ctx;
  const user = ctx.user as User;
  const options = TIMEZONES.map(
    (tz) => `<option value="${tz}"${tz === user.timezone ? " selected" : ""}>${tz}</option>`,
  ).join("");
  const avatar = user.avatar
    ? `<img data-js="avatar-img" src="/avatar?v=${user.avatar.version}" alt="Your avatar" width="96" height="96">`
    : '<p data-js="avatar-empty">No avatar yet.</p>';
  const profile = `<section class="${s.cls.panel}" aria-labelledby="profile-heading">
<h2 id="profile-heading">Profile</h2>
<form data-js="profile-form" novalidate>
${field(s, { id: s.id.profileName, name: "name", label: s.label.fullName, value: user.name, autocomplete: "name" })}
${field(s, { id: "profile-email", name: "email", label: "Email", type: "email", value: user.email, readonly: true })}
<div class="${s.cls.field}">
<label for="${s.id.profileTimezone}">Time zone</label>
<select id="${s.id.profileTimezone}" name="timezone">${options}</select>
</div>
<button type="submit" class="${s.cls.button} ${s.cls.primary}">${s.label.saveProfile}</button>
</form>
</section>`;
  const avatarSection = `<section class="${s.cls.panel}" aria-labelledby="avatar-heading">
<h2 id="avatar-heading">Avatar</h2>
<div data-js="avatar-slot">${avatar}</div>
<form data-js="avatar-form" novalidate>
<div class="${s.cls.field}">
<label for="${s.id.avatarInput}">Choose an image</label>
<input id="${s.id.avatarInput}" name="avatar" type="file" accept="image/png,image/jpeg">
</div>
<button type="submit" class="${s.cls.button}">${s.label.uploadAvatar}</button>
</form>
</section>`;
  const danger = `<section class="${s.cls.panel}" aria-labelledby="danger-heading">
<h2 id="danger-heading">Danger zone</h2>
<p>Deleting your account removes all your projects and orders. This can't be undone.</p>
<button type="button" class="${s.cls.button} ${s.cls.danger}" data-js="open-delete">Delete account</button>
<dialog role="alertdialog" data-js="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-desc">
<form method="post" action="/settings/delete">
<h2 id="delete-title">Delete your account?</h2>
<p id="delete-desc">This removes ${esc(user.email)} and everything in it.</p>
<div class="actions">
<button type="button" class="${s.cls.button}" data-js="cancel-delete">Cancel</button>
<button type="submit" class="${s.cls.button} ${s.cls.danger}">Yes, delete my account</button>
</div>
</form>
</dialog>
</section>`;
  const sections = s.layout.profileFirst ? [profile, avatarSection] : [avatarSection, profile];
  return layout(ctx, {
    title: "Settings",
    body: `<h1>Settings</h1>\n${sections.join("\n")}\n${danger}`,
    scripts: ["settings.js"],
  });
}

function orderRow(order: Order): string {
  const hidden = order.status === "Refunded" ? " hidden" : "";
  return `<tr data-number="${order.number}" data-date="${order.date}" data-status="${order.status}" data-total="${order.totalCents}"${hidden}>
<th scope="row">${order.number}</th><td>${longDate(order.date)}</td><td>${order.status}</td><td>${money(order.totalCents)}</td></tr>`;
}

export function ordersPage(ctx: PageContext, orders: Order[]): string {
  const { s } = ctx;
  const rows = [...orders]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(orderRow)
    .join("\n");
  const column = (key: string, text: string, sort = "none") =>
    `<th scope="col" aria-sort="${sort}"><button type="button" data-sort="${key}">${text}</button></th>`;
  const testid = s.testid.orders ? ` data-testid="${s.testid.orders}"` : "";
  return layout(ctx, {
    title: "Orders",
    body: `<h1>Orders</h1>
<div class="${s.cls.link}" data-js="toggle-refunded" data-show="${s.label.showRefunded}" data-hide="${s.label.hideRefunded}">${s.label.showRefunded}</div>
<table class="${s.cls.table}" data-js="orders-table"${testid}>
<caption>Your orders</caption>
<thead><tr>${column("number", "Order")}${column("date", "Date", "descending")}${column("status", "Status")}${column("total", "Total")}</tr></thead>
<tbody>
${rows}
</tbody>
</table>`,
    scripts: ["orders.js"],
  });
}

export function errorPage(ctx: PageContext, title: string, message: string): string {
  return layout(ctx, { title, body: `<h1>${esc(title)}</h1>\n<p>${esc(message)}</p>` });
}
