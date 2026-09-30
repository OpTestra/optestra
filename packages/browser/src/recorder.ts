import type { CandidatesResult, LocatorSpec } from "./types.js";

// Record mode (AUT-8): what the user does in a headed browser. A page script
// catches their clicks (and Enter in a field), holds them, and the harness
// performs the same action itself, so those steps come with their post-state
// and settle time, like authoring; every step gets real locators and a fingerprint.
// Typing, selects and file choices happen natively and are reported when the
// field changes. A small overlay (outside the accessibility tree) marks
// expectations and finishes. Typed values never leave this package when they
// are secret: a password field or a secret's value is reported by name only.

/** The element a recorded event is about: its ranked locators and facts, and how to reach it now. */
export interface RecordedTarget {
  candidates: CandidatesResult;
  /** What the harness acts on right now (the top unique candidate, else a marker). */
  act: LocatorSpec;
  /** Tag, and for inputs their type. */
  tag: string;
  inputType?: string;
}

export type RecordedUserEvent =
  | { type: "click" | "check" | "uncheck"; target: RecordedTarget }
  | {
      type: "fill";
      target: RecordedTarget;
      /** The typed text; absent when it is secret (`secret`, or `sensitive` with no known secret). */
      value?: string;
      /** A session secret whose value the user typed. */
      secret?: string;
      /** A password field (or similar) whose value matched no secret: never reported. */
      sensitive?: boolean;
    }
  | { type: "select"; target: RecordedTarget; option: string }
  | { type: "press"; key: string; target: RecordedTarget }
  | { type: "upload"; target: RecordedTarget; files: string[] }
  | { type: "goto"; url: string }
  | {
      type: "mark";
      kind: "text" | "element" | "url";
      target?: RecordedTarget;
      /** The selected text (kind text), or the element's visible text. */
      text?: string;
    }
  | { type: "finish" };

/** What the overlay shows after an event (e.g. "Added: Expect: …" or why not). */
export interface RecordReply {
  ok: boolean;
  message?: string;
}

export interface RecordOptions {
  /** Called in order, one event at a time. */
  onEvent: (event: RecordedUserEvent) => Promise<RecordReply | undefined>;
  /** Show the overlay (default true). */
  overlay?: boolean;
  /**
   * Test hook: a scripted person at the keyboard (trusted input, like a real
   * user's), for record-mode tests. Not a Playwright object: a few verbs only.
   */
  user?: (user: ScriptedUser) => void;
}

/** A scripted person using the recorded page (tests of record mode). */
export interface ScriptedUser {
  /** Types into the field with this label. */
  fill(label: string, value: string): Promise<void>;
  /** Clicks the element with this role and name. */
  click(role: string, name: string | RegExp): Promise<void>;
  /** Clicks the page's first main heading. */
  clickHeading(): Promise<void>;
  /** Presses keys, e.g. "Alt+Shift+E". */
  press(keys: string): Promise<void>;
  waitForUrl(pattern: RegExp): Promise<void>;
}

export interface RecordingControl {
  /** Resolves when the user finishes (the overlay's Finish), or the window closes. */
  finished: Promise<"finished" | "closed">;
  stop(): Promise<void>;
}

