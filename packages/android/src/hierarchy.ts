import type { Bounds, DriverNode, DriverWindow, Dump } from "./driver.js";
import type {
  AndroidObservation,
  AndroidRefusal,
  ElementStates,
  ElementSummary,
  ObservedElement,
  ObservedFrame,
} from "./types.js";

/** A short "-ing…" text: a loading or working message. */
const BUSY_TEXT = /^(?![A-Z][a-z]*thing\b)[A-Z][a-z]+ing(?: [a-z]+){0,2}(?:…|\.\.\.)$/;

// The screen as data (MOB-3, MOD-3): the driver's accessibility dump mapped to the
// web harness's Observation shape. Windows play the part of frames: frame 0 is
// the app's own window, later frames are windows on top of it (dialogs, the
// permission prompt). Pure code: no device access.

/** Packages whose windows an action may touch besides the app: permission prompts and system dialogs. */
export const SYSTEM_DIALOG_PACKAGES: readonly string[] = [
  "com.android.permissioncontroller",
  "com.google.android.permissioncontroller",
  "android",
];
/** Windows that are never part of the screen: status and navigation bars, the keyboard. */
const HIDDEN_PACKAGES = new Set(["com.android.systemui"]);
const HIDDEN_WINDOW_TYPES = new Set(["input_method", "accessibility_overlay", "divider"]);

export type AndroidElementStates = ElementStates & { scrollable?: boolean };

export interface AndroidObservedElement extends ObservedElement {
  states: AndroidElementStates;
}

export interface ScreenNode {
  node: DriverNode;
  index: number;
  role: string;
  name: string;
  /** Text content, or a field's value. */
  text?: string;
  placeholder?: string;
  /** Text of the element labelling this one (labelFor). */
  label?: string;
  /** The resource id's entry name (`sign_in_button`). */
  testId?: string;
  visible: boolean;
  interactive: boolean;
  /** Frame (window) index in the observation, or -1 for hidden windows. */
  frame: number;
  /** Stable address within this screen: window package + child-index path. */
  path: string;
  children: number[];
  parent: number;
}

/** What a ref points at, so it can be found again in a newer dump. */
export interface RefKey {
  path: string;
  cls: string;
  rid: string | null;
}

/** What a filled password field shows (never its length). */
export const PASSWORD_MASK = "••••••••";

const shortClass = (cls: string) => cls.slice(cls.lastIndexOf(".") + 1).replace(/\$.*/, "");
const has = (node: DriverNode, flag: string) => node.flags.includes(flag);
const clean = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

const BUTTONS = new Set([
  "Button",
  "ImageButton",
  "MaterialButton",
  "FloatingActionButton",
  "ExtendedFloatingActionButton",
  "AppCompatButton",
  "AppCompatImageButton",
  "Chip",
]);
const LISTS = new Set([
  "ListView",
  "RecyclerView",
  "GridView",
  "ExpandableListView",
  "AbsListView",
]);
const SWITCHES = new Set([
  "Switch",
  "SwitchCompat",
  "SwitchMaterial",
  "MaterialSwitch",
  "ToggleButton",
]);

function baseRole(node: DriverNode, parentRole: string | undefined): string {
  const short = shortClass(node.cls);
  if (has(node, "editable") || short === "EditText" || short.endsWith("EditText")) return "textbox";
  if (node.range) {
    return short.includes("Progress") ? "progressbar" : "slider";
  }
  if (short === "ProgressBar" || short.endsWith("ProgressIndicator")) return "progressbar";
  if (has(node, "checkable")) {
    if (SWITCHES.has(short)) return "switch";
    if (short === "RadioButton" || short.endsWith("RadioButton")) return "radio";
    return "checkbox";
  }
  if (short === "Spinner" || short.endsWith("Spinner")) return "combobox";
  if (LISTS.has(short) || (node.collection && !node.item)) return "list";
  if (short === "TabLayout" || short === "TabWidget") return "tablist";
  if (short === "TabView") return "tab";
  if (short === "WebView") return "webview";
  if (has(node, "heading")) return "heading";
  if (parentRole === "list" || node.item) return "listitem";
  if (BUTTONS.has(short)) return "button";
  if (short === "ImageView" || short.endsWith("ImageView")) {
    return has(node, "clickable") ? "button" : "img";
  }
  if (has(node, "clickable") || has(node, "longClickable")) return "button";
  if (node.text && clean(node.text)) return "text";
  return "generic";
}

