import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { avdConfig } from "./emulator.js";
import { COUNTERS_COMMAND, firewallRules, parseCounters, resetRules } from "./firewall.js";
import * as api from "./index.js";
import { Logcat } from "./logcat.js";
import { ANDROID_VERSIONS, DEVICE_PROFILES, findSdk, systemImages } from "./sdk.js";
import { AndroidSession } from "./session.js";
import { androidSetupPlan } from "./setup.js";
import { ADB_COMMANDS, adbArgs, emulatorArgs, InvalidToolCommand, SAFE_TOKEN } from "./tools.js";
import { ANDROID_ACTION_TYPES } from "./types.js";

describe("public API (SAF-2: the closed action set)", () => {
  it("exports only the harness, with no adb, shell, driver or network object", () => {
    expect(Object.keys(api).sort()).toEqual([
      "ANDROID_ACTION_TYPES",
      "ANDROID_VERSIONS",
      "AndroidRequestMark",
      "AndroidSession",
      "AndroidSetupError",
      "DEFAULT_ANDROID_VERSION",
      "DEFAULT_DEVICE_PROFILE",
      "DEVICE_PROFILES",
      "LaunchedEmulator",
      "ScreenCopy",
      "androidDoctor",
      "androidSetupPlan",
      "installAndroidSdk",
      "launchEmulator",
      "openAndroidSession",
      "renderForModel",
    ]);
  });

  it("offers exactly these session methods", () => {
    expect(Object.getOwnPropertyNames(AndroidSession.prototype).sort()).toEqual([
      "act",
      "appPackage",
      "candidates",
      "check",
      "close",
      "constructor",
      "device",
      "matrixEntry",
      "observe",
      "refusals",
      "requestMark",
      "screenCopy",
      "screenshot",
      "settle",
      "timings",
      "url",
    ]);
  });

  it("has a closed list of actions, each handled, anything else refused", () => {
    expect([...ANDROID_ACTION_TYPES].sort()).toEqual([
      "back",
      "clear",
      "click",
      "fill",
      "home",
      "launch_app",
      "long_press",
      "open_deep_link",
      "permission",
      "press",
      "rotate",
      "scroll",
      "swipe",
      "tap",
      "type",
      "waitFor",
    ]);
    const source = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
    for (const type of ANDROID_ACTION_TYPES) expect(source).toContain(`case "${type}":`);
    expect(source).toContain('"invalid_action",\n          `Unknown action');
  });
});

