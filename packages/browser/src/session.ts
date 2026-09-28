import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { brand } from "@testament/brand";
import { defaultRedactor, Redactor } from "@testament/config/node";
// RESTRICTED import: the browser driver types secrets into allowed domains (SEC-1).
import { prepareSecret, revealSecret } from "@testament/config/reveal";
import type { CheckOp } from "@testament/recording";
import type {
  Browser,
  BrowserContext,
  Dialog,
  Download,
  ElementHandle,
  Frame,
  Locator,
  Page,
  Request,
} from "playwright";
import { Allowlist, isBlank, isHttp, parseUrl } from "./allowlist.js";
import {
  type CheckEvaluation,
  type CheckOptions,
  copyPage,
  evaluateCheck,
  type PageCopy,
  RequestMark,
} from "./check.js";
import { deviceOptions } from "./devices.js";
import { Evidence } from "./evidence.js";
import { BrowserSetupError, browserOf, type LaunchedBrowser, launchBrowser } from "./launch.js";
import {
  candidateSpecs,
  FACT_ATTRIBUTES,
  type RawFacts,
  readFacts,
  toFacts,
  toLocator,
} from "./locators.js";
import {
  type AriaNode,
  buildObservation,
  diffElements,
  type RefTarget,
  reorderedElements,
} from "./observe.js";
import { basicAuthValue, HeaderScope, type ScopedHeader } from "./protected-headers.js";
import { type RefusalProxy, startRefusalProxy } from "./refusal-proxy.js";
import { ActivityTracker, DEFAULT_SETTLE, mutationScript } from "./settle.js";
import type {
  Action,
  ActionOutcome,
  ActOptions,
  BrowserName,
  CandidatesResult,
  CloseOptions,
  CloseResult,
  DialogSummary,
  ElementFacts,
  HookRequest,
  HookResult,
  InspectResult,
  LocatorCandidate,
  LocatorSpec,
  Observation,
  ObservedElement,
  OutcomeStatus,
  PostState,
  Refusal,
  RefusalReason,
  RefusalType,
  ScreenshotOptions,
  ScreenshotResult,
  SessionOptions,
  SettleOptions,
  SettleResult,
  StorageState,
  Target,
} from "./types.js";

const ACTION_TIMEOUT_MS = 5_000;
/** Storage values shorter than this aren't scrubbed (a "1" would scrub every 1), as in @testament/auth. */
const MIN_STATE_VALUE = 6;
const NAVIGATION_TIMEOUT_MS = 30_000;
const MODEL_MAX_WIDTH = 1280;
const MAX_ELEMENTS = 400;
/** How long `act(…, { until })` looks for the effect before settling as usual. */
const DEFAULT_EFFECT_CEILING_MS = 3_000;
const EFFECT_POLL_MS = 20;
/** Browser-internal error pages shown when a navigation fails. Not a visit to another site. */
const ERROR_PAGE = /^(chrome-error:|about:neterror|about:certerror)/;

interface Result {
  status: OutcomeStatus;
  reason?: RefusalReason;
  message?: string;
}

const ok: Result = { status: "ok" };
const refused = (reason: RefusalReason, message: string): Result => ({
  status: "refused",
  reason,
  message,
});
const notFound = (message: string): Result => ({ status: "not_found", message });

function errorResult(error: unknown): Result {
  const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
  if (error instanceof Error && error.name === "TimeoutError")
    return { status: "timeout", message };
  return { status: "error", message };
}

type Resolved = { locator: Locator } | { result: Result };

/**
 * A browser session for one test: a fresh, isolated context behind the network
 * guard, offering only the closed action set. It never exposes Playwright objects.
 */
export class Session {
  readonly #browser: LaunchedBrowser;
  readonly #ownsBrowser: boolean;
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #proxy: RefusalProxy;
  readonly #allowlist: Allowlist;
  readonly #options: SessionOptions;
  readonly #redact: (text: string) => string;
  /** Knows every secret of the session, and every code a dynamic secret (TOTP) typed. */
  readonly #secretRedactor: Redactor;
  readonly #tracker: ActivityTracker;
  readonly #evidence: Evidence;
  readonly #refusals: Refusal[] = [];
  readonly #refusedRequests: WeakSet<Request>;
  /** Protected-preview headers (SEC-8), only for allowed hosts in each secret's domains. */
  readonly #headers: HeaderScope;
  readonly #dialogs: DialogSummary[] = [];
  readonly #popups: string[] = [];
  readonly #secretAttribute = `data-s${randomBytes(4).toString("hex")}`;
  #refs = new Map<string, RefTarget>();
  #observation: Observation | undefined;
  #refusalCursor = 0;
  #violation: string | undefined;
  #crashed = false;
  #closed: CloseResult | undefined;
  #helper: Page | undefined;
  /** A screenshot still being taken: the next action waits for it (a navigation would stall it). */
  #shooting: Promise<unknown> | undefined;
  /** Set when the last action ended on its effect (no quiet window yet): when it did. */
  #unsettledSince: number | undefined;

  private constructor(init: {
    browser: LaunchedBrowser;
    ownsBrowser: boolean;
    context: BrowserContext;
    page: Page;
    proxy: RefusalProxy;
    allowlist: Allowlist;
    options: SessionOptions;
    redact: (text: string) => string;
    secretRedactor: Redactor;
    tracker: ActivityTracker;
    evidence: Evidence;
    refusedRequests: WeakSet<Request>;
    headers: HeaderScope;
  }) {
    this.#refusedRequests = init.refusedRequests;
    this.#headers = init.headers;
    this.#browser = init.browser;
    this.#ownsBrowser = init.ownsBrowser;
    this.#context = init.context;
    this.#page = init.page;
    this.#proxy = init.proxy;
    this.#allowlist = init.allowlist;
    this.#options = init.options;
    this.#redact = init.redact;
    this.#secretRedactor = init.secretRedactor;
    this.#tracker = init.tracker;
    this.#evidence = init.evidence;
  }