function entryName(rid: string | undefined): string | undefined {
  if (!rid) return undefined;
  const at = rid.indexOf(":id/");
  return at >= 0 ? rid.slice(at + 4) : rid;
}

export interface ScreenContext {
  /** The app under test. */
  appPackage: string;
  /** Fields a secret was typed into (path → `[secret:NAME]`). */
  secretFields?: ReadonlyMap<string, string>;
}

/** One dump, understood. */
/**
 * The activity on screen: the activity manager's resumed one, unless the top
 * application window's own Activity class says otherwise. On a slow device the
 * new activity's window (and its content) shows before the activity manager
 * reports it resumed, and the stale name would put the old URL next to the new
 * screen (MOB-3).
 */
export function screenActivity(dump: Pick<Dump, "activity" | "windows">): string | null {
  const resumed = dump.activity;
  const pkg = resumed?.split("/")[0];
  if (!pkg) return resumed;
  const top = [...dump.windows]
    .filter((w) => w.type === "application" && w.package === pkg)
    .sort((a, b) => b.layer - a.layer)[0];
  const cls = top?.cls;
  if (!cls?.startsWith(`${pkg}.`) || !/Activity$/.test(cls)) return resumed;
  // `pkg/.Name` or `pkg/pkg.Name`: the same class either way.
  const [, name = ""] = (resumed ?? "").split("/");
  const resumedClass = name.startsWith(".") ? `${pkg}${name}` : name;
  return resumedClass === cls ? resumed : `${pkg}/${cls.slice(pkg.length)}`;
}

export class Screen {
  readonly dump: Dump;
  readonly nodes: ScreenNode[];
  /** Windows shown as frames, bottom first. */
  readonly frames: DriverWindow[];
  readonly url: string;
  readonly title: string;
  readonly appPackage: string;

  constructor(dump: Dump, context: ScreenContext) {
    this.dump = dump;
    this.appPackage = context.appPackage;
    const windows = [...dump.windows].sort((a, b) => a.layer - b.layer);
    this.frames = windows.filter(
      (w) =>
        w.package !== null && !HIDDEN_WINDOW_TYPES.has(w.type) && !HIDDEN_PACKAGES.has(w.package),
    );
    const frameOf = new Map<number, number>();
    this.frames.forEach((w, i) => {
      frameOf.set(w.id, i);
    });

    const byId = new Map<number, DriverNode>();
    for (const node of dump.nodes) byId.set(node.id, node);
    const childCount = new Map<number, number>();
    this.nodes = [];
    for (const node of dump.nodes) {
      const parent = node.parent >= 0 ? this.nodes[node.parent] : undefined;
      const siblingIndex = childCount.get(node.parent) ?? 0;
      childCount.set(node.parent, siblingIndex + 1);
      const window = dump.windows.find((w) => w.id === node.window);
      const path = parent
        ? `${parent.path}.${siblingIndex}`
        : `${window?.package ?? node.pkg}#${node.window}`;
      const role = baseRole(node, parent?.role);
      const visible =
        has(node, "visible") && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1];
      const entry: ScreenNode = {
        node,
        index: node.id,
        role,
        name: "",
        visible,
        interactive:
          has(node, "clickable") ||
          has(node, "longClickable") ||
          has(node, "checkable") ||
          has(node, "editable") ||
          role === "listitem" ||
          role === "tab",
        frame: frameOf.get(node.window) ?? -1,
        path,
        children: [],
        parent: node.parent,
      };
      const testId = entryName(node.rid);
      if (testId) entry.testId = testId;
      parent?.children.push(node.id);
      this.nodes[node.id] = entry;
    }
    // Names, text and labels, now that children are known.
    for (const entry of this.nodes) {
      if (!entry) continue;
      const node = entry.node;
      const labelNode = node.labeledBy !== undefined ? byId.get(node.labeledBy) : undefined;
      if (labelNode) entry.label = clean(labelNode.text ?? labelNode.desc);
      const hint = clean(node.hint);
      if (hint) entry.placeholder = hint;
      if (entry.role === "textbox") {
        entry.name = entry.label || hint || clean(node.desc);
        const value = has(node, "showingHint") ? "" : (node.text ?? "");
        const secret = context.secretFields?.get(entry.path);
        if (secret && value) entry.text = secret;
        // A password field's bullets would still tell the length.
        else if (value && has(node, "password")) entry.text = PASSWORD_MASK;
        else entry.text = value;
      } else {
        const own = clean(node.desc) || clean(node.text);
        if (entry.role === "text") {
          entry.text = clean(node.text);
          if (node.desc) entry.name = clean(node.desc);
        } else {
          entry.name = own || (entry.interactive ? this.#descendantText(entry) : "");
        }
        if (entry.role === "switch" || entry.role === "checkbox" || entry.role === "radio") {
          entry.name = clean(node.desc) || clean(node.text);
        }
      }
    }
    const activity = screenActivity(dump);
    this.url = activity
      ? `android-app://${activity}`
      : `android-app://${this.frames[0]?.package ?? context.appPackage}`;
    const top = this.frames[this.frames.length - 1];
    this.title = clean(top?.title ?? "");
    // A dialog window's root is the dialog (role dialog, named by its title), so
    // "a dialog titled X" finds it like the web's role=dialog.
    for (const window of this.frames) {
      if (!this.isDialog(window)) continue;
      for (const root of this.nodes) {
        if (!root || root.node.window !== window.id || root.parent >= 0) continue;
        root.role = window.package === this.appPackage ? "dialog" : "alertdialog";
        root.name =
          clean(window.title ?? undefined) ||
          clean(this.nodes.find((n) => n && n.node.window === window.id && n.node.text)?.node.text);
      }
    }
  }

