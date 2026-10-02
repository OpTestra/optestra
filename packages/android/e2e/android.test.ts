import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretValue, type SecretValue } from "@optestra/config/node";
import {
  ALLOWED_DOMAINS,
  APP_PACKAGE,
  apkPath,
  SHOP_PORT,
  type Variant,
} from "@optestra/fixture-android";
import { type RunningShop, startShop } from "@optestra/fixture-shop";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type AndroidActionOutcome,
  type AndroidSession,
  type LaunchedEmulator,
  launchEmulator,
  openAndroidSession,
  renderForModel,
} from "../src/index.js";

// The Android harness on a real emulator, against the Acme Shop fixture app. The
// app talks to the shop's server on this machine through the emulator's host
// alias (10.0.2.2:4180). Needs the Android SDK, a system image, the driver APK and
// the fixture APKs: see packages/android/README.md.

const PASSWORD = "shop-demo-pass";
let shop: RunningShop;
let emulator: LaunchedEmulator;
let secret: SecretValue;

async function seed(
  body: Record<string, unknown> = { projects: ["Website redesign", "Mobile launch"] },
) {
  await fetch(`${shop.url}/__test/reset?environment=1`, { method: "POST" });
  await fetch(`${shop.url}/__test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function open(
  variant: Variant = "correct",
  extra: Partial<Parameters<typeof openAndroidSession>[0]> = {},
): Promise<AndroidSession> {
  const opened = await openAndroidSession({
    apk: apkPath(variant),
    emulator,
    allowedDomains: [...ALLOWED_DOMAINS],
    secrets: { SHOP_PASSWORD: secret },
    ...extra,
  });
  if (!opened.ok) throw new Error(`${opened.reason}: ${opened.message}`);
  return opened.session;
}

/**
 * Signs in and insists it worked: each step's outcome is checked, and a failure
 * says everything the harness saw (the screen, requests, refusals, toasts, the
 * session's notes), so a failure on a slow CI emulator names its cause.
 */
async function signIn(session: AndroidSession) {
  const steps: AndroidActionOutcome[] = [];
  const report = async (why: string) => {
    const screen = await session.observe().catch(() => null);
    const lines = steps.map(
      (o) =>
        `${o.action.type} → ${o.status}${o.message ? ` (${o.message})` : ""}; url ${o.post.urlAfter}; ` +
        `added ${JSON.stringify(o.post.added.slice(0, 6))}; requests ${JSON.stringify(o.post.requests)}; ` +
        `refused ${JSON.stringify(o.post.refused)}; toasts ${JSON.stringify(o.post.toasts)}; app ${o.post.app}; ` +
        `settle ${JSON.stringify(o.settle)}`,
    );
    return [
      `sign-in failed: ${why}`,
      ...lines,
      `screen now: ${screen?.url} ${JSON.stringify(screen?.elements.map((e) => `${e.role} ${e.name}${e.text ? `: ${e.text}` : ""}`))}`,
      `session: ${JSON.stringify({ notes: session.timings().notes, dialogs: session.timings().systemDialogs })}`,
    ].join("\n  ");
  };
  for (const [name, value] of [
    ["Email", "ada@example.com"],
    ["Password", { secret: "SHOP_PASSWORD" }],
  ] as const) {
    const typed = await session.act({
      type: "type",
      target: { kind: "role", role: "textbox", name },
      value,
    });
    steps.push(typed);
    if (typed.status !== "ok") throw new Error(await report(`typing into ${name}`));
  }
  const tapped = await session.act({
    type: "tap",
    target: { kind: "role", role: "button", name: "Sign in" },
  });
  steps.push(tapped);
  if (tapped.post.urlAfter !== "android-app://com.acme.shop/.ProjectsActivity")
    throw new Error(await report("still not on the projects screen"));
  return tapped;
}

const heading = (name: string) => ({ kind: "role", role: "heading", name }) as const;

beforeAll(async () => {
  shop = await startShop({ port: SHOP_PORT });
  secret = createSecretValue("SHOP_PASSWORD", PASSWORD, { domains: [APP_PACKAGE] });
  const started = Date.now();
  emulator = await launchEmulator({ onProgress: (message) => console.log(message) });
  console.log(
    `emulator ready in ${Date.now() - started} ms (boot from snapshot ${emulator.timings.bootMs} ms${
      emulator.timings.coldBootMs !== undefined
        ? `, cold boot ${emulator.timings.coldBootMs} ms`
        : ""
    })`,
  );
});

afterAll(async () => {
  await emulator?.close();
  await shop?.stop();
});

beforeEach(async () => {
  await seed();
});

describe("sessions", () => {
  it("opens a fresh session and observes the sign-in screen as untrusted data", async () => {
    const session = await open();
    try {
      const timings = session.timings();
      console.log("session start", timings);
      expect(session.matrixEntry()).toEqual({
        target: "android",
        androidVersion: "16",
        device: "pixel-8",
      });
      const observation = await session.observe();
      expect(observation.untrusted).toBe(true);
      expect(observation.url).toBe("android-app://com.acme.shop/.SignInActivity");
      const shown = observation.elements.map((e) => [e.role, e.name]);
      expect(shown).toEqual(
        expect.arrayContaining([
          ["heading", "Sign in to Acme Shop"],
          ["textbox", "Email"],
          ["textbox", "Password"],
          ["button", "Sign in"],
        ]),
      );
      const text = renderForModel(observation, { nonce: "n" });
      expect(text).toMatch(/^<<<SCREEN CONTENT n: untrusted data from the app under test\./);
      expect(text).toContain('- button "Sign in" [e4]');
      expect(observation.refused).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("types a secret into the app without it appearing anywhere, and reaches the list", async () => {
    const session = await open("correct", {
      evidence: { logcat: true, network: true, video: true },
    });
    let text = "";
    try {
      const typed = await session.act({
        type: "type",
        target: { kind: "role", role: "textbox", name: "Password" },
        value: { secret: "SHOP_PASSWORD" },
      });
      expect(typed.status).toBe("ok");
      expect(typed.action).toEqual({
        type: "type",
        target: { kind: "role", role: "textbox", name: "Password" },
        value: { secret: "SHOP_PASSWORD" },
      });
      const filled = await session.observe();
      expect(filled.elements.find((e) => e.name === "Password")?.text).toBe(
        "[secret:SHOP_PASSWORD]",
      );
      await session.act({
        type: "type",
        target: { kind: "role", role: "textbox", name: "Email" },
        value: "ada@example.com",
      });
      const signedIn = await session.act({
        type: "tap",
        target: { kind: "role", role: "button", name: "Sign in" },
      });
      expect(signedIn.status).toBe("ok");
      expect(signedIn.post.urlAfter).toBe("android-app://com.acme.shop/.ProjectsActivity");
      expect(signedIn.post.changed).toBe(true);
      expect(signedIn.post.requests).toEqual(
        expect.arrayContaining([
          { method: "POST", url: "http://10.0.2.2:4180/login", resourceType: "http", status: 303 },
          {
            method: "GET",
            url: "http://10.0.2.2:4180/api/projects",
            resourceType: "http",
            status: 200,
          },
        ]),
      );
      const list = await session.observe();
      expect(list.elements.filter((e) => e.role === "listitem").map((e) => e.name)).toEqual([
        "Website redesign",
        "Mobile launch",
      ]);
      text = JSON.stringify([typed, filled, signedIn, list]);
    } finally {
      const { evidence } = await session.close();
      expect(evidence.map((e) => e.kind).sort()).toEqual(["logcat", "network", "video"]);
      for (const file of evidence) {
        if (file.kind === "video") continue;
        const content = readFileSync(file.path, "utf8");
        expect(content, file.kind).not.toContain(PASSWORD);
        text += content;
      }
    }
    expect(text).not.toContain(PASSWORD);
  });

  it("refuses to type a secret into an app it isn't declared for", async () => {
    const other = createSecretValue("OTHER_PASSWORD", "other-secret-value", {
      domains: ["com.example.other"],
    });
    const session = await open("correct", {
      secrets: { SHOP_PASSWORD: secret, OTHER_PASSWORD: other },
    });
    try {
      const outcome = await session.act({
        type: "type",
        target: { kind: "role", role: "textbox", name: "Password" },
        value: { secret: "OTHER_PASSWORD" },
      });
      expect(outcome.status).toBe("refused");
      expect(outcome.reason).toBe("disallowed_domain");
      const missing = await session.act({
        type: "type",
        target: { kind: "role", role: "textbox", name: "Password" },
        value: { secret: "NOT_LOADED" },
      });
      expect(missing.reason).toBe("missing_secret");
      const observation = await session.observe();
      expect(observation.elements.find((e) => e.name === "Password")?.text).toBe("");
    } finally {
      await session.close();
    }
  });

  it("installs the app fresh for every session: a permission granted before is asked again", async () => {
    for (const round of [1, 2]) {
      const session = await open();
      try {
        // Every step's outcome is asserted, so a failure says which step and why.
        const describe = (o: {
          status: string;
          message?: string;
          ms: number;
          settle: unknown;
          post: unknown;
        }) =>
          `round ${round}: ${o.status} ${o.message ?? ""} ms=${o.ms} settle=${JSON.stringify(o.settle)} ${JSON.stringify(o.post)}`;
        const signedIn = await signIn(session);
        expect(signedIn.post.urlAfter, describe(signedIn)).toBe(
          "android-app://com.acme.shop/.ProjectsActivity",
        );
        const project = await session.act({
          type: "tap",
          target: { kind: "role", role: "listitem", name: "Website redesign" },
        });
        expect(project.post.urlAfter, describe(project)).toBe(
          "android-app://com.acme.shop/.ProjectActivity",
        );
        const asked = await session.act({
          type: "tap",
          target: { kind: "role", role: "button", name: "Scan badge" },
        });
        expect(asked.status, describe(asked)).toBe("ok");
        expect(
          asked.post.dialogs.map((d) => d.type),
          describe(asked),
        ).toEqual(["permission"]);
        const allowed = await session.act({ type: "permission", decision: "allow" });
        expect(allowed.status).toBe("ok");
        const status = await session.check({
          type: "text",
          target: { kind: "text", text: "Camera access allowed" },
          match: "equals",
          value: "Camera access allowed",
        });
        expect(status.passed).toBe(true);
      } finally {
        await session.close();
      }
    }
  });

  it("returns app install trouble as data", async () => {
    const bogus = join(tmpdir(), "not-an-app.apk");
    writeFileSync(bogus, "this is not an APK");
    const opened = await openAndroidSession({ apk: bogus, emulator, allowedDomains: [] });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe("app_install_failed");
      expect(opened.message).toMatch(/INSTALL_|did not install/);
    }
    const missing = await openAndroidSession({
      apk: join(tmpdir(), "no-such.apk"),
      emulator,
      allowedDomains: [],
    });
    expect(missing.ok).toBe(false);
  });
});

describe("actions", () => {
  it("taps, types, scrolls, swipes, goes back and home, and rotates", async () => {
    const session = await open();
    try {
      await signIn(session);
      const settings = await session.act({
        type: "tap",
        target: { kind: "role", role: "button", name: "Settings" },
      });
      expect(settings.post.urlAfter).toBe("android-app://com.acme.shop/.SettingsActivity");
      // The switch toggles.
      const toggled = await session.act({
        type: "tap",
        target: { kind: "role", role: "switch", name: "Email notifications" },
      });
      expect(toggled.post.changed).toBe(true);
      expect(
        (
          await session.check({
            type: "element_state",
            target: { kind: "role", role: "switch" },
            state: "unchecked",
          })
        ).passed,
      ).toBe(true);
      // Swipe up, then scroll the button into view and tap it.
      const swiped = await session.act({ type: "swipe", direction: "up" });
      expect(swiped.status).toBe("ok");
      const scrolled = await session.act({
        type: "scroll",
        target: { kind: "role", role: "button", name: "Check for updates" },
      });
      expect(scrolled.status).toBe("ok");
      const check = await session.act({
        type: "tap",
        target: { kind: "role", role: "button", name: "Check for updates" },
      });
      expect(check.status).toBe("ok");
      // The update host is outside the allowed domains: the guard refused it, nothing was sent.
      const refused = await session.check(
        {
          type: "text",
          target: { kind: "text", text: "Couldn't check for updates." },
          match: "equals",
          value: "Couldn't check for updates.",
        },
        { timeoutMs: 8_000 },
      );
      expect(refused.passed).toBe(true);
      expect(session.refusals().map((r) => [r.type, r.url])).toContainEqual([
        "proxy",
        "https://203.0.113.7/",
      ]);
      // Back to the list.
      const back = await session.act({ type: "back" });
      expect(back.post.urlAfter).toBe("android-app://com.acme.shop/.ProjectsActivity");
      // Rotate.
      await session.act({ type: "rotate", orientation: "landscape" });
      expect((await session.observe()).rotation).toBe(90);
      await session.act({ type: "rotate", orientation: "portrait" });
      expect((await session.observe()).rotation).toBe(0);
      // Home leaves the app; the launcher can't be touched; launch_app comes back.
      await session.act({ type: "home" });
      const home = await session.observe();
      expect(home.url.startsWith("android-app://com.acme.shop")).toBe(false);
      const firstOnLauncher = home.elements.find((e) => e.ref && e.interactive);
      if (firstOnLauncher?.ref) {
        const outside = await session.act({ type: "tap", target: { ref: firstOnLauncher.ref } });
        expect(outside.status).toBe("refused");
        expect(outside.reason).toBe("outside_app");
      }
      const relaunched = await session.act({ type: "launch_app" });
      expect(relaunched.post.urlAfter.startsWith("android-app://com.acme.shop/")).toBe(true);
      // Long press is an action too (the list item has no long-press menu, so nothing changes).
      const pressed = await session.act({
        type: "long_press",
        target: { kind: "role", role: "listitem", name: "Mobile launch" },
      });
      expect(pressed.status).toBe("ok");
    } finally {
      await session.close();
    }
  });

  it("gives candidates and element facts for a ref", async () => {
    const session = await open();
    try {
      const observation = await session.observe();
      const ref =
        observation.elements.find((e) => e.name === "Sign in" && e.role === "button")?.ref ?? "";
      const result = await session.candidates(ref);
      expect(result.status).toBe("ok");
      expect(result.candidates[0]).toEqual({
        locator: { kind: "role", role: "button", name: "Sign in", exact: true },
        unique: true,
        matches: 1,
      });
      expect(result.candidates.map((c) => c.locator.kind)).toEqual([
        "role",
        "testId",
        "text",
        "css",
      ]);
      expect(result.candidates.find((c) => c.locator.kind === "testId")?.locator).toEqual({
        kind: "testId",
        value: "sign_in_button",
      });
      expect(result.facts).toMatchObject({
        role: "button",
        name: "Sign in",
        tag: "android.widget.Button",
        anchorText: "Sign in to Acme Shop",
        attributes: { "resource-id": "com.acme.shop:id/sign_in_button", package: "com.acme.shop" },
      });
    } finally {
      await session.close();
    }
  });

  it("the silent-tap trap: a tap that does nothing reports changed: false", async () => {
    const session = await open("broken-silent-tap");
    try {
      await signIn(session);
      await session.act({
        type: "tap",
        target: { kind: "role", role: "button", name: "New project" },
      });
      await session.act({
        type: "type",
        target: { kind: "role", role: "textbox", name: "Project name" },
        value: "Q3 roadmap",
      });
      const created = await session.act({
        type: "tap",
        target: { kind: "role", role: "button", name: "Create project" },
      });
      expect(created.status).toBe("ok");
      expect(created.post).toMatchObject({
        added: [],
        removed: [],
        requests: [],
        toasts: [],
        dialogs: [],
        changed: false,
      });
    } finally {
      await session.close();
    }
  });

  it("a working tap shows its effect: request, toast and screen change", async () => {
    const session = await open();
    try {
      await signIn(session);
      await session.act({
        type: "tap",
        target: { kind: "role", role: "button", name: "New project" },
      });
      await session.act({
        type: "type",
        target: { kind: "role", role: "textbox", name: "Project name" },
        value: "Q3 roadmap",
      });
      const mark = session.requestMark();
      const created = await session.act({
        type: "tap",
        target: { kind: "role", role: "button", name: "Create project" },
      });
      expect(created.post.changed).toBe(true);
      expect(created.post.toasts).toEqual(["Project created"]);
      expect(created.post.urlAfter).toBe("android-app://com.acme.shop/.ProjectsActivity");
      const network = await session.check(
        { type: "network", method: "POST", url: "/api/projects", status: 201 },
        { since: mark },
      );
      expect(network.passed).toBe(true);
      const list = await session.check({
        type: "count",
        target: { kind: "role", role: "listitem" },
        n: 3,
      });
      expect(list.passed).toBe(true);
      const url = await session.check({ type: "url", match: "is", value: ".ProjectsActivity" });
      expect(url.passed).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("opens deep links into the app only, and refuses links outside the allowed domains", async () => {
    const session = await open();
    try {
      await signIn(session);
      const opened = await session.act({
        type: "open_deep_link",
        url: "acmeshop://projects/Mobile%20launch",
      });
      expect(opened.status).toBe("ok");
      expect(
        (
          await session.check({
            type: "text",
            target: heading("Mobile launch"),
            match: "equals",
            value: "Mobile launch",
          })
        ).passed,
      ).toBe(true);
      const web = await session.act({ type: "open_deep_link", url: "https://example.com/" });
      expect(web.status).toBe("refused");
      expect(web.reason).toBe("disallowed_domain");
      const file = await session.act({ type: "open_deep_link", url: "file:///sdcard/secret.txt" });
      expect(file.reason).toBe("invalid_action");
    } finally {
      await session.close();
    }
  });

  it("denies a permission when asked to", async () => {
    const session = await open();
    try {
      await signIn(session);
      await session.act({ type: "open_deep_link", url: "acmeshop://projects/Website%20redesign" });
      await session.act({
        type: "tap",
        target: { kind: "role", role: "button", name: "Scan badge" },
      });
      const denied = await session.act({ type: "permission", decision: "deny" });
      expect(denied.status).toBe("ok");
      const status = await session.check({
        type: "text",
        target: { kind: "text", text: "Camera access denied" },
        match: "equals",
        value: "Camera access denied",
      });
      expect(status.passed).toBe(true);
      const none = await session.act({ type: "permission", decision: "allow" });
      expect(none.status).toBe("not_found");
    } finally {
      await session.close();
    }
  });

  it("shows dialogs, and an app crash comes back as an outcome", async () => {
    const session = await open("broken-crash");
    try {
      await signIn(session);
      const dialog = await session.act({
        type: "tap",
        target: { kind: "role", role: "button", name: "Sign out" },
      });
      expect(dialog.post.dialogs).toEqual([{ type: "dialog", message: "Sign out of Acme Shop?" }]);
      const observed = await session.observe();
      expect(observed.elements[0]).toMatchObject({
        role: "dialog",
        name: "Sign out of Acme Shop?",
      });
      await session.act({ type: "tap", target: { kind: "role", role: "button", name: "CANCEL" } });
      const crashed = await session.act({
        type: "tap",
        target: { kind: "role", role: "listitem", name: "Website redesign" },
      });
      expect(crashed.status).toBe("error");
      expect(crashed.problem).toBe("app_crashed");
      expect(crashed.post.app).toBe("crashed");
      expect(crashed.message).toMatch(/crashed.*IllegalStateException/);
    } finally {
      await session.close();
    }
  });

  it("takes screenshots for a model and for evidence", async () => {
    const session = await open();
    try {
      const model = await session.screenshot({ forModel: true });
      expect(model.contentType).toBe("image/jpeg");
      expect([...model.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      const full = await session.screenshot();
      expect(full.contentType).toBe("image/png");
      expect([...full.bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
      const button = await session.screenshot({
        target: { kind: "role", role: "button", name: "Sign in" },
      });
      expect(button.status).toBe("ok");
      expect(button.bytes.length).toBeLessThan(full.bytes.length);
    } finally {
      await session.close();
    }
  });
});

describe("the device's network on slow machines (MOB-3)", () => {
  // On a slow x86 machine the restored snapshot's network came back seconds after
  // the session started: the app's sign-in failed on the device, the guard saw
  // nothing ("requests []"), and the app only said "Can't reach Acme Shop". The
  // test (not the harness) takes the network down with raw adb to make that state.
  const adb = (...args: string[]) =>
    spawnSync(emulator.sdk.adb, ["-s", emulator.serial, ...args], { encoding: "utf8" });
  const routes = () => adb("shell", "ip route get 10.0.2.2").status === 0;

  it("starts a session only once the device's network is up", async () => {
    const session = await open();
    try {
      expect(routes()).toBe(true);
      expect(session.timings().networkMs).toBeGreaterThanOrEqual(0);
      const signedIn = await signIn(session);
      expect(signedIn.post.requests.length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it("names the cause when the app's request can't leave an offline device", async () => {
    const session = await open();
    try {
      adb("shell", "svc data disable; svc wifi disable");
      for (let i = 0; i < 40 && routes(); i++) await sleep(250);
      expect(routes()).toBe(false);
      await session.act({
        type: "type",
        target: { kind: "role", role: "textbox", name: "Email" },
        value: "ada@example.com",
      });
      await session.act({
        type: "type",
        target: { kind: "role", role: "textbox", name: "Password" },
        value: { secret: "SHOP_PASSWORD" },
      });
      const tapped = await session.act({
        type: "tap",
        target: { kind: "role", role: "button", name: "Sign in" },
      });
      expect(tapped.post.requests).toEqual([]);
      expect(tapped.message).toMatch(/device had no network after tap/);
      expect(session.timings().notes.join("\n")).toMatch(/device had no network/);
    } finally {
      adb("shell", "svc data enable; svc wifi enable");
      await session.close();
    }
  });
});

describe("the foreground on slow machines (mob-0-ci2)", () => {
  // The test (not the harness) sends a HOME intent with raw adb, as the launcher
  // coming to the front by itself after a cold boot does on a slow CI emulator.
  const adb = (...args: string[]) =>
    spawnSync(emulator.sdk.adb, ["-s", emulator.serial, ...args], { encoding: "utf8" }).stdout;

  it("brings the app back when a launcher takes the foreground by itself, and notes it", async () => {
    await seed({ projects: ["Website redesign"] });
    const session = await open();
    try {
      adb(
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.HOME",
      );
      await sleep(2_000);
      const signedIn = await signIn(session);
      expect(signedIn.post.urlAfter).toBe("android-app://com.acme.shop/.ProjectsActivity");
      expect(session.timings().notes.join(" ")).toMatch(/came to the front by itself/);
    } finally {
      await session.close();
    }
  });

  it("brings the app back as it was: what the test typed is still there (MOB-2)", async () => {
    // CI: the launcher came to the front mid sign-in; the restore then showed a
    // fresh sign-in screen, and "Sign in" was tapped with empty fields.
    await seed({ projects: ["Website redesign"] });
    const session = await open();
    try {
      for (const [name, value] of [
        ["Email", "ada@example.com"],
        ["Password", { secret: "SHOP_PASSWORD" }],
      ] as const) {
        const typed = await session.act({
          type: "type",
          target: { kind: "role", role: "textbox", name },
          value,
        });
        expect(typed.status, `${name}: ${typed.message ?? ""}`).toBe("ok");
      }
      adb(
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.HOME",
      );
      await sleep(2_000);
      const tapped = await session.act({
        type: "tap",
        target: { kind: "role", role: "button", name: "Sign in" },
      });
      expect(tapped.post.urlAfter, tapped.message ?? "").toBe(
        "android-app://com.acme.shop/.ProjectsActivity",
      );
      expect(session.timings().notes.join(" ")).toMatch(/came to the front by itself/);
    } finally {
      await session.close();
    }
  });

  it("leaves the launcher in front when the test itself went home", async () => {
    const session = await open();
    try {
      const home = await session.act({ type: "home" });
      expect(home.status).toBe("ok");
      const seen = await session.observe();
      expect(seen.url).not.toContain("com.acme.shop");
      expect(session.timings().notes.join(" ")).not.toMatch(/came to the front by itself/);
    } finally {
      await session.close();
    }
  });
});

describe("locale and timezone (ENV-5)", () => {
  const adb = (...args: string[]) =>
    spawnSync(emulator.sdk.adb, ["-s", emulator.serial, ...args], { encoding: "utf8" }).stdout;

  it("sets the device's timezone and the app's language for the session only", async () => {
    const session = await open("correct", { timezone: "Europe/Berlin", locale: "de-DE" });
    try {
      expect(adb("shell", "getprop", "persist.sys.timezone").trim()).toBe("Europe/Berlin");
      expect(adb("shell", "cmd", "locale", "get-app-locales", "com.acme.shop")).toContain("de-DE");
    } finally {
      await session.close();
    }
    const next = await open();
    try {
      expect(adb("shell", "getprop", "persist.sys.timezone").trim()).not.toBe("Europe/Berlin");
    } finally {
      await next.close();
    }
  });

  it("refuses a timezone or locale that isn't one", async () => {
    await expect(open("correct", { timezone: "Mars/Olympus" })).rejects.toThrow(/not a timezone/);
    await expect(open("correct", { locale: "not a locale" })).rejects.toThrow(/not a locale/);
  });
});

describe("system dialogs on slow machines", () => {
  // The test (not the harness) freezes a process with raw adb, so Android shows its
  // "isn't responding" dialog, as it does for System UI on a slow CI emulator.
  const adb = (...args: string[]) =>
    spawnSync(emulator.sdk.adb, ["-s", emulator.serial, ...args], {
      encoding: "utf8",
    }).stdout.trim();
  async function waitForAnrDialog() {
    for (let i = 0; i < 20; i++) {
      if (
        /Application Not Responding|isn.t responding/.test(
          adb("shell", "dumpsys", "window", "windows"),
        )
      )
        return;
      await sleep(1_000);
    }
    throw new Error("no ANR dialog appeared");
  }

  it("dismisses another package's ANR dialog before the test sees the screen, and reports it", async () => {
    const session = await open();
    const pid = adb("shell", "pidof", "com.android.systemui");
    try {
      adb("shell", "kill", "-STOP", pid);
      adb("shell", "input", "swipe", "540", "5", "540", "900");
      await sleep(1_000);
      adb("shell", "input", "tap", "540", "40");
      await waitForAnrDialog();
      adb("shell", "kill", "-CONT", pid);
      const observation = await session.observe();
      expect(observation.elements.map((e) => e.name)).toContain("Sign in to Acme Shop");
      expect(observation.elements.some((e) => e.role === "alertdialog")).toBe(false);
      expect(session.timings().systemDialogs).toEqual([
        expect.objectContaining({
          title: "System UI isn't responding",
          kind: "not_responding",
          action: "wait",
        }),
      ]);
    } finally {
      adb("shell", "kill", "-CONT", pid);
      await session.close();
    }
  });

  it("never dismisses a dialog about the app under test", async () => {
    const session = await open();
    const pid = adb("shell", "pidof", "com.acme.shop");
    try {
      adb("shell", "kill", "-STOP", pid);
      adb("shell", "input", "tap", "540", "1200");
      await waitForAnrDialog();
      const observation = await session.observe();
      expect(observation.elements[0]).toMatchObject({
        role: "alertdialog",
        name: "Acme Shop isn't responding",
      });
      expect(session.timings().systemDialogs).toEqual([]);
    } finally {
      adb("shell", "kill", "-CONT", pid);
      await session.close();
    }
  });
});
