// Every build of the shop is the same codebase with switches. Behaviour switches
// live in `Bugs`; surface switches (what the cosmetic build changes) live in
// `Surface`. Both are plain data so the whole difference between variants can be
// read in this one file.

export const VARIANTS = [
  "correct",
  "cosmetic",
  "broken-signup",
  "broken-total",
  "broken-login-redirect",
  "broken-silent-click",
  "broken-not-saved",
  "env-flaky",
] as const;

export type Variant = (typeof VARIANTS)[number];

export const VARIANT_DESCRIPTIONS: Record<Variant, string> = {
  correct: "The reference build. Everything works.",
  cosmetic:
    "Same behaviour, different surface: renamed classes, ids and test ids, reordered DOM, moved buttons, restyled layout, reworded labels.",
  "broken-signup": 'Submitting a valid sign-up form returns a 500 "Something went wrong" page.',
  "broken-total": 'The billing page shows "$29.00 due today" during a free trial.',
  "broken-login-redirect": "Logging in lands on an error page instead of the dashboard.",
  "broken-silent-click":
    'False-pass trap: the "Create project" button looks clickable but does nothing.',
  "broken-not-saved":
    "False-pass trap: creating a project shows the success toast, but the project is gone after a reload.",
  "env-flaky":
    "Environment trouble: the projects API returns 503 on every 2nd request, once per environment reset.",
};

export function isVariant(value: string): value is Variant {
  return (VARIANTS as readonly string[]).includes(value);
}

export interface Bugs {
  /** POST /signup crashes after validation passes. */
  signupCrashes: boolean;
  /** Billing charges the plan price today instead of $0 during a trial. */
  trialChargesToday: boolean;
  /** POST /login redirects to /error and creates no session. */
  loginRedirectsToError: boolean;
  /** The "Create project" button lost its JS hook, so clicking it does nothing. */
  createButtonUnwired: boolean;
  /** POST /api/projects answers 201 but never stores the project. */
  projectsNotSaved: boolean;
  /** The projects API fails with 503 on a seeded pattern (see `FLAKY_PATTERN`). */
  flakyProjectsApi: boolean;
}

const NO_BUGS: Bugs = {
  signupCrashes: false,
  trialChargesToday: false,
  loginRedirectsToError: false,
  createButtonUnwired: false,
  projectsNotSaved: false,
  flakyProjectsApi: false,
};

export function bugsFor(variant: Variant): Bugs {
  switch (variant) {
    case "broken-signup":
      return { ...NO_BUGS, signupCrashes: true };
    case "broken-total":
      return { ...NO_BUGS, trialChargesToday: true };
    case "broken-login-redirect":
      return { ...NO_BUGS, loginRedirectsToError: true };
    case "broken-silent-click":
      return { ...NO_BUGS, createButtonUnwired: true };
    case "broken-not-saved":
      return { ...NO_BUGS, projectsNotSaved: true };
    case "env-flaky":
      return { ...NO_BUGS, flakyProjectsApi: true };
    default:
      return NO_BUGS;
  }
}

/**
 * The env-flaky pattern: every `failEvery`-th request to the projects API answers
 * 503, until `maxFailures` have happened. `POST /__test/reset?environment=1` (or a
 * server restart) starts the pattern again; a plain data reset does not, because
 * environment trouble outlives app data. With these values the 2nd request after
 * an environment reset fails once, so a test that fails on it passes on retry.
 */
export const FLAKY_PATTERN = { failEvery: 2, maxFailures: 1 } as const;