/** The page script. Placeholders: __BINDING__, __ATTR__, __FLAG__, __OVERLAY__. */
export const RECORDER_SCRIPT = String.raw`(() => {
  const B = "__BINDING__", ATTR = "__ATTR__", FLAG = "__FLAG__", OVERLAY = __OVERLAY__;
  if (window.top !== window || window[FLAG + "_on"]) return;
  window[FLAG + "_on"] = true;
  let seq = 0;
  let picking = false;
  const reported = new WeakMap();
  let host = null;
  let toastBox = null;
  const tag = (el) => { const id = "r" + (++seq); el.setAttribute(ATTR, id); return id; };
  const send = (payload) => { try { return window[B](payload); } catch { return Promise.resolve(undefined); } };
  const passing = () => (window[FLAG] || 0) > 0;
  const fromOverlay = (e) => host !== null && e.composedPath().includes(host);
  const NOT_TEXT = ["checkbox","radio","submit","button","reset","file","image","range","color","hidden"];
  const isTextField = (el) =>
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !NOT_TEXT.includes(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable);
  const valueOf = (el) => (el instanceof HTMLElement && el.isContentEditable ? el.innerText : el.value);
  const flush = (el) => {
    if (!el || !isTextField(el)) return;
    const value = valueOf(el);
    if (reported.get(el) === value) return;
    reported.set(el, value);
    send({ type: "fill", id: tag(el), value });
  };
  const CLICKABLE = "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[onclick]";
  const toast = (reply) => {
    if (!toastBox || !reply || !reply.message) return;
    toastBox.textContent = reply.message;
    toastBox.dataset.ok = reply.ok ? "1" : "0";
    toastBox.style.display = "block";
    clearTimeout(toastBox._t);
    toastBox._t = setTimeout(() => { toastBox.style.display = "none"; }, 4000);
  };
  const setPicking = (on) => {
    picking = on;
    if (pickButton) pickButton.dataset.on = on ? "1" : "0";
    document.documentElement.style.cursor = on ? "crosshair" : "";
  };
  const expectSelection = async () => {
    const text = String(window.getSelection() || "").replace(/\s+/g, " ").trim();
    if (text) { toast(await send({ type: "mark", kind: "text", text })); return true; }
    return false;
  };

  document.addEventListener("click", async (e) => {
    if (passing() || fromOverlay(e) || !e.isTrusted) return;
    const origin = e.target instanceof Element ? e.target : null;
    if (!origin) return;
    if (picking) {
      e.preventDefault(); e.stopImmediatePropagation();
      setPicking(false);
      const el = origin.closest(CLICKABLE) || origin;
      toast(await send({ type: "mark", kind: "element", id: tag(el), text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200) }));
      return;
    }
    let target = origin.closest(CLICKABLE) || origin;
    if (target instanceof HTMLLabelElement && target.control) target = target.control;
    if (isTextField(target) || target instanceof HTMLSelectElement) return;
    if (target instanceof HTMLInputElement && target.type === "file") return;
    e.preventDefault(); e.stopImmediatePropagation();
    flush(document.activeElement);
    if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) {
      send({ type: target.type === "checkbox" && target.checked ? "uncheck" : "check", id: tag(target) });
      return;
    }
    send({ type: "click", id: tag(target) });
  }, true);

  document.addEventListener("keydown", (e) => {
    if (passing() || fromOverlay(e) || !e.isTrusted) return;
    if (e.altKey && e.shiftKey && (e.key === "E" || e.key === "e" || e.code === "KeyE")) {
      e.preventDefault(); e.stopImmediatePropagation();
      expectSelection().then((done) => { if (!done) setPicking(true); });
      return;
    }
    if (e.key === "Escape" && picking) { setPicking(false); return; }
    const el = e.target;
    if (e.key === "Enter" && el instanceof HTMLInputElement && isTextField(el)) {
      e.preventDefault(); e.stopImmediatePropagation();
      flush(el);
      send({ type: "press", key: "Enter", id: tag(el) });
    }
  }, true);

  document.addEventListener("change", (e) => {
    if (passing() || !e.isTrusted) return;
    const el = e.target;
    if (el instanceof HTMLSelectElement) {
      const option = el.selectedOptions[0];
      send({ type: "select", id: tag(el), option: option ? (option.label || option.text).trim() : el.value });
    } else if (el instanceof HTMLInputElement && el.type === "file") {
      send({ type: "upload", id: tag(el), files: Array.from(el.files || []).map((f) => f.name) });
    } else flush(el);
  }, true);
  document.addEventListener("focusout", (e) => { if (!passing()) flush(e.target); }, true);

  let pickButton = null;
  const overlay = () => {
    if (!OVERLAY || host || !document.body) return;
    host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = '<style>.bar{font:13px system-ui,sans-serif;background:#1f2328;color:#fff;border-radius:8px;padding:6px;display:flex;gap:6px;align-items:center;box-shadow:0 2px 8px #0005}.dot{color:#f85149;padding:0 4px}button{font:inherit;border:0;border-radius:6px;padding:4px 8px;background:#3a3f46;color:#fff;cursor:pointer}button[data-on="1"]{background:#1f6feb}.toast{display:none;font:12px system-ui,sans-serif;margin-top:6px;padding:6px 8px;border-radius:6px;background:#1f2328;color:#fff;max-width:360px}.toast[data-ok="0"]{background:#8e1519}</style><div class="bar"><span class="dot">● REC</span><button data-a="text" title="Alt+Shift+E">Expect text</button><button data-a="url">Expect URL</button><button data-a="finish">Finish</button></div><div class="toast"></div>';
    toastBox = root.querySelector(".toast");
    pickButton = root.querySelector('[data-a="text"]');
    root.addEventListener("mousedown", (e) => e.preventDefault());
    root.addEventListener("click", async (e) => {
      const button = e.target instanceof Element ? e.target.closest("button") : null;
      if (!button) return;
      const a = button.getAttribute("data-a");
      if (a === "text") { if (!(await expectSelection())) setPicking(!picking); }
      if (a === "url") toast(await send({ type: "mark", kind: "url" }));
      if (a === "finish") { flush(document.activeElement); send({ type: "finish" }); }
    });
    document.documentElement.appendChild(host);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", overlay);
  else overlay();
})();`;
