// Captures real driver dumps of the fixture app's screens into src/fixtures/ (the
// unit tests read them). Needs an emulator, the fixture APKs and a built package:
//   node --experimental-strip-types scripts/capture-dumps.mts

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Allowlist } from "@testament/browser";
import { apkPath } from "@testament/fixture-android";
import { startShop } from "@testament/fixture-shop";
import { DriverClient } from "../dist/driver.js";
import { launchEmulator } from "../dist/emulator.js";
import { Screen } from "../dist/hierarchy.js";
import { resolveLocator } from "../dist/locators.js";
import { runAdb, startAdb } from "../dist/tools.js";

const shop = await startShop({ port: 4180 });
await fetch(`${shop.url}/__test/seed`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ projects: ["Website redesign", "Mobile launch"] }),
});
const emu = await launchEmulator();
emu.guard.setPolicy({
  allowlist: new Allowlist(["10.0.2.2:4180"]),
  onRefused() {},
  onRequest() {},
});
const { sdk, serial } = emu;
console.log(await runAdb(sdk, serial, { name: "install", apk: apkPath("correct") }));
const token = randomBytes(16).toString("hex");
const socket = "uih-capture";
const fwd = await runAdb(sdk, serial, { name: "forward", socket });
const inst = startAdb(sdk, serial, { name: "instrument", token, socket });
let connected: Awaited<ReturnType<typeof DriverClient.connect>> | null = null;
for (let i = 0; i < 40 && !connected; i++) {
  await sleep(250);
  connected = await DriverClient.connect(Number(fwd.stdout.trim()), token).catch(() => null);
}
if (!connected) throw new Error("the driver did not start");
const { client } = connected;
const dir = new URL("../src/fixtures/", import.meta.url);
const save = async (name: string) => {
  await client.call("idle", { quietMs: 400 });
  await sleep(300);
  const d = await client.dump();
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify(d, null, 1));
  return new Screen(d, { appPackage: "com.acme.shop" });
};
const find = (s: Screen, spec: Parameters<typeof resolveLocator>[1]) => {
  const { entry } = resolveLocator(s, spec);
  if (!entry) throw new Error(`nothing matches ${JSON.stringify(spec)}`);
  return entry;
};
const tap = async (s: Screen, spec: Parameters<typeof resolveLocator>[1]) => {
  const entry = find(s, spec);
  const [l, t, r, b] = entry.node.bounds;
  await client.call("tap", { x: (l + r) / 2, y: (t + b) / 2 });
  await sleep(800);
};
await client.call("launch", { package: "com.acme.shop" });
await sleep(1500);
let s = await save("sign-in");
const email = find(s, { kind: "role", role: "textbox", name: "Email" });
await client.call("set_text", { node: email.index, text: "ada@example.com" });
const pw = find(s, { kind: "role", role: "textbox", name: "Password" });
await client.call("set_text", { node: pw.index, text: "shop-demo-pass" });
s = await save("sign-in-filled");
await tap(s, { kind: "role", role: "button", name: "Sign in" });
await sleep(1000);
s = await save("projects");
await tap(s, { kind: "role", role: "button", name: "Sign out" });
s = await save("sign-out-dialog");
await tap(s, { kind: "role", role: "button", name: "cancel", exact: false });
s = await save("projects");
await tap(s, { kind: "role", role: "listitem", name: "Website redesign" });
s = await save("project");
await tap(s, { kind: "role", role: "button", name: "Scan badge" });
await sleep(1000);
s = await save("permission");
await client.call("global", { action: "back" });
await sleep(800);
await client.call("global", { action: "back" });
await sleep(800);
s = await save("projects-again");
await tap(s, { kind: "role", role: "button", name: "Settings" });
s = await save("settings");
await client.quit();
inst.kill();
await emu.close();
await shop.stop();
console.log("done");