  /** @internal Use `openSession`. */
  static async open(options: SessionOptions): Promise<Session> {
    const allowlist = new Allowlist(options.allowedDomains);
    if (allowlist.invalid.length > 0) {
      throw new BrowserSetupError(
        `Invalid allowed domains: ${allowlist.invalid.join(", ")}.`,
        "Use host names like example.com, *.example.com or example.com:8080.",
      );
    }
    if (options.baseUrl !== undefined && !parseUrl(options.baseUrl)) {
      throw new BrowserSetupError(`Invalid baseUrl "${options.baseUrl}".`, "Use an http(s) URL.");
    }
    const browserName: BrowserName =
      typeof options.browser === "string" || options.browser === undefined
        ? (options.browser ?? "chromium")
        : options.browser.name;
    // Validates the device preset before anything is started.
    const device = deviceOptions(options.device, browserName, options.viewport);

    // Scrubbing: the session's own redactor (every secret it may type) then the caller's.
    const own = new Redactor();
    for (const secret of Object.values(options.secrets ?? {})) {
      own.register(revealSecret(secret), secret.label);
    }
    // A saved login's cookies and storage are scrubbed like secrets (SEC-3).
    for (const cookie of options.storageState?.cookies ?? [])
      if (cookie.value.length >= MIN_STATE_VALUE) own.register(cookie.value, "[session]");
    for (const origin of options.storageState?.origins ?? [])
      for (const item of origin.localStorage)
        if (item.value.length >= MIN_STATE_VALUE) own.register(item.value, "[session]");
    const headers = new HeaderScope(protectedHeaders(options, own), allowlist);
    const outer = options.redact ?? ((text: string) => defaultRedactor.redact(text));
    const redact = (text: string) => outer(own.redact(text));

    const ownsBrowser = typeof options.browser !== "object";
    const launched =
      typeof options.browser === "object"
        ? options.browser
        : await launchBrowser({ browser: browserName, headless: options.headless ?? true });

    const evidenceDir =
      options.evidence?.dir ?? mkdtempSync(join(tmpdir(), `${brand.cliName}-evidence-`));
    mkdirSync(evidenceDir, { recursive: true });
    const evidence = new Evidence(options.evidence ?? {}, evidenceDir, redact);

    let pending: { at: (refusal: Omit<Refusal, "at">) => void } | undefined;
    const proxy = await startRefusalProxy((target) => {
      pending?.at({ url: target, type: "proxy", frame: "" });
    });

    let context: BrowserContext;
    try {
      context = await browserOf(launched).newContext({
        ...device,
        ...(options.locale ? { locale: options.locale } : {}),
        ...(options.timezone ? { timezoneId: options.timezone } : {}),
        ...(options.storageState ? { storageState: options.storageState } : {}),
        ...evidence.contextOptions(),
        serviceWorkers: "block",
        acceptDownloads: false,
        permissions: [],
        proxy: { server: proxy.server, bypass: allowlist.proxyBypass() },
      });
    } catch (error) {
      await proxy.close();
      if (ownsBrowser) await launched.close();
      throw new BrowserSetupError(
        `Could not open a browser context: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        "Check the session options (device, locale, timezone).",
      );
    }

    const refusedRequests = new WeakSet<Request>();
    const tracker = new ActivityTracker(context, redact, (request) => refusedRequests.has(request));
    const page = await context.newPage();
    const created = new Session({
      browser: launched,
      ownsBrowser,
      context,
      page,
      proxy,
      allowlist,
      options,
      redact,
      secretRedactor: own,
      tracker,
      evidence,
      refusedRequests,
      headers,
    });
    pending = { at: (refusal) => created.#refuse(refusal) };
    await created.#install();
    return created;
  }

  // ── setup ──────────────────────────────────────────────────────────────────

  async #install(): Promise<void> {
    const context = this.#context;
    const page = this.#page;

    // Layer 1: every request Playwright can see (all frames, popups, fetch/XHR, subresources).
    await context.route("**/*", async (route, request) => {
      if (this.#allowlist.allowsUrl(request.url())) {
        const headers = this.#headers.apply(request.url(), request.headers());
        await route.continue(headers ? { headers } : undefined).catch(() => {});
        return;
      }
      const type = this.#classify(request);
      this.#refusedRequests.add(request);
      this.#refuse({ url: request.url(), type, frame: this.#frameUrlOf(request) });
      // A cancelled navigation leaves the page where it was; "blocked" would show an error page.
      const navigation = type === "navigation" || type === "popup" || type === "iframe";
      await route.abort(navigation ? "aborted" : "blockedbyclient").catch(() => {});
      if (type === "popup") await this.#closeRefusedPopups(request.url());
    });
    await context.routeWebSocket(
      (url) => !this.#allowsSocket(url),
      (socket) => {
        this.#refuse({ url: socket.url(), type: "websocket", frame: "" });
        socket
          .close({ code: 1008, reason: "Blocked: host not in allowed domains." })
          .catch(() => {});
      },
    );

    // Settle: DOM activity reported by every frame.
    const binding = `__s${randomBytes(6).toString("hex")}`;
    await context.exposeBinding(binding, (source, busy: unknown) => {
      this.#tracker.mutated(source.frame, busy === true);
    });
    await context.addInitScript({ content: mutationScript(binding) });

    context.on("page", (other) => {
      if (other === page) return;
      this.#evidence.watch(other);
      other.once("framenavigated", (frame) => {
        if (frame === other.mainFrame()) this.#popups.push(this.#redact(frame.url()));
      });
    });

    this.#evidence.watch(page);
    page.on("dialog", (dialog: Dialog) => this.#onDialog(dialog));
    page.on("download", (download: Download) => {
      this.#refuse({ url: download.url(), type: "download", frame: page.url() });
      download.cancel().catch(() => {});
    });
    page.on("crash", () => {
      this.#crashed = true;
    });
    page.on("framedetached", (frame) => this.#tracker.frameGone(frame));
    // Layer 3: the main frame must never show a page outside the allowlist.
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (isBlank(url) || ERROR_PAGE.test(url) || this.#allowlist.allowsUrl(url)) return;
      const parsed = parseUrl(url);
      this.#refuse({ url, type: parsed && isHttp(parsed) ? "navigation" : "scheme", frame: "" });
      this.#violation = url;
      page.goto("about:blank").catch(() => {});
    });

    await this.#evidence.start(context);
  }

  #classify(request: Request): RefusalType {
    if (request.serviceWorker()) return "service_worker";
    let frame: Frame;
    try {
      frame = request.frame();
    } catch {
      // A navigation whose frame doesn't exist yet: the first load of a new window.
      return request.isNavigationRequest() ? "popup" : "subresource";
    }
    if (request.isNavigationRequest()) {
      if (frame.parentFrame()) return "iframe";
      return frame.page() === this.#page ? "navigation" : "popup";
    }
    const type = request.resourceType();
    if (type === "fetch" || type === "xhr" || type === "eventsource") return "fetch";
    if (type === "websocket") return "websocket";
    return "subresource";
  }

  #frameUrlOf(request: Request): string {
    try {
      return request.frame().url();
    } catch {
      return "";
    }
  }

  /** Closes windows that never got past a refused first load. */
  async #closeRefusedPopups(url: string): Promise<void> {
    for (const other of this.#context.pages()) {
      if (other === this.#page) continue;
      const current = other.url();
      if (isBlank(current) || current === url || ERROR_PAGE.test(current)) {
        await other.close().catch(() => {});
      }
    }
  }

  #allowsSocket(url: URL): boolean {
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
    const port = url.port ? Number(url.port) : url.protocol === "wss:" ? 443 : 80;
    return this.#allowlist.allowsHost(url.hostname, port);
  }

  #refuse(refusal: Omit<Refusal, "at">): void {
    this.#refusals.push({
      url: this.#redact(refusal.url),
      type: refusal.type,
      frame: this.#redact(refusal.frame),
      at: new Date().toISOString(),
    });
  }

  #onDialog(dialog: Dialog): void {
    const type = dialog.type();
    const accept =
      type === "alert" || type === "beforeunload" || this.#options.nativeDialogs === "accept";
    this.#dialogs.push({
      type,
      message: this.#redact(dialog.message()),
      handled: accept ? "accepted" : "dismissed",
    });
    (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /** Engine this session runs on. */
  get browserName(): BrowserName {
    return this.#browser.name;
  }

  /** Current URL of the page (scrubbed). */
  get url(): string {
    return this.#redact(this.#page.isClosed() ? "" : this.#page.url());
  }

  /**
   * Sends a setup/teardown request (AUT-10) with the session's cookies, through
   * Playwright's request context. Allowlisted, no redirects followed. Not part
   * of the action set: the agent has no tool for it.
   */
  async hookRequest(request: HookRequest): Promise<HookResult> {
    if (this.#unusable()) return { status: "error", message: "The session is closed." };
    let url: URL;
    try {
      url = this.#options.baseUrl
        ? new URL(request.target, this.#options.baseUrl)
        : new URL(request.target);
    } catch {
      return {
        status: "refused",
        reason: "invalid_action",
        message: `"${request.target}" is not a valid URL.`,
      };
    }
    if (!this.#allowlist.allowsUrl(url)) {
      this.#refuse({ url: url.href, type: "fetch", frame: "" });
      return {
        status: "refused",
        reason: "disallowed_domain",
        message: this.#redact(`${url.host || url.protocol} is not in the allowed domains.`),
      };
    }
    const headers = this.#headers.apply(url, request.headers ?? {}) ?? request.headers;
    try {
      const response = await this.#context.request.fetch(url.href, {
        method: request.method,
        ...(request.body !== undefined ? { data: request.body as never } : {}),
        ...(headers ? { headers } : {}),
        maxRedirects: 0,
        timeout: request.timeoutMs ?? NAVIGATION_TIMEOUT_MS,
      });
      const httpStatus = response.status();
      if (response.ok()) return { status: "ok", httpStatus };
      const body = (await response.text().catch(() => "")).slice(0, 300);
      return {
        status: "failed",
        httpStatus,
        message: this.#redact(
          `${request.method} ${url.pathname} answered ${httpStatus}${body ? `: ${body}` : ""}`,
        ),
      };
    } catch (error) {
      return {
        status: "error",
        message: this.#redact(errorResult(error).message ?? "request failed"),
      };
    }
  }

  /** Every refusal so far. */
  refusals(): Refusal[] {
    return [...this.#refusals];
  }

  /** The page as untrusted data, with fresh refs (the previous refs stop working). */
  async observe(): Promise<Observation> {
    const refused = this.#refusals.slice(this.#refusalCursor);
    this.#refusalCursor = this.#refusals.length;
    const empty = (): Observation => ({
      untrusted: true,
      url: this.url,
      title: "",
      observedAt: new Date().toISOString(),
      frames: [{ url: this.url, parentRef: null }],
      elements: [],
      refused,
      truncated: false,
    });
    this.#refs = new Map();
    const snapshot = this.#unusable() ? undefined : await this.#snapshot();
    if (!snapshot) {
      this.#observation = empty();
      return this.#observation;
    }
    const built = buildObservation(snapshot.nodes, {
      url: this.#page.url(),
      title: snapshot.title,
      observedAt: new Date().toISOString(),
      refused,
      maxElements: this.#options.maxElements ?? MAX_ELEMENTS,
      redact: this.#redact,
      frameInfo: (ariaRef) => snapshot.frames.get(ariaRef) ?? { url: "", title: "" },
      sortStates: snapshot.sorts,
    });
    this.#refs = built.refs;
    this.#observation = built.observation;
    return built.observation;
  }

  /** Ranked locators for a ref from the latest observation, plus element facts. */
  async candidates(ref: string): Promise<CandidatesResult> {
    const none: CandidatesResult = { status: "not_found", candidates: [], facts: null };
    const target = this.#refs.get(ref);
    if (!target || this.#unusable()) return none;
    try {
      const locator = this.#page.locator(`aria-ref=${target.ariaRef}`);
      if ((await locator.count()) !== 1) return none;
      const framePath = await this.#framePath(target.frame, 0);
      const raw = this.#scrubFacts(
        await locator.evaluate(readFacts, FACT_ATTRIBUTES, { timeout: ACTION_TIMEOUT_MS }),
      );
      const box = await locator.boundingBox({ timeout: ACTION_TIMEOUT_MS }).catch(() => null);
      const candidates: LocatorCandidate[] = [];
      for (const spec of candidateSpecs(target.element, raw, framePath)) {
        const matches = await toLocator(this.#page, spec)
          .count()
          .catch(() => 0);
        candidates.push({ locator: spec, unique: matches === 1, matches });
      }
      return { status: "ok", candidates, facts: toFacts(target.element, raw, framePath, box) };
    } catch {
      return none;
    }
  }

  /**
   * What a locator finds right now: how many elements, and the facts of the one
   * element when it is unique (LOOP-4 validates them against the recorded
   * fingerprint before acting). Read-only; not an action.
   */
  async inspect(target: LocatorSpec): Promise<InspectResult> {
    if (this.#unusable())
      return { status: "error", matches: 0, facts: null, message: "The page is closed." };
    let locator: Locator;
    try {
      locator = toLocator(this.#page, target);
    } catch (error) {
      return {
        status: "error",
        matches: 0,
        facts: null,
        message: errorResult(error).message ?? "",
      };
    }
    let matches: number;
    try {
      matches = await locator.count();
    } catch {
      matches = 0;
    }
    if (matches === 0) return { status: "not_found", matches, facts: null };
    if (matches > 1) return { status: "multiple", matches, facts: null };
    try {
      const facts = await this.#factsOfLocator(locator, target.frame ?? [], undefined);
      return facts
        ? { status: "ok", matches, facts }
        : { status: "not_found", matches: 0, facts: null };
    } catch (error) {
      return { status: "error", matches, facts: null, message: errorResult(error).message ?? "" };
    }
  }

  /**
   * Facts of an element from the latest observation, without ranking locators
   * (cheaper than `candidates`; LOOP-4 uses it to re-find an element over the page).
   */
  async factsOf(ref: string): Promise<ElementFacts | null> {
    const target = this.#refs.get(ref);
    if (!target || this.#unusable()) return null;
    try {
      const locator = this.#page.locator(`aria-ref=${target.ariaRef}`);
      if ((await locator.count()) !== 1) return null;
      const framePath = await this.#framePath(target.frame, 0);
      return await this.#factsOfLocator(locator, framePath, target.element);
    } catch {
      return null;
    }
  }

  async #factsOfLocator(
    locator: Locator,
    framePath: readonly LocatorSpec[],
    element: ObservedElement | undefined,
  ): Promise<ElementFacts | null> {
    const raw = this.#scrubFacts(
      await locator.evaluate(readFacts, FACT_ATTRIBUTES, { timeout: ACTION_TIMEOUT_MS }),
    );
    const box = await locator.boundingBox({ timeout: ACTION_TIMEOUT_MS }).catch(() => null);
    const identity = element ?? (await this.#identityOf(locator));
    return toFacts(identity, raw, [...framePath], box);
  }

  /** Role and accessible name of an element found by a locator (from its own aria snapshot). */
  async #identityOf(locator: Locator): Promise<{ role: string; name: string }> {
    const nodes = (await locator
      .ariaSnapshotJSON({ mode: "ai", timeout: ACTION_TIMEOUT_MS })
      .catch(() => [])) as unknown as Array<AriaNode | string>;
    const first = nodes.find((n): n is AriaNode => typeof n !== "string");
    return {
      role: first?.role ?? "generic",
      name: this.#redact((first?.name ?? "").replace(/\s+/g, " ").trim()),
    };
  }

  /**
   * Performs one action from the closed set and reports what changed. With
   * `until` (replay's learned wait, LRN-4) the action is done the moment its
   * expected effect shows with no request in flight; otherwise, or when the
   * effect doesn't show within `ceilingMs`, the page settles as usual.
   */
  async act(action: Action, options: ActOptions = {}): Promise<ActionOutcome> {
    if (this.#shooting) await this.#shooting;
    const urlBefore = this.url;
    const before = this.#unusable() ? [] : ((await this.#snapshotElements()) ?? []);
    const requestMark = this.#tracker.mark();
    const refusalMark = this.#refusals.length;
    const dialogMark = this.#dialogs.length;
    const popupMark = this.#popups.length;
    this.#violation = undefined;
    this.#unsettledSince = undefined;

    const started = Date.now();
    let result: Result;
    if (this.#crashed) result = { status: "error", message: "The page crashed." };
    else if (this.#page.isClosed() || this.#closed) {
      result = { status: "error", message: "The page is closed." };
    } else {
      try {
        result = await this.#perform(action);
      } catch (error) {
        result = errorResult(error);
      }
    }
    const ms = Date.now() - started;

    const postOf = (after: ObservedElement[]): PostState => {
      const { added, removed } = diffElements(before, after);
      // A page dialog's message: its name, else the first heading inside it.
      const pageDialogs = added.flatMap((e, i) => {
        if (e.role !== "dialog" && e.role !== "alertdialog") return [];
        const heading = added.slice(i + 1).find((next) => next.role === "heading");
        return [{ type: e.role, message: e.name || heading?.name || "" }];
      });
      const dialogs = [...this.#dialogs.slice(dialogMark), ...pageDialogs];
      const requests = this.#tracker.requestsSince(requestMark);
      const popups = this.#popups.slice(popupMark);
      const urlAfter = this.url;
      return {
        urlBefore,
        urlAfter,
        added,
        removed,
        requests,
        dialogs,
        popups,
        refused: this.#refusals.slice(refusalMark),
        changed:
          urlBefore !== urlAfter ||
          added.length > 0 ||
          removed.length > 0 ||
          requests.some((r) => r.status !== "refused") ||
          dialogs.length > 0 ||
          popups.length > 0,
        reordered: added.length === 0 && removed.length === 0 && reorderedElements(before, after),
      };
    };

    let settle: SettleResult | undefined;
    let post: PostState | undefined;
    if (this.#unusable()) {
      settle = {
        settledMs: 0,
        timedOut: false,
        waitedFor: { network: 0, dom: 0, busy: 0 },
        inflight: 0,
      };
    } else if (options.until && result.status === "ok") {
      // LRN-4: look for the expected effect as the page builds up; move on the moment it shows.
      const from = Date.now();
      const ceiling = options.ceilingMs ?? DEFAULT_EFFECT_CEILING_MS;
      const waitedFor = { network: 0, dom: 0, busy: 0 };
      for (;;) {
        const lap = Date.now();
        const now = postOf((await this.#snapshotElements()) ?? []);
        const quiet = this.#tracker.inflight === 0;
        if (quiet && options.until(now)) {
          post = now;
          settle = {
            settledMs: Date.now() - from,
            timedOut: false,
            waitedFor,
            inflight: 0,
            endedBy: "effect",
          };
          // The page may still be busy: a later settle counts its quiet from here.
          this.#unsettledSince = from;
          break;
        }
        if (Date.now() - from >= ceiling || this.#unusable()) break;
        await sleep(EFFECT_POLL_MS);
        if (!quiet) waitedFor.network += Date.now() - lap;
      }
    }
    if (!settle) {
      const since = Date.now();
      settle = this.#unusable()
        ? { settledMs: 0, timedOut: false, waitedFor: { network: 0, dom: 0, busy: 0 }, inflight: 0 }
        : await this.#tracker.settle({ ...(this.#options.settle ?? DEFAULT_SETTLE) });
      if (options.until)
        settle = { ...settle, settledMs: settle.settledMs + (since - started - ms) };
    }
    if (!post) post = postOf(this.#unusable() ? [] : ((await this.#snapshotElements()) ?? []));

    const refusedNow = post.refused;
    const leftAllowlist =
      this.#violation !== undefined ||
      refusedNow.some((r) => r.type === "navigation" || r.type === "scheme");
    if (leftAllowlist && result.status !== "refused") {
      result = refused(
        "disallowed_domain",
        `The page tried to leave the allowed domains (${refusedNow.find((r) => r.type === "navigation" || r.type === "scheme")?.url ?? this.#violation}).`,
      );
    }
    const outcome: ActionOutcome = {
      action: this.#scrubAction(action),
      status: result.status,
      ms,
      settledMs: settle.settledMs,
      settle,
      post,
    };
    if (result.reason) outcome.reason = result.reason;
    if (result.message !== undefined) outcome.message = this.#redact(result.message);
    return outcome;
  }

  /**
   * Waits until the page is quiet (see settle.ts). After an action that ended
   * on its effect, the quiet window counts from when that action finished.
   */
  async settle(options: SettleOptions = {}): Promise<SettleResult> {
    const since = this.#unsettledSince;
    this.#unsettledSince = undefined;
    if (this.#unusable()) {
      return {
        settledMs: 0,
        timedOut: false,
        waitedFor: { network: 0, dom: 0, busy: 0 },
        inflight: 0,
      };
    }
    return this.#tracker.settle({
      ...DEFAULT_SETTLE,
      ...this.#options.settle,
      ...options,
      ...(since !== undefined ? { since } : {}),
    });
  }