  /** Joined text of non-interactive descendants: how a row without its own label reads. */
  #descendantText(entry: ScreenNode): string {
    const parts: string[] = [];
    const walk = (id: number) => {
      const child = this.nodes[id];
      if (!child || child.interactive) return;
      const text = clean(child.node.desc) || clean(child.node.text);
      if (text) parts.push(text);
      else child.children.forEach(walk);
    };
    entry.children.forEach(walk);
    return parts.join(" ").slice(0, 200);
  }

  /** Nodes in windows that are part of the screen, in document order. */
  *shown(): Iterable<ScreenNode> {
    for (const entry of this.nodes) if (entry && entry.frame >= 0) yield entry;
  }

  /** True when an action may touch this node: the app, a permission prompt, a system dialog. */
  touchable(entry: ScreenNode): boolean {
    const pkg =
      this.dump.windows.find((w) => w.id === entry.node.window)?.package ?? entry.node.pkg;
    return pkg === this.appPackage || SYSTEM_DIALOG_PACKAGES.includes(pkg);
  }

  packageOf(entry: ScreenNode): string {
    return this.dump.windows.find((w) => w.id === entry.node.window)?.package ?? entry.node.pkg;
  }

  hasScrollableAncestor(entry: ScreenNode): boolean {
    for (let at = entry.parent; at >= 0; at = this.nodes[at]?.parent ?? -1) {
      if (this.nodes[at]?.node.flags.includes("scrollable")) return true;
    }
    return false;
  }

  scrollableAncestor(entry: ScreenNode): ScreenNode | undefined {
    for (let at = entry.parent; at >= 0; at = this.nodes[at]?.parent ?? -1) {
      const node = this.nodes[at];
      if (node?.node.flags.includes("scrollable")) return node;
    }
    return undefined;
  }

  keyOf(entry: ScreenNode): RefKey {
    return { path: entry.path, cls: entry.node.cls, rid: entry.node.rid ?? null };
  }

  /** The node a ref pointed at, in this (newer) screen. */
  find(key: RefKey): ScreenNode | undefined {
    const exact = this.nodes.find((n) => n && n.path === key.path && n.node.cls === key.cls);
    if (exact && (key.rid === null || exact.node.rid === key.rid)) return exact;
    if (key.rid) {
      const byId = this.nodes.filter((n) => n && n.node.rid === key.rid && n.node.cls === key.cls);
      if (byId.length === 1) return byId[0];
    }
    return undefined;
  }

  /** Whether a node is kept in the observation (and so gets a ref). */
  kept(entry: ScreenNode, inSummarised: boolean): boolean {
    if (entry.frame < 0) return false;
    if (!entry.visible && !this.hasScrollableAncestor(entry)) return false;
    const node = entry.node;
    if (entry.interactive) return true;
    if (inSummarised) return false;
    switch (entry.role) {
      case "dialog":
      case "alertdialog":
      case "heading":
      case "list":
      case "tablist":
      case "webview":
      case "progressbar":
      case "slider":
        return true;
      case "text":
        return Boolean(entry.text);
      case "img":
        return Boolean(entry.name);
      default:
        return (
          Boolean(clean(node.desc)) || Boolean(node.error) || node.flags.includes("scrollable")
        );
    }
  }

  /**
   * A window over the app's screen: a dialog of the app, the permission prompt,
   * a system dialog. Windows under a dialog are not interactive, so Android may
   * not report them; the window's own class tells a dialog from an activity.
   */
  isDialog(window: DriverWindow): boolean {
    if (window.type !== "application") return window.type === "system" && window.package !== null;
    if (window.package !== this.appPackage)
      return window.package !== null && SYSTEM_DIALOG_PACKAGES.includes(window.package);
    if (window.cls && /Dialog|\$|PopupWindow/.test(window.cls) && !window.cls.endsWith("Activity"))
      return true;
    return this.frames.indexOf(window) > 0;
  }

  /**
   * Between screens: no window yet, a window whose content isn't there yet, or
   * the resumed activity's own window not reported yet (the activity manager
   * switches before the accessibility tree does).
   */
  transitioning(): boolean {
    if (this.frames.length === 0) return true;
    const resumed = this.dump.activity?.split("/")[0];
    if (resumed && !this.dump.windows.some((w) => w.package === resumed)) return true;
    for (const window of this.frames) {
      let count = 0;
      for (const node of this.dump.nodes) if (node.window === window.id && ++count >= 3) break;
      if (count < 3) return true;
    }
    return false;
  }

  /**
   * Busy: between screens (no window yet, or a window whose content isn't there
   * yet), or a visible indeterminate progress indicator in a window of the app.
   */
  busy(): boolean {
    if (this.transitioning()) return true;
    for (const entry of this.shown()) {
      if (
        entry.role === "progressbar" &&
        entry.visible &&
        !entry.node.range &&
        this.touchable(entry)
      ) {
        return true;
      }
      // An app saying it's at work ("Checking…", "Loading...", "Saving changes…"),
      // often before its request has even started (MOB-1).
      if (entry.visible && entry.node.text && BUSY_TEXT.test(entry.node.text.trim())) return true;
    }
    return false;
  }
}