/** Everything the cosmetic build changes. Headings, messages and amounts never change. */
export interface Surface {
  stylesheet: "correct.css" | "cosmetic.css";
  cls: {
    header: string;
    nav: string;
    main: string;
    button: string;
    primary: string;
    danger: string;
    plans: string;
    plan: string;
    field: string;
    error: string;
    toasts: string;
    table: string;
    panel: string;
    link: string;
  };
  id: {
    signupForm: string;
    signupEmail: string;
    signupPassword: string;
    loginForm: string;
    loginEmail: string;
    loginPassword: string;
    verifyCode: string;
    createProject: string;
    projectName: string;
    profileName: string;
    profileTimezone: string;
    avatarInput: string;
  };
  testid: {
    plan: (plan: string) => string;
    projects: string;
    dueToday: string;
    orders: string | null;
  };
  label: {
    startTrial: string;
    signUpButton: string;
    logInButton: string;
    createProject: string;
    createConfirm: string;
    saveProfile: string;
    fullName: string;
    uploadAvatar: string;
    showRefunded: string;
    hideRefunded: string;
    startCheckout: string;
  };
  layout: {
    /** Pricing plans in this order. */
    planOrder: readonly string[];
    /** "Create project" above the list (true) or below it (false). */
    createAboveList: boolean;
    /** "Log out" at the end of the nav (true) or before the links (false). */
    logoutLast: boolean;
    /** Settings sections: profile first (true) or avatar first (false). */
    profileFirst: boolean;
    /** Checkout "Start trial" button below the card frame (true) or above it (false). */
    checkoutButtonBelow: boolean;
  };
}

const CORRECT_SURFACE: Surface = {
  stylesheet: "correct.css",
  cls: {
    header: "site-header",
    nav: "site-nav",
    main: "page",
    button: "btn",
    primary: "btn-primary",
    danger: "btn-danger",
    plans: "plans",
    plan: "plan",
    field: "field",
    error: "field-error",
    toasts: "toasts",
    table: "orders-table",
    panel: "panel",
    link: "fake-link",
  },
  id: {
    signupForm: "signup-form",
    signupEmail: "signup-email",
    signupPassword: "signup-password",
    loginForm: "login-form",
    loginEmail: "login-email",
    loginPassword: "login-password",
    verifyCode: "verify-code",
    createProject: "create-project",
    projectName: "project-name",
    profileName: "profile-name",
    profileTimezone: "profile-timezone",
    avatarInput: "avatar-file",
  },
  testid: {
    plan: (plan) => `plan-${plan}`,
    projects: "project-list",
    dueToday: "due-today",
    orders: "orders-table",
  },
  label: {
    startTrial: "Start free trial",
    signUpButton: "Sign up",
    logInButton: "Log in",
    createProject: "Create project",
    createConfirm: "Create",
    saveProfile: "Save changes",
    fullName: "Full name",
    uploadAvatar: "Upload avatar",
    showRefunded: "Show refunded orders",
    hideRefunded: "Hide refunded orders",
    startCheckout: "Start trial",
  },
  layout: {
    planOrder: ["starter", "pro", "team"],
    createAboveList: true,
    logoutLast: true,
    profileFirst: true,
    checkoutButtonBelow: true,
  },
};

const COSMETIC_SURFACE: Surface = {
  stylesheet: "cosmetic.css",
  cls: {
    header: "topbar",
    nav: "menu",
    main: "content",
    button: "button",
    primary: "button--main",
    danger: "button--warn",
    plans: "pricing-grid",
    plan: "pricing-tile",
    field: "form-row",
    error: "form-row__error",
    toasts: "notices",
    table: "data-table",
    panel: "box",
    link: "text-action",
  },
  id: {
    signupForm: "register-form",
    signupEmail: "register-email",
    signupPassword: "register-password",
    loginForm: "signin-form",
    loginEmail: "signin-email",
    loginPassword: "signin-password",
    verifyCode: "otp",
    createProject: "add-project",
    projectName: "new-project-name",
    profileName: "user-name",
    profileTimezone: "user-tz",
    avatarInput: "photo-input",
  },
  testid: {
    plan: (plan) => `pricing-${plan}`,
    projects: "projects",
    dueToday: "amount-due",
    orders: null,
  },
  label: {
    startTrial: "Start your free trial",
    signUpButton: "Create account",
    logInButton: "Sign in",
    createProject: "Add project",
    createConfirm: "Save project",
    saveProfile: "Save profile",
    fullName: "Your name",
    uploadAvatar: "Upload photo",
    showRefunded: "Include refunded orders",
    hideRefunded: "Exclude refunded orders",
    startCheckout: "Start my trial",
  },
  layout: {
    planOrder: ["team", "pro", "starter"],
    createAboveList: false,
    logoutLast: false,
    profileFirst: false,
    checkoutButtonBelow: false,
  },
};

export function surfaceFor(variant: Variant): Surface {
  return variant === "cosmetic" ? COSMETIC_SURFACE : CORRECT_SURFACE;
}