  /** True when the last action ended on its effect and the page hasn't settled since. */
  get unsettled(): boolean {
    return this.#unsettledSince !== undefined;
  }

  /**
   * A screenshot: JPEG ≤ 1280 px wide for a model, or full-resolution PNG (or
   * JPEG) evidence. It may run while the caller reads the page (checks,
   * inspect); the next action waits for it.
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const taking = this.#takeScreenshot(options);
    const settled = taking.then(
      () => {},
      () => {},
    );
    this.#shooting = settled;
    void settled.then(() => {
      if (this.#shooting === settled) this.#shooting = undefined;
    });
    return taking;
  }

  async #takeScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const forModel = options.forModel ?? false;
    const jpeg = forModel || options.format === "jpeg";
    const contentType = jpeg ? "image/jpeg" : "image/png";
    const fail = (status: "not_found" | "error", message: string): ScreenshotResult => ({
      status,
      bytes: new Uint8Array(),
      contentType,
      message,
    });
    if (this.#unusable()) return fail("error", "The page is closed or crashed.");
    const shot = {
      type: jpeg ? ("jpeg" as const) : ("png" as const),
      ...(jpeg ? { quality: forModel ? 70 : 80 } : {}),
      scale: forModel ? ("css" as const) : ("device" as const),
      style: `[${this.#secretAttribute}] { color: transparent !important; text-shadow: none !important; }`,
      timeout: ACTION_TIMEOUT_MS,
    };
    try {
      let bytes: Buffer;
      if (options.target) {
        const resolved = await this.#resolve(options.target);
        if ("result" in resolved) return fail("not_found", resolved.result.message ?? "not found");
        bytes = await resolved.locator.screenshot(shot);
      } else {
        bytes = await this.#page.screenshot(shot);
      }
      if (forModel) bytes = await this.#downscale(bytes);
      return { status: "ok", bytes: new Uint8Array(bytes), contentType };
    } catch (error) {
      return fail("error", this.#redact(errorResult(error).message ?? ""));
    }
  }

  /**
   * Evaluates a typed check (LOOP-2) with auto-waiting, on the page, an empty
   * page or a `pageCopy()`. Read-only; not an agent action (see check.ts).
   */
  async check(op: CheckOp, options: CheckOptions = {}): Promise<CheckEvaluation> {
    return evaluateCheck(op, options, {
      page: this.#page,
      browser: browserOf(this.#browser),
      redact: this.#redact,
      mark: () => this.#tracker.mark(),
      requestsSince: (mark) => this.#tracker.requestsSince(mark),
      unusable: () => this.#unusable(),
    });
  }

  /** Marks where a step begins, for `check(op, { since: mark })` on network checks. Cheap. */
  requestMark(): RequestMark {
    return RequestMark.create(this.#tracker.mark());
  }

  /**
   * A static, script-free copy of the page as it is now, for `check(op, { on: copy })`
   * (VER-6). It also marks where a step began, for `check(op, { since: copy })`.
   */
  async pageCopy(): Promise<PageCopy> {
    return copyPage(this.#page, {
      redact: this.#redact,
      secretAttribute: this.#secretAttribute,
      requestMark: this.#tracker.mark(),
    });
  }

  /**
   * The session's cookies and local storage (Playwright storage state), so a
   * login flow's result can be saved (SEC-3). Not an agent action. Every value
   * is registered with the session's redactor, so no evidence, outcome or log
   * of this session can show it; callers must never log the result.
   */
  async storageState(): Promise<StorageState> {
    const state = (await this.#context.storageState()) as StorageState;
    this.#registerState(state);
    return state;
  }

  /**
   * Replaces the session's cookies and local storage with a saved login
   * (`auth: <profile>`), e.g. after the setup hooks ran. Not an agent action;
   * the values are registered with the session's redactor first.
   */
  async useStorageState(state: StorageState): Promise<void> {
    this.#registerState(state);
    await this.#context.setStorageState(state);
  }

  #registerState(state: StorageState): void {
    const values = [
      ...(state.cookies ?? []).map((cookie) => cookie.value),
      ...(state.origins ?? []).flatMap((origin) => origin.localStorage.map((item) => item.value)),
    ];
    for (const value of values)
      if (typeof value === "string" && value.length >= MIN_STATE_VALUE)
        this.#secretRedactor.register(value, "[session]");
  }

  /**
   * Ends the session: closes the context (and the browser if this session
   * launched it) and returns the scrubbed evidence files. Safe to call twice.
   */
  async close(options: CloseOptions = {}): Promise<CloseResult> {
    if (this.#closed) return this.#closed;
    this.#closed = { evidence: [], refused: [] };
    const discard = new Set(options.discard ?? []);
    await this.#evidence.stop({ discardTrace: discard.has("trace") });
    const video = this.#page.video();
    await this.#helper
      ?.context()
      .close()
      .catch(() => {});
    await this.#context.close().catch(() => {});
    const videoPath = video ? await video.path().catch(() => undefined) : undefined;
    const evidence = await this.#evidence.finish(videoPath, {
      discardNetwork: discard.has("network"),
    });
    await this.#proxy.close();
    if (this.#ownsBrowser) await this.#browser.close();
    this.#closed = { evidence, refused: this.refusals() };
    return this.#closed;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #unusable(): boolean {
    return this.#crashed || this.#page.isClosed() || this.#closed !== undefined;
  }

  async #snapshot(): Promise<
    | {
        nodes: Array<AriaNode | string>;
        title: string;
        frames: Map<string, { url: string; title: string }>;
        sorts: Map<string, string>;
      }
    | undefined
  > {
    try {
      const nodes = (await this.#page.ariaSnapshotJSON({
        mode: "ai",
        boxes: true,
        timeout: ACTION_TIMEOUT_MS,
      })) as unknown as Array<AriaNode | string>;
      const frames = new Map<string, { url: string; title: string }>();
      const visit = async (node: AriaNode | string): Promise<void> => {
        if (typeof node === "string") return;
        if (node.role === "iframe" && node.ref) {
          const handle = await this.#page
            .locator(`aria-ref=${node.ref}`)
            .elementHandle({ timeout: ACTION_TIMEOUT_MS })
            .catch(() => null);
          const frame = await handle?.contentFrame().catch(() => null);
          const title = (await handle?.getAttribute("title").catch(() => null)) ?? "";
          frames.set(node.ref, { url: frame?.url() ?? "", title });
          await handle?.dispose().catch(() => {});
        }
        for (const child of node.children ?? []) await visit(child);
      };
      for (const node of nodes) await visit(node);
      const title = await this.#page.title().catch(() => "");
      return { nodes, title, frames, sorts: await this.#sortStates() };
    } catch {
      return undefined;
    }
  }