describe("the adb wrapper (guarantee 5)", () => {
  it("runs a closed list of commands", () => {
    expect([...ADB_COMMANDS]).toEqual([
      "devices",
      "wait-for-device",
      "getprop",
      "root",
      "whoami",
      "install",
      "list-packages",
      "forward",
      "forward-remove",
      "instrument",
      "logcat",
      "logcat-clear",
      "logcat-mark",
      "prepare-device",
      "firewall",
      "emu",
    ]);
    const source = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");
    for (const name of ADB_COMMANDS) expect(source).toContain(`case "${name}":`);
    expect(source).toContain("shell: false,");
    expect(source).not.toMatch(/shell:\s*true|execSync|execFile|\bexec\(/);
    expect([...source.matchAll(/spawn\(/g)]).toHaveLength(1);
  });

  it("builds fixed argv and rejects anything that could reach a shell", () => {
    expect(adbArgs({ name: "install", apk: "/tmp/app.apk" })).toEqual([
      "install",
      "-r",
      "-t",
      "/tmp/app.apk",
    ]);
    expect(adbArgs({ name: "forward", socket: "uih-abc" })).toEqual([
      "forward",
      "tcp:0",
      "localabstract:uih-abc",
    ]);
    expect(adbArgs({ name: "logcat-mark", mark: 3 })).toEqual([
      "shell",
      "log",
      "-t",
      "uih",
      "mark-3",
    ]);
    const bad: Parameters<typeof adbArgs>[0][] = [
      { name: "install", apk: "-g" },
      { name: "forward", socket: "x;reboot" },
      { name: "instrument", token: "abc def", socket: "s" },
      { name: "instrument", token: "0123456789abcdef", socket: "$(id)" },
      { name: "firewall", rules: [["sh", "-c", "id"]] },
      { name: "firewall", rules: [["iptables", "-F;", "reboot"]] },
      { name: "forward-remove", port: 0 },
      { name: "logcat-mark", mark: -1 },
      { name: "emu", command: { name: "snapshot-save", snapshot: "../x" } },
      { name: "emu", command: { name: "screenrecord-start", path: "/tmp/a b.webm" } },
      { name: "getprop", key: "persist.x" as "sys.boot_completed" },
    ];
    for (const command of bad)
      expect(() => adbArgs(command), JSON.stringify(command)).toThrow(InvalidToolCommand);
  });

  it("starts the emulator only behind the local network guard", () => {
    const base = {
      avd: "h-16-pixel-8-google_apis",
      port: 5580,
      proxy: "http://127.0.0.1:4000",
      headless: true,
    };
    expect(emulatorArgs({ ...base, snapshot: "clean-1" })).toEqual(
      expect.arrayContaining([
        "-http-proxy",
        "http://127.0.0.1:4000",
        "-read-only",
        "-no-snapshot-save",
        "-no-metrics",
      ]),
    );
    expect(() => emulatorArgs({ ...base, proxy: "http://10.0.0.1:80" })).toThrow(
      InvalidToolCommand,
    );
    expect(() => emulatorArgs({ ...base, port: 5581 })).toThrow(InvalidToolCommand);
  });
});

describe("the device firewall", () => {
  it("lets only the app's TCP out (to the guard), DNS and loopback; rejects the rest", () => {
    const rules = [...resetRules(), ...firewallRules(10150), ...COUNTERS_COMMAND];
    for (const rule of rules) {
      expect(["iptables", "ip6tables"]).toContain(rule[0]);
      for (const token of rule) expect(token, rule.join(" ")).toMatch(SAFE_TOKEN);
    }
    const text = firewallRules(10150).map((r) => r.join(" "));
    expect(text).toContain("iptables -A uih_out -p tcp -m owner --uid-owner 10150 -j RETURN");
    expect(text).toContain("iptables -A uih_out -p udp -d 10.0.2.3 --dport 53 -j RETURN");
    expect(text.filter((line) => line.endsWith("-j REJECT"))).toHaveLength(4);
    expect(() => firewallRules(0)).toThrow();
  });

  it("counts the app's refusals apart from the system's", () => {
    const output = [
      "-N uih_out",
      "-A uih_out -o lo -c 3 235 -j RETURN",
      "-A uih_out -m owner --uid-owner 10150 -c 2 120 -j REJECT --reject-with icmp-port-unreachable",
      "-A uih_out -c 7 400 -j REJECT --reject-with icmp-port-unreachable",
      "-A uih_out -m owner --uid-owner 10150 -c 1 60 -j REJECT --reject-with icmp6-port-unreachable",
    ].join("\n");
    expect(parseCounters(output)).toEqual({ app: 3, system: 7 });
  });
});

describe("logcat", () => {
  it("scrubs every line before keeping it", () => {
    const log = new Logcat((t) => t.replaceAll("shop-demo-pass", "[secret:SHOP_PASSWORD]"));
    log.feed(
      "09-27 10:00:00.000  1  1 D Acme: password=shop-demo-pass\n09-27 10:00:00.001  1  1 D Acme: sh",
    );
    log.feed("op-demo-pass");
    expect(log.text()).not.toContain("shop-demo-pass");
    expect(log.text()).toContain("password=[secret:SHOP_PASSWORD]");
  });

  it("sees crashes and ANRs of a package", () => {
    const log = new Logcat((t) => t);
    log.feed(
      [
        "09-27 10:00:00.000 2127 2127 E AndroidRuntime: FATAL EXCEPTION: main",
        "09-27 10:00:00.000 2127 2127 E AndroidRuntime: Process: com.acme.shop, PID: 2127",
        "09-27 10:00:00.000 2127 2127 E AndroidRuntime: java.lang.IllegalStateException: Project screen failed to load: X",
        "09-27 10:00:01.000  615  700 E ActivityManager: ANR in com.example.other",
        "",
      ].join("\n"),
    );
    expect(log.eventsSince(0, "com.acme.shop")).toEqual([
      {
        kind: "crashed",
        package: "com.acme.shop",
        at: 2,
        detail: "java.lang.IllegalStateException: Project screen failed to load: X",
      },
    ]);
    expect(log.eventsSince(0, "com.example.other")[0]?.kind).toBe("not_responding");
  });

  it("knows when an activity is on its way to the screen, and when the log has caught up", async () => {
    let now = 0;
    const log = new Logcat(
      (t) => t,
      () => now,
    );
    log.feed(
      "I ActivityTaskManager: START u0 {xflg=0x4 cmp=com.acme.shop/.ProjectsActivity} with LAUNCH_MULTIPLE\n",
    );
    expect(log.launching()).toBe(true);
    log.feed(
      "I ActivityTaskManager: Displayed com.acme.shop/.ProjectsActivity for user 0: +23ms\n",
    );
    expect(log.launching()).toBe(false);
    log.feed("I ActivityTaskManager: START u0 {cmp=com.acme.shop/.Trampoline}\n");
    now = 5_000;
    expect(log.launching()).toBe(false);
    const waiting = log.waitForMark(4, 1_000);
    log.feed("09-27 10:00:00.000  2000  2000 I uih     : mark-4\n");
    expect(await waiting).toBe(true);
  });
});

describe("data: versions and device profiles (TGT-4, TGT-6)", () => {
  it("covers at least the last five major Android versions, phones and tablets", () => {
    expect(Object.keys(ANDROID_VERSIONS)).toHaveLength(5);
    expect(
      Object.values(ANDROID_VERSIONS).every(
        (v) => v.images.length > 0 && !v.images.some((i) => i.includes("playstore")),
      ),
    ).toBe(true);
    const categories = new Set(Object.values(DEVICE_PROFILES).map((p) => p.category));
    expect([...categories].sort()).toEqual(["phone", "tablet"]);
  });

  it("finds a Windows SDK (adb.exe, emulator.exe, sdkmanager.bat) and a Unix one, on any OS", () => {
    const layout = (files: string[]) => {
      const root = mkdtempSync(join(tmpdir(), "sdk-"));
      for (const file of files) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), "");
      }
      return root;
    };
    const windows = layout([
      "platform-tools/adb.exe",
      "emulator/emulator.exe",
      "cmdline-tools/latest/bin/sdkmanager.bat",
    ]);
    const found = findSdk({ ANDROID_HOME: windows }, "win32");
    expect(found?.root).toBe(windows);
    expect(found?.adb).toBe(join(windows, "platform-tools", "adb.exe"));
    expect(found?.emulator).toBe(join(windows, "emulator", "emulator.exe"));
    expect(found?.sdkmanager).toBe(
      join(windows, "cmdline-tools", "latest", "bin", "sdkmanager.bat"),
    );
    // The same folder is no SDK on Linux (no adb, no emulator program there).
    expect(findSdk({ ANDROID_HOME: windows }, "linux")?.root).not.toBe(windows);
    const unix = layout([
      "platform-tools/adb",
      "emulator/emulator",
      "cmdline-tools/13.0/bin/sdkmanager",
    ]);
    expect(findSdk({ ANDROID_HOME: unix }, "linux")?.sdkmanager).toBe(
      join(unix, "cmdline-tools", "13.0", "bin", "sdkmanager"),
    );
    expect(findSdk({ ANDROID_SDK_ROOT: unix }, "darwin")?.root).toBe(unix);
  });

  it("writes an AVD config from a profile and an image", () => {
    const image = systemImages("/nowhere", "16", "arm64-v8a")[0];
    const config = avdConfig(
      "h-16-pixel-8-google_apis",
      DEVICE_PROFILES["pixel-8"] as never,
      image as never,
    );
    expect(config).toContain("hw.lcd.width=1080\nhw.lcd.height=2400\nhw.lcd.density=420\n");
    expect(config).toContain("image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\n");
    expect(config).toContain("PlayStore.enabled=false\n");
  });

  it("plans the setup from what's installed, never downloading", () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-"));
    // The layout of this machine's platform: adb.exe / emulator.exe on Windows.
    const ext = process.platform === "win32" ? ".exe" : "";
    for (const dir of ["platform-tools", "emulator"]) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, "source.properties"), "Pkg.Revision=37.0.1\n");
      writeFileSync(join(root, dir, `${dir === "emulator" ? "emulator" : "adb"}${ext}`), "");
    }
    const env = { ANDROID_HOME: root, HOME: root };
    expect(findSdk(env)?.root).toBe(root);
    const plan = androidSetupPlan(["16"], env);
    expect(plan.items.map((i) => [i.package, i.installed])).toEqual([
      ["platform-tools", true],
      ["emulator", true],
      [expect.stringMatching(/^system-images;android-36;google_apis;/), false],
    ]);
    expect(plan.downloadMb).toBeGreaterThan(1000);
    expect(plan.commands.at(-1)).toMatch(/sdkmanager.* "system-images;android-36;google_apis;/);
  });
});