export interface BuildOptions {
  maxElements: number;
  redact: (text: string) => string;
  refused: AndroidRefusal[];
  observedAt?: string;
}

export interface Built {
  observation: AndroidObservation;
  refs: Map<string, RefKey>;
  /** Kept elements with their node, for diffs and candidates. */
  kept: { element: AndroidObservedElement; entry: ScreenNode }[];
}

function statesOf(entry: ScreenNode): AndroidElementStates {
  const node = entry.node;
  const states: AndroidElementStates = {};
  if (node.flags.includes("checkable")) states.checked = node.flags.includes("checked");
  if (entry.interactive && !node.flags.includes("enabled")) states.disabled = true;
  if (node.flags.includes("selected")) states.selected = true;
  if (node.flags.includes("focused")) states.active = true;
  if (node.error) states.invalid = true;
  if (node.flags.includes("scrollable")) states.scrollable = true;
  return states;
}

const box = (b: Bounds) => ({ x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] });

/** The observation for a screen, with refs for every kept element. */
export function buildObservation(screen: Screen, options: BuildOptions): Built {
  const { redact } = options;
  const elements: AndroidObservedElement[] = [];
  const kept: Built["kept"] = [];
  const refs = new Map<string, RefKey>();
  const frames: ObservedFrame[] = [];
  let truncated = false;
  const push = (element: AndroidObservedElement, entry: ScreenNode | null) => {
    if (elements.length >= options.maxElements) {
      truncated = true;
      return false;
    }
    if (entry) {
      element.ref = `e${refs.size + 1}`;
      refs.set(element.ref, screen.keyOf(entry));
      kept.push({ element, entry });
    }
    elements.push(element);
    return true;
  };

  screen.frames.forEach((window, frameIndex) => {
    frames.push({ url: redact(`android-app://${window.package ?? ""}`), parentRef: null });
    const roots = screen.nodes.filter((n) => n && n.node.window === window.id && n.parent < 0);
    const walk = (entry: ScreenNode, depth: number, summarised: boolean) => {
      if (truncated) return;
      const keep = screen.kept(entry, summarised);
      let childDepth = depth;
      let childSummarised = summarised;
      if (keep) {
        const element: AndroidObservedElement = {
          role: entry.role,
          name: redact(entry.name),
          depth,
          states: statesOf(entry),
          interactive: entry.interactive,
          frame: frameIndex,
          box: box(entry.node.bounds),
        };
        if (entry.text !== undefined && (entry.role === "textbox" || entry.text)) {
          element.text = redact(entry.text);
        }
        if (entry.placeholder !== undefined && entry.role === "textbox") {
          element.placeholder = redact(entry.placeholder);
        }
        if (!push(element, entry)) return;
        childDepth = depth + 1;
        // A row named after its texts: those texts are already said.
        if (entry.interactive && !entry.node.text && !entry.node.desc && entry.name)
          childSummarised = true;
      }
      for (const child of entry.children) {
        const node = screen.nodes[child];
        if (node) walk(node, childDepth, childSummarised);
      }
    };
    for (const root of roots) if (root) walk(root, 0, false);
  });

  return {
    observation: {
      untrusted: true,
      url: redact(screen.url),
      title: redact(screen.title),
      observedAt: options.observedAt ?? new Date().toISOString(),
      frames,
      elements,
      refused: options.refused,
      truncated,
      rotation: screen.dump.rotation,
    },
    refs,
    kept,
  };
}

