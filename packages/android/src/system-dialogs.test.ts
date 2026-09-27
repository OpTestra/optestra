import { describe, expect, it } from "vitest";
import type { DriverNode, DriverWindow, Dump } from "./driver.js";
import { Screen } from "./hierarchy.js";
import { findSystemDialogs } from "./system-dialogs.js";

// The dialogs as Android draws them: a window of the "android" package with the
// framework's aerr_* buttons (seen on a CI emulator: "System UI isn't responding").

function dialog(title: string, buttons: [string, string][], appWindow = true): Dump {
  const windows: DriverWindow[] = [
    {
      id: 0,
      type: "application",
      layer: 2,
      active: true,
      focused: true,
      title,
      package: "android",
      cls: "com.android.server.am.AppNotRespondingDialog",
      bounds: [60, 800, 1020, 1500],
    },
  ];
  const nodes: DriverNode[] = [
    {
      id: 0,
      parent: -1,
      window: 0,
      depth: 0,
      cls: "android.widget.FrameLayout",
      pkg: "android",
      bounds: [60, 800, 1020, 1500],
      flags: ["enabled", "visible"],
    },
    {
      id: 1,
      parent: 0,
      window: 0,
      depth: 1,
      cls: "android.widget.TextView",
      pkg: "android",
      rid: "android:id/alertTitle",
      text: title,
      bounds: [100, 850, 980, 950],
      flags: ["enabled", "visible"],
    },
    ...buttons.map(
      ([rid, text], i): DriverNode => ({
        id: 2 + i,
        parent: 0,
        window: 0,
        depth: 1,
        cls: "android.widget.Button",
        pkg: "android",
        rid,
        text,
        bounds: [100, 1000 + i * 150, 980, 1120 + i * 150],
        flags: ["clickable", "enabled", "focusable", "visible"],
      }),
    ),
  ];
  if (appWindow) {
    windows.push({
      id: 1,
      type: "application",
      layer: 1,
      active: false,
      focused: false,
      title: "Acme Shop",
      package: "com.acme.shop",
      cls: "com.acme.shop.SignInActivity",
      bounds: [0, 0, 1080, 2400],
    });
    nodes.push({
      id: 10,
      parent: -1,
      window: 1,
      depth: 0,
      cls: "android.widget.FrameLayout",
      pkg: "com.acme.shop",
      bounds: [0, 0, 1080, 2400],
      flags: ["enabled", "visible"],
    });
  }
  return {
    windows,
    nodes,
    truncated: false,
    activity: "com.acme.shop/.SignInActivity",
    rotation: 0,
  };
}

const anr: [string, string][] = [
  ["android:id/aerr_close", "Close app"],
  ["android:id/aerr_wait", "Wait"],
];
const crash: [string, string][] = [
  ["android:id/aerr_close", "Close app"],
  ["android:id/aerr_app_info", "App info"],
];
const screen = (dump: Dump) => new Screen(dump, { appPackage: "com.acme.shop" });

describe("system ANR and crash dialogs", () => {
  it("finds another package's ANR dialog and presses Wait", () => {
    const [found] = findSystemDialogs(
      screen(dialog("System UI isn't responding", anr)),
      "Acme Shop",
    );
    expect(found).toMatchObject({
      kind: "not_responding",
      title: "System UI isn't responding",
      owner: "other",
    });
    expect(found?.dismiss?.node.rid).toBe("android:id/aerr_wait");
  });

  it("closes an ANR that keeps coming back, and a crash dialog", () => {
    const [stuck] = findSystemDialogs(
      screen(dialog("Pixel Launcher isn't responding", anr)),
      "Acme Shop",
      () => 2,
    );
    expect(stuck?.dismiss?.node.rid).toBe("android:id/aerr_close");
    const [crashed] = findSystemDialogs(
      screen(dialog("Pixel Launcher keeps stopping", crash)),
      "Acme Shop",
    );
    expect(crashed).toMatchObject({ kind: "crashed", owner: "other" });
    expect(crashed?.dismiss?.node.rid).toBe("android:id/aerr_close");
  });

  it("never treats a dialog about the app under test as foreign, nor any when the label is unknown", () => {
    expect(
      findSystemDialogs(screen(dialog("Acme Shop isn't responding", anr)), "Acme Shop")[0]?.owner,
    ).toBe("app");
    expect(
      findSystemDialogs(screen(dialog("Acme Shop keeps stopping", crash)), "Acme Shop")[0]?.owner,
    ).toBe("app");
    expect(
      findSystemDialogs(screen(dialog("System UI isn't responding", anr)), null)[0]?.owner,
    ).toBe("app");
  });

  it("ignores the app's own dialogs and ordinary screens", () => {
    const own = dialog("Sign out of Acme Shop?", [["android:id/button1", "SIGN OUT"]]);
    for (const w of own.windows) if (w.package === "android") w.package = "com.acme.shop";
    expect(findSystemDialogs(screen(own), "Acme Shop")).toEqual([]);
    const plain = dialog("Acme Shop", [], true);
    plain.windows = plain.windows.filter((w) => w.package !== "android");
    expect(findSystemDialogs(screen(plain), "Acme Shop")).toEqual([]);
  });
});
