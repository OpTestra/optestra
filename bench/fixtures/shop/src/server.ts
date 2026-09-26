import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as pages from "./pages.js";
import { parseSmtpTarget, type SmtpTarget, sendSmtp } from "./smtp.js";
import {
  findPlan,
  type SeedInput,
  Store,
  TIMEZONES,
  TODAY,
  type User,
  verificationCode,
} from "./store.js";
import { bugsFor, FLAKY_PATTERN, surfaceFor, type Variant } from "./variants.js";

// The shop's HTTP server. It only serves: it binds to 127.0.0.1, makes no
// outbound calls (the optional Mailpit SMTP path is loopback-only) and sends a
// Content-Security-Policy that keeps the pages on this origin too.

export const HOST = "127.0.0.1";

export interface ShopOptions {
  variant?: Variant;
  /** 0 (default) picks a free port. */
  port?: number;
  /** Local Mailpit SMTP as "127.0.0.1:1025". Defaults to the MAILPIT_SMTP env var. */
  mailpitSmtp?: string | undefined;
}

export interface RunningShop {
  url: string;
  variant: Variant;
  stop(): Promise<void>;
}

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const COOKIE = "acme_session";
const MAX_BODY = 2 * 1024 * 1024;
const MAX_AVATAR = 1024 * 1024;
const DECLINED_CARD = "4000000000000002";
const CSP =
  "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'self'; form-action 'self'";

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Request {
  method: string;
  url: URL;
  user: User | undefined;
  sessionId: string | undefined;
  body: Buffer;
  contentType: string;
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string>,
) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

const html = (res: ServerResponse, status: number, body: string, headers = {}) =>
  send(res, status, body, { "content-type": "text/html; charset=utf-8", ...headers });

const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, JSON.stringify(data), { "content-type": "application/json; charset=utf-8" });

const redirect = (res: ServerResponse, location: string, headers = {}) =>
  send(res, 303, "", { location, ...headers });