  /** Elements for before/after comparison; doesn't touch the agent's refs. */
  async #snapshotElements(): Promise<ObservedElement[] | undefined> {
    try {
      const nodes = (await this.#page.ariaSnapshotJSON({
        mode: "ai",
        timeout: ACTION_TIMEOUT_MS,
      })) as unknown as Array<AriaNode | string>;
      return buildObservation(nodes, {
        url: "",
        title: "",
        observedAt: "",
        refused: [],
        maxElements: 2000,
        redact: this.#redact,
        frameInfo: () => ({ url: "", title: "" }),
        sortStates: await this.#sortStates(),
      }).observation.elements;
    } catch {
      return undefined;
    }
  }

  /** `aria-sort` of the page's sortable headers by their text; the aria snapshot doesn't carry it. */
  async #sortStates(): Promise<Map<string, string>> {
    const pairs = await this.#page
      .evaluate(() =>
        Array.from(document.querySelectorAll("[aria-sort]")).map((element) => [
          ((element as HTMLElement).innerText ?? element.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim(),
          element.getAttribute("aria-sort") ?? "",
        ]),
      )
      .catch(() => [] as string[][]);
    return new Map(pairs.map(([name, sort]) => [this.#redact(name ?? ""), sort ?? ""]));
  }

  async #framePath(frame: number, depth: number): Promise<LocatorSpec[]> {
    if (frame === 0 || depth > 8) return [];
    const parentRef = this.#observation?.frames[frame]?.parentRef;
    const iframe = parentRef ? this.#refs.get(parentRef) : undefined;
    if (!iframe) return [];
    const outer = await this.#framePath(iframe.frame, depth + 1);
    const locator = this.#page.locator(`aria-ref=${iframe.ariaRef}`);
    const raw = await locator.evaluate(readFacts, FACT_ATTRIBUTES, { timeout: ACTION_TIMEOUT_MS });
    const specs = candidateSpecs(iframe.element, raw, outer);
    for (const spec of specs) {
      const matches = await toLocator(this.#page, spec)
        .count()
        .catch(() => 0);
      if (matches === 1) {
        const { frame: _outer, ...own } = spec;
        return [...outer, own as LocatorSpec];
      }
    }
    const last = specs[specs.length - 1] as LocatorSpec;
    const { frame: _outer, ...own } = last;
    return [...outer, own as LocatorSpec];
  }

  #scrubFacts(raw: RawFacts): RawFacts {
    return {
      tag: raw.tag,
      attributes: Object.fromEntries(
        Object.entries(raw.attributes).map(([key, value]) => [key, this.#redact(value)]),
      ),
      text: this.#redact(raw.text),
      label: this.#redact(raw.label),
      anchorText: this.#redact(raw.anchorText),
      css: raw.css,
    };
  }

  #scrubAction(action: Action): Action {
    if (action.type === "fill" && typeof action.value === "string") {
      return { ...action, value: this.#redact(action.value) };
    }
    if (action.type === "goto" && typeof action.url === "string")
      return { ...action, url: this.#redact(action.url) };
    return action;
  }

  async #resolve(target: Target, options: { single?: boolean } = {}): Promise<Resolved> {
    const single = options.single ?? true;
    let locator: Locator;
    if ("ref" in target) {
      const entry = this.#refs.get(target.ref);
      if (!entry) {
        return {
          result: notFound(`Unknown ref "${target.ref}": refs are valid until the next observe.`),
        };
      }
      locator = this.#page.locator(`aria-ref=${entry.ariaRef}`);
    } else {
      try {
        locator = toLocator(this.#page, target);
      } catch (error) {
        return {
          result: refused("invalid_action", errorResult(error).message ?? "invalid locator"),
        };
      }
    }
    if (!single) return { locator };
    let count: number;
    try {
      count = await locator.count();
    } catch {
      count = 0;
    }
    if (count === 0) return { result: notFound("No element matches the target.") };
    if (count > 1) {
      return {
        result: notFound(
          `The target matches ${count} elements; use a ref or a more specific locator.`,
        ),
      };
    }
    return { locator };
  }

  async #perform(action: Action): Promise<Result> {
    const timeout = this.#options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    const page = this.#page;
    const withTarget = async (target: Target, run: (locator: Locator) => Promise<unknown>) => {
      const resolved = await this.#resolve(target);
      if ("result" in resolved) return resolved.result;
      await run(resolved.locator);
      return ok;
    };
    switch (action.type) {
      case "goto":
        return typeof action.url === "string"
          ? this.#goto(action.url)
          : this.#gotoSecret(action.url.secret);
      case "click":
        return withTarget(action.target, (l) => l.click({ timeout }));
      case "dblclick":
        return withTarget(action.target, (l) => l.dblclick({ timeout }));
      case "hover":
        return withTarget(action.target, (l) => l.hover({ timeout }));
      case "check":
        return withTarget(action.target, (l) => l.check({ timeout }));
      case "uncheck":
        return withTarget(action.target, (l) => l.uncheck({ timeout }));
      case "select":
        return withTarget(action.target, (l) =>
          l.selectOption(typeof action.option === "string" ? action.option : [...action.option], {
            timeout,
          }),
        );
      case "fill":
        if (typeof action.value === "string") {
          const value = action.value;
          return withTarget(action.target, (l) => l.fill(value, { timeout }));
        }
        return this.#fillSecret(action.target, action.value.secret, timeout);
      case "press":
        if (action.target) {
          const key = action.key;
          return withTarget(action.target, (l) => l.press(key, { timeout }));
        }
        await page.keyboard.press(action.key);
        return ok;
      case "scroll":
        if (action.target) {
          return withTarget(action.target, (l) => l.scrollIntoViewIfNeeded({ timeout }));
        }
        await page.mouse.wheel(0, (action.direction === "up" ? -1 : 1) * (action.pixels ?? 600));
        return ok;
      case "upload":
        return this.#upload(action.target, action.files, timeout);
      case "back":
        await page.goBack({ timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "domcontentloaded" });
        return ok;
      case "reload":
        await page.reload({ timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "domcontentloaded" });
        return ok;
      case "waitFor": {
        const waitTimeout = action.timeoutMs ?? timeout;
        if (action.target) {
          const resolved = await this.#resolve(action.target, { single: false });
          if ("result" in resolved) return resolved.result;
          await resolved.locator.first().waitFor({ state: "visible", timeout: waitTimeout });
          return ok;
        }
        if (action.text !== undefined) {
          await page
            .getByText(action.text)
            .first()
            .waitFor({ state: "visible", timeout: waitTimeout });
          return ok;
        }
        return refused("invalid_action", "waitFor needs text or a target.");
      }
      default:
        return refused(
          "invalid_action",
          `Unknown action "${String((action as { type?: unknown }).type)}".`,
        );
    }
  }

  /**
   * Opens a URL held by a secret (a magic link, SEC-5): allowlisted like any
   * page and only on the secret's own domains, navigated inside the paused
   * trace, and scrubbed everywhere as `[secret:NAME]`.
   */
  async #gotoSecret(name: string): Promise<Result> {
    const secret = this.#options.secrets?.[name];
    if (!secret) return refused("missing_secret", `Secret ${name} is not available.`);
    let value: string;
    try {
      value = await prepareSecret(secret);
    } catch (error) {
      return refused(
        "secret_unavailable",
        `Secret ${name} has no value to open: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.#secretRedactor.register(value, secret.label);
    const url = parseUrl(value);
    if (!url || !isHttp(url))
      return refused("invalid_action", `Secret ${name} is not an http(s) URL.`);
    if (!this.#allowlist.allowsUrl(url) || !new Allowlist(secret.domains).allowsUrl(url)) {
      this.#refuse({ url: url.href, type: "navigation", frame: "" });
      return refused(
        "disallowed_domain",
        `Secret ${name} leads to ${url.host}, which is not in the allowed domains.`,
      );
    }
    await this.#evidence.pauseTrace();
    try {
      await this.#page.goto(url.href, {
        timeout: NAVIGATION_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      return ok;
    } catch (error) {
      const result = errorResult(error);
      if (/interrupted by another navigation/.test(result.message ?? "")) return ok;
      return result;
    } finally {
      await this.#evidence.resumeTrace();
    }
  }

  async #goto(input: string): Promise<Result> {
    let url: URL;
    try {
      url = this.#options.baseUrl ? new URL(input, this.#options.baseUrl) : new URL(input);
    } catch {
      return refused("invalid_action", `"${input}" is not a valid URL.`);
    }
    if (url.href === "about:blank") {
      await this.#page.goto("about:blank");
      return ok;
    }
    if (!isHttp(url)) {
      this.#refuse({ url: url.href, type: "scheme", frame: "" });
      return refused("disallowed_domain", `Only http(s) pages can be opened, not ${url.protocol}.`);
    }
    if (!this.#allowlist.allowsUrl(url)) {
      this.#refuse({ url: url.href, type: "navigation", frame: "" });
      return refused("disallowed_domain", `${url.host} is not in the allowed domains.`);
    }
    try {
      await this.#page.goto(url.href, {
        timeout: NAVIGATION_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      return ok;
    } catch (error) {
      const result = errorResult(error);
      if (/interrupted by another navigation/.test(result.message ?? "")) return ok;
      return result;
    }
  }

  async #fillSecret(target: Target, name: string, timeout: number): Promise<Result> {
    const secret = this.#options.secrets?.[name];
    if (!secret) return refused("missing_secret", `Secret ${name} is not available.`);
    const resolved = await this.#resolve(target);
    if ("result" in resolved) return resolved.result;
    let handle: ElementHandle | null = null;
    try {
      handle = await resolved.locator.elementHandle({ timeout });
      const frame = await handle.ownerFrame();
      const frameUrl = frame?.url() ?? "";
      const host = parseUrl(frameUrl)?.host ?? frameUrl;
      if (
        !this.#allowlist.allowsUrl(frameUrl) ||
        !new Allowlist(secret.domains).allowsUrl(frameUrl)
      ) {
        return refused(
          "disallowed_domain",
          `Secret ${name} may not be typed into ${host || "this page"}; it is allowed on: ${secret.domains.join(", ") || "no domains"}.`,
        );
      }
      // Mask the field in screenshots, video and trace screencasts for its lifetime.
      await handle.evaluate((element, attribute) => {
        (element as Element).setAttribute(attribute, "");
        if ((element as HTMLInputElement).type !== "password") {
          (element as HTMLElement).style.setProperty("-webkit-text-security", "disc");
        }
      }, this.#secretAttribute);
      // The value to type now: a TOTP secret produces its current code here (AUTH-0),
      // an inbox secret reads the email (AUTH-1).
      let value: string;
      try {
        value = await prepareSecret(secret);
      } catch (error) {
        return refused(
          "secret_unavailable",
          `Secret ${name} has no value to type: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.#secretRedactor.register(value, secret.label);
      await this.#evidence.pauseTrace();
      try {
        await handle.fill(value, { timeout });
      } finally {
        await this.#evidence.resumeTrace();
      }
      return ok;
    } finally {
      await handle?.dispose().catch(() => {});
    }
  }

  async #upload(
    target: Target,
    files: string | readonly string[],
    timeout: number,
  ): Promise<Result> {
    const allowed = this.#options.allowUpload;
    if (!allowed) return refused("upload_not_allowed", "File upload is not enabled for this test.");
    let root: string;
    try {
      root = realpathSync(allowed.dir);
    } catch {
      return refused("file_outside_folder", "The test's upload folder does not exist.");
    }
    const paths: string[] = [];
    for (const file of typeof files === "string" ? [files] : files) {
      let real: string;
      try {
        real = realpathSync(isAbsolute(file) ? file : resolve(root, file));
      } catch {
        return refused(
          "file_outside_folder",
          `File "${file}" does not exist in the test's folder.`,
        );
      }
      const inside = relative(root, real);
      if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
        return refused("file_outside_folder", `File "${file}" is outside the test's folder.`);
      }
      if (!statSync(real).isFile()) {
        return refused("file_outside_folder", `"${file}" is not a file.`);
      }
      paths.push(real);
    }
    const resolved = await this.#resolve(target);
    if ("result" in resolved) return resolved.result;
    const isFileInput = await resolved.locator.evaluate(
      (element) => element instanceof HTMLInputElement && element.type === "file",
      undefined,
      { timeout },
    );
    if (isFileInput) {
      await resolved.locator.setInputFiles(paths, { timeout });
      return ok;
    }
    const [chooser] = await Promise.all([
      this.#page.waitForEvent("filechooser", { timeout }),
      resolved.locator.click({ timeout }),
    ]);
    await chooser.setFiles(paths, { timeout });
    return ok;
  }

  /** Scales a CSS-pixel screenshot down to MODEL_MAX_WIDTH, in a separate offline page. */
  async #downscale(bytes: Buffer): Promise<Buffer> {
    const viewport = this.#page.viewportSize();
    if (!viewport || viewport.width <= MODEL_MAX_WIDTH) return bytes;
    const height = Math.max(1, Math.round((viewport.height * MODEL_MAX_WIDTH) / viewport.width));
    if (!this.#helper) {
      const browser: Browser = browserOf(this.#browser);
      const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
      await context.route("**/*", (route) => route.abort().catch(() => {}));
      this.#helper = await context.newPage();
    }
    await this.#helper.setViewportSize({ width: MODEL_MAX_WIDTH, height });
    await this.#helper.setContent(
      `<body style="margin:0"><img style="display:block;width:${MODEL_MAX_WIDTH}px" src="data:image/jpeg;base64,${bytes.toString("base64")}"></body>`,
    );
    return this.#helper.screenshot({ type: "jpeg", quality: 70, scale: "css" });
  }
}

