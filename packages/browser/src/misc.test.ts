import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_DEVICE, DEVICE_PRESETS, deviceOptions, UnknownDeviceError } from "./devices.js";
import * as api from "./index.js";
import { Session } from "./session.js";
import { ACTION_TYPES } from "./types.js";
import { readZip, writeZip } from "./zip.js";

describe("public API (SAF-2: the closed action set)", () => {
  it("exports only the harness, with no way to run code, make requests or read files", () => {
    expect(Object.keys(api).sort()).toEqual([
      "ACTION_TYPES",
      "Allowlist",
      "BROWSER_NAMES",
      "BrowserSetupError",
      "DEFAULT_DEVICE",
      "DEVICE_PRESETS",
      "LaunchedBrowser",
      "PageCopy",
      "RequestMark",
      "Session",
      "UnknownDeviceError",
      "installBrowsers",
      "launchBrowser",
      "openSession",
      "renderForModel",
    ]);
  });

  it("offers exactly these session methods, and no Playwright object", () => {
    const methods = Object.getOwnPropertyNames(Session.prototype).sort();
    expect(methods).toEqual([
      "act",
      "browserName",
      "candidates",
      "check",
      "close",
      "consoleErrors",
      "constructor",
      "factsOf",
      "hookRequest",
      "inspect",
      "mock",
      "mockUses",
      "observe",
      "pageCopy",
      "record",
      "refusals",
      "requestMark",
      "screenshot",
      "settle",
      "storageState",
      "traffic",
      "unsettled",
      "url",
      "useStorageState",
    ]);
    expect(Object.getOwnPropertyNames(api.LaunchedBrowser.prototype).sort()).toEqual([
      "close",
      "connected",
      "constructor",
    ]);
  });

  it("has a closed list of actions", () => {
    expect([...ACTION_TYPES].sort()).toEqual([
      "back",
      "check",
      "click",
      "dblclick",
      "fill",
      "goto",
      "hover",
      "press",
      "reload",
      "scroll",
      "select",
      "uncheck",
      "upload",
      "waitFor",
    ]);
    const source = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
    // Every action type has a case, and the switch refuses anything else.
    for (const type of ACTION_TYPES) expect(source).toContain(`case "${type}":`);
    expect(source).toContain('refused(\n          "invalid_action",');
  });
});

describe("device presets (TGT-3, TGT-6)", () => {
  it("covers desktop, laptop, tablet and phones, all resolvable on every engine", () => {
    const categories = new Set(Object.values(DEVICE_PRESETS).map((p) => p.category));
    expect([...categories].sort()).toEqual(["desktop", "laptop", "phone", "tablet"]);
    expect(DEVICE_PRESETS[DEFAULT_DEVICE]).toBeDefined();
    for (const name of Object.keys(DEVICE_PRESETS)) {
      for (const browser of ["chromium", "firefox", "webkit"] as const) {
        expect(deviceOptions(name, browser).viewport, `${name} on ${browser}`).toBeDefined();
      }
    }
  });

  it("maps phones to Playwright descriptors and drops mobile emulation on Firefox", () => {
    expect(deviceOptions("pixel-8", "chromium")).toMatchObject({ isMobile: true, hasTouch: true });
    expect(deviceOptions("pixel-8", "firefox").isMobile).toBeUndefined();
    expect(deviceOptions("desktop", "chromium", { width: 800, height: 600 }).viewport).toEqual({
      width: 800,
      height: 600,
    });
    expect(() => deviceOptions("nokia-3310", "chromium")).toThrow(UnknownDeviceError);
  });
});

describe("zip", () => {
  it("round-trips entries, stored and deflated", () => {
    const text = new TextEncoder().encode("hello ".repeat(200));
    const binary = new Uint8Array([0, 1, 2, 255]);
    const entries = [
      { name: "0-trace.trace", data: text },
      { name: "resources/abc.dat", data: binary },
      { name: "empty", data: new Uint8Array() },
    ];
    const zip = writeZip(entries);
    expect(zip.byteLength).toBeLessThan(text.byteLength);
    expect(readZip(zip)).toEqual(entries);
  });

  it("refuses data that isn't a zip", () => {
    expect(() => readZip(new TextEncoder().encode("not a zip at all, sorry"))).toThrow(/not a zip/);
  });
});
