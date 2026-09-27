import type { Screen, ScreenNode } from "./hierarchy.js";

// Android's own "isn't responding" and "keeps stopping" dialogs. On a slow or
// shared machine (a CI runner) system processes (System UI, the launcher) often
// trip them, and the dialog then sits on top of the app under test. The session
// dismisses those that belong to *other* packages before it hands a screen to a
// test, and reports each one. A dialog about the app under test is a real
// finding: it is never dismissed. Pure code: no device access.

/** The buttons of the system's ANR and crash dialogs (framework resource ids). */
const WAIT = "android:id/aerr_wait";
const CLOSE = "android:id/aerr_close";
const AERR = /^android:id\/aerr_/;

export interface SystemDialog {
  kind: "not_responding" | "crashed";
  /** e.g. "System UI isn't responding". */
  title: string;
  /** "app": about the app under test (never dismissed). "other": anything else. */
  owner: "app" | "other";
  /** The button that dismisses it: Wait for an ANR (Close once it keeps coming back), Close for a crash. */
  dismiss: ScreenNode | null;
}

const clean = (text: string | undefined | null) => (text ?? "").replace(/\s+/g, " ").trim();

/**
 * The ANR and crash dialogs on a screen. `appLabel` is the app's label as the
 * system shows it; when it isn't known, every dialog counts as the app's (so
 * nothing is dismissed by mistake). `repeats` is how often this title was seen
 * before: a system process that stays stuck gets "Close" instead of "Wait".
 */
export function findSystemDialogs(
  screen: Screen,
  appLabel: string | null,
  repeats: (title: string) => number = () => 0,
): SystemDialog[] {
  const dialogs: SystemDialog[] = [];
  for (const window of screen.dump.windows) {
    if (window.package !== "android") continue;
    const nodes = screen.nodes.filter((n) => n && n.node.window === window.id);
    const buttons = nodes.filter((n) => AERR.test(n.node.rid ?? ""));
    if (buttons.length === 0) continue;
    const wait = buttons.find((n) => n.node.rid === WAIT) ?? null;
    const close = buttons.find((n) => n.node.rid === CLOSE) ?? null;
    const titleNode = nodes.find((n) => n.node.rid === "android:id/alertTitle");
    const title =
      clean(titleNode?.node.text) ||
      clean(window.title) ||
      clean(nodes.find((n) => n.role === "text" && n.text)?.text);
    const label = clean(appLabel);
    const owner = !label || title.includes(label) ? "app" : "other";
    const kind = wait ? "not_responding" : "crashed";
    const dismiss = kind === "not_responding" && repeats(title) < 2 ? wait : (close ?? wait);
    dialogs.push({ kind, title, owner, dismiss });
  }
  return dialogs;
}