/** Opens a fresh, isolated browser session. Throws BrowserSetupError only for setup problems. */
export function openSession(options: SessionOptions): Promise<Session> {
  return Session.open(options);
}

/**
 * The session's protected-preview headers with their values (SEC-8). Each value
 * is registered with the session's redactor (basic auth in its encoded form too),
 * so it never shows up in evidence. A header whose secret has no value is a
 * setup error: the runner blocks such tests before opening a session.
 */
function protectedHeaders(options: SessionOptions, redactor: Redactor): ScopedHeader[] {
  const secrets = options.secrets ?? {};
  const need = (name: string) => {
    const secret = secrets[name];
    if (!secret)
      throw new BrowserSetupError(
        `The protected-preview header needs secret ${name}, which has no value.`,
        `Provide ${name} (in CI: a repository secret mapped to an environment variable).`,
      );
    return secret;
  };
  return (options.protectedHeaders ?? []).map((spec): ScopedHeader => {
    if ("basic" in spec) {
      const password = need(spec.basic.password);
      const value = basicAuthValue(revealSecret(need(spec.basic.username)), revealSecret(password));
      redactor.register(value, password.label);
      redactor.register(value.slice("Basic ".length), password.label);
      return { name: "Authorization", value, domains: password.domains, keepExisting: true };
    }
    const secret = need(spec.secret);
    return { name: spec.name, value: revealSecret(secret), domains: secret.domains };
  });
}
