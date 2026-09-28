import "@testament/android/section";
import { resolve } from "node:path";
import { resolveConfig } from "@testament/config";
import { describe, expect, it } from "vitest";
import { cellLabel, engineKey, matrixOf, resolveTarget, type TargetCell } from "./target.js";

// The runner's target layer (MOB-1): which target a run tests, from the project,
// its environment and the run options.

function load(project: Record<string, unknown>, environment = "local") {
  const result = resolveConfig({ project: { version: 1, ...project }, env: {} });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(JSON.stringify(errors));
  const settings = result.config.environments[environment];
  if (!settings) throw new Error(`no ${environment}`);
  return { config: result.config, environment: { name: environment, settings } };
}

const android = (extra: Record<string, unknown> = {}, local: Record<string, unknown> = {}) =>
  load({
    project: { name: "App", target: "android" },
    environments: { local: { app: "build/app.apk", allowedDomains: ["10.0.2.2:4180"], ...local } },
    ...extra,
  });

describe("resolveTarget", () => {
  it("runs web projects in a browser on the environment's baseUrl", async () => {
    const { config, environment } = load({
      project: { name: "Site", target: "web" },
      environments: { local: { baseUrl: "http://127.0.0.1:4100" } },
    });
    expect(await resolveTarget("/p", config, environment, {})).toMatchObject({
      ok: true,
      target: {
        name: "web",
        baseUrl: "http://127.0.0.1:4100",
        cells: [{ target: "web", browser: "chromium", device: "desktop" }],
      },
    });
  });

  it("makes a web matrix of browsers × devices, one result id per entry", async () => {
    const { config, environment } = load({
      project: { name: "Site", target: "web" },
      environments: { local: { baseUrl: "http://127.0.0.1:4100" } },
    });
    const resolved = await resolveTarget("/p", config, environment, {
      browsers: ["chromium", "webkit", "chromium"],
      devices: ["desktop", "iphone-15"],
    });
    if (!resolved.ok) throw new Error(resolved.message);
    expect(resolved.target.cells.map(cellLabel)).toEqual([
      "chromium-desktop",
      "chromium-iphone-15",
      "webkit-desktop",
      "webkit-iphone-15",
    ]);
    expect(resolved.target.cells.map(engineKey)).toEqual([
      "chromium",
      "chromium",
      "webkit",
      "webkit",
    ]);
    expect(matrixOf(resolved.target.cells[3] as TargetCell)).toEqual({
      target: "web",
      browser: "webkit",
      device: "iphone-15",
    });
    expect(await resolveTarget("/p", config, environment, { devices: ["toaster"] })).toMatchObject({
      ok: false,
      message: expect.stringContaining("Unknown device toaster"),
    });
  });

  it("asks a web project for a baseUrl (the config check already does; a run says it too)", async () => {
    const { config, environment } = load({
      project: { name: "Site", target: "web" },
      environments: { local: { baseUrl: "http://127.0.0.1:4100" } },
    });
    const { baseUrl: _, ...settings } = environment.settings;
    expect(await resolveTarget("/p", config, { name: "local", settings }, {})).toEqual({
      ok: false,
      message: 'The environment "local" has no baseUrl. Choose one with --env, or set baseUrl.',
    });
  });

  it("runs Android projects on the app from `app:`, with the default version and device", async () => {
    const { config, environment } = android();
    expect(await resolveTarget("/p", config, environment, {})).toEqual({
      ok: true,
      target: {
        name: "android",
        apk: resolve("/p", "build/app.apk"),
        baseUrl: undefined,
        cells: [{ target: "android", androidVersion: "16", device: "pixel-8" }],
      },
    });
  });

  it("makes an Android matrix of versions × devices, one emulator per cell", async () => {
    const { config, environment } = android();
    const resolved = await resolveTarget("/p", config, environment, {
      androidVersions: ["15", "16"],
      devices: ["pixel-8", "small-phone"],
    });
    if (!resolved.ok) throw new Error(resolved.message);
    expect(resolved.target.cells.map(cellLabel)).toEqual([
      "android15-pixel-8",
      "android15-small-phone",
      "android16-pixel-8",
      "android16-small-phone",
    ]);
    expect(new Set(resolved.target.cells.map(engineKey)).size).toBe(4);
    expect(matrixOf(resolved.target.cells[0] as TargetCell)).toEqual({
      target: "android",
      androidVersion: "15",
      device: "pixel-8",
    });
  });

  it("takes the version and device from the project, the environment, then the run options", async () => {
    const first = (r: Awaited<ReturnType<typeof resolveTarget>>) =>
      r.ok ? r.target.cells[0] : undefined;
    const project = android({ android: { version: "15", device: "pixel-8" } });
    expect(first(await resolveTarget("/p", project.config, project.environment, {}))).toMatchObject(
      {
        androidVersion: "15",
      },
    );
    const env = android({ android: { version: "15" } }, { android: { version: "16" } });
    expect(first(await resolveTarget("/p", env.config, env.environment, {}))).toMatchObject({
      androidVersion: "16",
    });
    expect(
      first(await resolveTarget("/p", env.config, env.environment, { androidVersion: "15" })),
    ).toMatchObject({ androidVersion: "15" });
  });

  it("refuses unknown versions and device profiles, and a missing app", async () => {
    const { config, environment } = android();
    expect(await resolveTarget("/p", config, environment, { androidVersion: "9" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("Android 9 is not supported"),
    });
    expect(await resolveTarget("/p", config, environment, { device: "iphone-15" })).toMatchObject({
      ok: false,
      message: expect.stringContaining('"iphone-15" is not an Android device profile'),
    });
    const { app: _, ...settings } = environment.settings;
    expect(await resolveTarget("/p", config, { name: "local", settings }, {})).toMatchObject({
      ok: false,
      message: expect.stringContaining("has no app"),
    });
  });
});