/** Focus moves with every tap, so it is not a change of the screen. Nor is a box moving. */
const signature = (e: ObservedElement): string => {
  const { active: _focus, ...rest } = e.states;
  return JSON.stringify([e.frame, e.role, e.name, e.text ?? "", rest]);
};

function summaryOf(element: ObservedElement): ElementSummary {
  const summary: ElementSummary = { role: element.role, name: element.name };
  if (element.text !== undefined) summary.text = element.text;
  return summary;
}

/**
 * True when the same elements are all still there but in a different order (a
 * re-sorted list), mirroring the browser harness's rule for `reordered`.
 */
export function reorderedElements(
  before: readonly ObservedElement[],
  after: readonly ObservedElement[],
): boolean {
  if (before.length !== after.length || before.length === 0) return false;
  const keys = (list: readonly ObservedElement[]) =>
    list.map((e) => JSON.stringify([e.role, e.name, e.text ?? ""]));
  const a = keys(before);
  const b = keys(after);
  if (a.every((key, i) => key === b[i])) return false;
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/** Elements in `after` but not `before` (added) and the reverse (removed), as multisets. */
export function diffElements(
  before: readonly ObservedElement[],
  after: readonly ObservedElement[],
  limit = 50,
): { added: ElementSummary[]; removed: ElementSummary[] } {
  const count = new Map<string, number>();
  for (const element of before)
    count.set(signature(element), (count.get(signature(element)) ?? 0) + 1);
  const added: ElementSummary[] = [];
  for (const element of after) {
    const key = signature(element);
    const left = count.get(key) ?? 0;
    if (left > 0) count.set(key, left - 1);
    else if (added.length < limit) added.push(summaryOf(element));
  }
  const removed: ElementSummary[] = [];
  for (const element of before) {
    const key = signature(element);
    const left = count.get(key) ?? 0;
    if (left > 0) {
      count.set(key, left - 1);
      if (removed.length < limit) removed.push(summaryOf(element));
    }
  }
  return { added, removed };
}