function sessionCookie(id: string | null): string {
  return id
    ? `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`
    : `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function form(req: Request): URLSearchParams {
  return new URLSearchParams(req.body.toString("utf8"));
}

function jsonBody<T>(req: Request): Partial<T> {
  if (req.body.length === 0) return {};
  try {
    const value: unknown = JSON.parse(req.body.toString("utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  } catch {}
  throw new HttpError(400, "Expected a JSON object");
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Only same-site paths, so `next` can't send anyone elsewhere. */
function safeNext(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

function cardError(number: string, expiry: string, cvc: string): string | null {
  if (!/^\d{16}$/.test(number) || !luhn(number)) return "Your card number is invalid.";
  const exp = /^(\d{2})\s*\/\s*(\d{2})$/.exec(expiry.trim());
  const month = Number(exp?.[1]);
  if (!exp || month < 1 || month > 12) return "Your card's expiry date is incomplete.";
  const [year, currentMonth] = TODAY.split("-").map(Number);
  const expYear = 2000 + Number(exp[2]);
  if (expYear < (year ?? 0) || (expYear === year && month < (currentMonth ?? 0))) {
    return "Your card's expiry date is in the past.";
  }
  if (!/^\d{3,4}$/.test(cvc.trim())) return "Your card's security code is incomplete.";
  return null;
}

function imageType(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return null;
}

export async function startShop(options: ShopOptions = {}): Promise<RunningShop> {
  const variant = options.variant ?? "correct";
  const s = surfaceFor(variant);
  const bugs = bugsFor(variant);
  const store = new Store();
  const smtpSetting = options.mailpitSmtp ?? process.env.MAILPIT_SMTP;
  const smtp: SmtpTarget | null = smtpSetting ? parseSmtpTarget(smtpSetting) : null;
  let flaky = { requests: 0, failures: 0 };

  const ctx = (req: Request): pages.PageContext => ({
    s,
    bugs,
    user: req.user,
    path: req.url.pathname,
  });

  function sendVerification(user: User): void {
    const code = verificationCode(user.email);
    const mail = {
      to: user.email,
      subject: "Your Acme Shop verification code",
      text: `Your verification code is ${code}.\n\nEnter it on the sign-up page to finish creating your account.`,
    };
    store.sendEmail(mail);
    if (smtp) {
      sendSmtp(smtp, { ...mail, from: "no-reply@acme-shop.localhost" }).catch((error: unknown) => {
        process.stderr.write(`acme-shop: Mailpit delivery failed: ${String(error)}\n`);
      });
    }
  }

  /** The env-flaky pattern for the projects API (see FLAKY_PATTERN). */
  function projectsApiDown(): boolean {
    if (!bugs.flakyProjectsApi) return false;
    flaky.requests++;
    if (flaky.failures >= FLAKY_PATTERN.maxFailures) return false;
    if (flaky.requests % FLAKY_PATTERN.failEvery !== 0) return false;
    flaky.failures++;
    return true;
  }

  function requireUser(req: Request, res: ServerResponse): User | null {
    if (req.user) return req.user;
    redirect(res, `/login?next=${encodeURIComponent(req.url.pathname + req.url.search)}`);
    return null;
  }

  function requireApiUser(req: Request): User {
    if (!req.user) throw new HttpError(401, "Log in first");
    return req.user;
  }

  async function asset(res: ServerResponse, name: string): Promise<void> {
    const ext = /\.[a-z]+$/.exec(name)?.[0] ?? "";
    const type = MIME[ext];
    if (!/^[\w-]+\.[a-z]+$/.test(name) || !type) throw new HttpError(404, "Not found");
    const data = await readFile(new URL(name, PUBLIC_DIR)).catch(() => null);
    if (!data) throw new HttpError(404, "Not found");
    send(res, 200, data, { "content-type": type });
  }

  async function route(req: Request, res: ServerResponse): Promise<void> {
    const { method, url } = req;
    const path = url.pathname;
    const key = `${method} ${path}`;

    if (method === "GET" && path.startsWith("/assets/")) return asset(res, path.slice(8));

    switch (key) {
      case "GET /":
        return html(res, 200, pages.homePage(ctx(req), url.searchParams.get("deleted") === "1"));

      case "GET /favicon.ico":
        return send(res, 204, "", {});

      case "GET /pricing":
        return html(res, 200, pages.pricingPage(ctx(req)));

      case "GET /signup": {
        if (req.user) return redirect(res, "/dashboard");
        const plan = findPlan(url.searchParams.get("plan"))?.id ?? null;
        return html(res, 200, pages.signupPage(ctx(req), { email: "", plan, errors: {} }));
      }

      case "POST /signup": {
        const data = form(req);
        const email = (data.get("email") ?? "").trim();
        const password = data.get("password") ?? "";
        const plan = findPlan(data.get("plan"))?.id ?? null;
        const errors: pages.SignupState["errors"] = {};
        if (!email) errors.email = "Enter your email address.";
        else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errors.email = "Enter a valid email address, like name@example.com.";
        } else if (store.userByEmail(email)) {
          errors.email = "An account with this email already exists.";
        }
        if (password.length < 8) errors.password = "Password must be at least 8 characters.";
        if (errors.email || errors.password) {
          return html(res, 400, pages.signupPage(ctx(req), { email, plan, errors }));
        }
        if (bugs.signupCrashes) {
          const message = "We couldn't create your account. Please try again later.";
          return html(res, 500, pages.errorPage(ctx(req), "Something went wrong", message));
        }
        sendVerification(store.createUser(email, password));
        const query = new URLSearchParams({ email, ...(plan ? { plan } : {}) });
        return redirect(res, `/verify?${query}`);
      }

      case "GET /verify": {
        const email = url.searchParams.get("email") ?? "";
        const plan = findPlan(url.searchParams.get("plan"))?.id ?? null;
        return html(res, 200, pages.verifyPage(ctx(req), { email, plan }));
      }

      case "POST /verify": {
        const data = form(req);
        const email = data.get("email") ?? "";
        const plan = findPlan(data.get("plan"))?.id ?? null;
        const user = store.userByEmail(email);
        const code = (data.get("code") ?? "").replace(/\s/g, "");
        if (!user || code !== verificationCode(user.email)) {
          const error = "That code isn't right. Check the email and try again.";
          return html(res, 400, pages.verifyPage(ctx(req), { email, plan, error }));
        }
        user.verified = true;
        const session = store.startSession(user);
        const next = plan ? `/checkout?plan=${plan}` : "/dashboard";
        return redirect(res, next, { "set-cookie": sessionCookie(session) });
      }

      case "GET /login": {
        if (req.user) return redirect(res, "/dashboard");
        const next = safeNext(url.searchParams.get("next"));
        return html(res, 200, pages.loginPage(ctx(req), { email: "", next }));
      }

      case "POST /login": {
        const data = form(req);
        const email = (data.get("email") ?? "").trim();
        const next = safeNext(data.get("next"));
        const user = store.userByEmail(email);
        if (!user || user.password !== (data.get("password") ?? "")) {
          const error = "Email or password is incorrect.";
          return html(res, 401, pages.loginPage(ctx(req), { email, next, error }));
        }
        if (!user.verified) {
          sendVerification(user);
          return redirect(res, `/verify?${new URLSearchParams({ email: user.email })}`);
        }
        if (bugs.loginRedirectsToError) return redirect(res, "/error?reason=login");
        return redirect(res, next, { "set-cookie": sessionCookie(store.startSession(user)) });
      }

      case "GET /error":
        return html(
          res,
          500,
          pages.errorPage(
            ctx(req),
            "Something went wrong",
            "We couldn't sign you in. Please try again later.",
          ),
        );

      case "POST /logout":
        if (req.sessionId) store.sessions.delete(req.sessionId);
        return redirect(res, "/", { "set-cookie": sessionCookie(null) });

      case "GET /dashboard": {
        if (!requireUser(req, res)) return;
        const welcome = findPlan(url.searchParams.get("welcome"));
        return html(res, 200, pages.dashboardPage(ctx(req), welcome));
      }

      case "GET /api/projects": {
        const user = requireApiUser(req);
        if (projectsApiDown()) throw new HttpError(503, "Service unavailable");
        return json(res, 200, { projects: store.projectsOf(user) });
      }

      case "POST /api/projects": {
        const user = requireApiUser(req);
        if (projectsApiDown()) throw new HttpError(503, "Service unavailable");
        const name = str(jsonBody<{ name: string }>(req).name).trim();
        if (!name) throw new HttpError(400, "Enter a project name.");
        if (name.length > 60) throw new HttpError(400, "Use 60 characters or fewer.");
        const project = store.addProject(user, name);
        if (!bugs.projectsNotSaved) store.saveProject(project);
        return json(res, 201, { project });
      }

      case "GET /checkout": {
        if (!requireUser(req, res)) return;
        const plan = findPlan(url.searchParams.get("plan"));
        if (!plan) return redirect(res, "/pricing");
        return html(res, 200, pages.checkoutPage(ctx(req), plan));
      }

      case "GET /pay/frame":
        return html(res, 200, pages.payFramePage());

      case "POST /pay/tokens": {
        const body = jsonBody<{ number: string; expiry: string; cvc: string }>(req);
        const number = str(body.number).replace(/\s/g, "");
        const error = cardError(number, str(body.expiry), str(body.cvc));
        if (error) throw new HttpError(400, error);
        return json(res, 200, { token: store.tokenizeCard(number) });
      }

      case "POST /api/subscribe": {
        const user = requireApiUser(req);
        const body = jsonBody<{ plan: string; token: string }>(req);
        const plan = findPlan(str(body.plan));
        const card = store.cardTokens.get(str(body.token));
        if (!plan || !card) throw new HttpError(400, "Your payment details are incomplete.");
        if (card === DECLINED_CARD) throw new HttpError(402, "Your card was declined.");
        store.startTrial(user, plan.id);
        return json(res, 200, { redirect: `/dashboard?welcome=${plan.id}` });
      }

      case "GET /billing":
        if (!requireUser(req, res)) return;
        return html(res, 200, pages.billingPage(ctx(req)));

      case "GET /settings":
        if (!requireUser(req, res)) return;
        return html(res, 200, pages.settingsPage(ctx(req)));

      case "POST /api/profile": {
        const user = requireApiUser(req);
        const body = jsonBody<{ name: string; timezone: string }>(req);
        const name = str(body.name).trim();
        const timezone = str(body.timezone);
        if (!name) throw new HttpError(400, "Enter your name.");
        if (!(TIMEZONES as readonly string[]).includes(timezone)) {
          throw new HttpError(400, "Choose a time zone from the list.");
        }
        user.name = name;
        user.timezone = timezone;
        return json(res, 200, { name, timezone });
      }

      case "POST /api/avatar": {
        const user = requireApiUser(req);
        if (req.body.length === 0) throw new HttpError(400, "Choose an image first.");
        if (req.body.length > MAX_AVATAR) throw new HttpError(413, "Use an image under 1 MB.");
        const type = imageType(req.body);
        if (!type || type !== req.contentType) throw new HttpError(400, "Use a PNG or JPEG image.");
        const version = (user.avatar?.version ?? 0) + 1;
        user.avatar = { type, data: req.body, version };
        return json(res, 200, { src: `/avatar?v=${version}` });
      }

      case "GET /avatar": {
        const avatar = req.user?.avatar;
        if (!avatar) throw new HttpError(404, "No avatar");
        return send(res, 200, avatar.data, { "content-type": avatar.type });
      }

      case "POST /settings/delete": {
        const user = requireApiUser(req);
        store.deleteUser(user);
        return redirect(res, "/?deleted=1", { "set-cookie": sessionCookie(null) });
      }

      case "GET /orders": {
        const user = requireUser(req, res);
        if (!user) return;
        return html(res, 200, pages.ordersPage(ctx(req), store.ordersOf(user)));
      }

      // Test hooks (AUT-10). Always on: this is a fixture, not a product.
      case "POST /__test/reset":
        store.reset();
        if (url.searchParams.get("environment") === "1") flaky = { requests: 0, failures: 0 };
        return json(res, 200, { ok: true });

      case "POST /__test/seed": {
        const body = jsonBody<SeedInput>(req);
        const input: SeedInput = {};
        if (body.email !== undefined) input.email = str(body.email);
        if (body.password !== undefined) input.password = str(body.password);
        if (body.name !== undefined) input.name = str(body.name);
        if (body.trial !== undefined) {
          if (!findPlan(str(body.trial))) throw new HttpError(400, "Unknown plan for trial");
          input.trial = str(body.trial);
        }
        if (body.projects !== undefined) {
          if (!Array.isArray(body.projects)) throw new HttpError(400, "projects must be a list");
          input.projects = body.projects.map(str);
        }
        const user = store.seed(input);
        return json(res, 201, {
          user: { email: user.email, password: user.password, name: user.name },
        });
      }

      case "GET /__test/outbox": {
        const to = url.searchParams.get("to")?.toLowerCase();
        const emails = store.outbox.filter((mail) => !to || mail.to === to);
        return json(res, 200, { emails });
      }

      case "GET /__test/state":
        return json(res, 200, {
          variant,
          users: store.users.map((user) => ({
            email: user.email,
            verified: user.verified,
            plan: user.subscription?.planId ?? null,
            projects: store.projectsOf(user).map((p) => p.name),
          })),
        });
    }
    throw new HttpError(404, "Not found");
  }

  const server = createServer((incoming, res) => {
    const handle = async () => {
      const url = new URL(incoming.url ?? "/", `http://${HOST}`);
      const method = incoming.method ?? "GET";
      const sessionId = readCookie(incoming.headers.cookie);
      const body = method === "POST" ? await readBody(incoming) : Buffer.alloc(0);
      const contentType = (incoming.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
      const user = store.userBySession(sessionId);
      await route({ method, url, user, sessionId, body, contentType }, res);
    };
    handle().catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "Internal error";
      if (!(error instanceof HttpError)) process.stderr.write(`acme-shop: ${String(error)}\n`);
      if (res.headersSent) return void res.end();
      const wantsJson =
        incoming.url?.startsWith("/api/") ||
        incoming.url?.startsWith("/pay/tokens") ||
        incoming.url?.startsWith("/__test/");
      if (wantsJson) return json(res, status, { error: message });
      const user = store.userBySession(readCookie(incoming.headers.cookie));
      const title = status === 404 ? "Page not found" : "Something went wrong";
      const page = pages.errorPage({ s, bugs, user, path: "" }, title, message);
      return html(res, status, page);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, HOST, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;

  return {
    url: `http://${HOST}:${port}`,
    variant,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
