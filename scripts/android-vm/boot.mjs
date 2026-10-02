// Boots the harness's emulator once and prints its timings as JSON: on a fresh
// machine that is the cold boot that makes the AVD's clean snapshot, then a boot
// from that snapshot. Run from the repo root after `tsc -b packages/android`.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const android = await import(
  pathToFileURL(join(process.cwd(), "packages/android/dist/index.js")).href
);
const started = Date.now();
const emulator = await android.launchEmulator({
  onProgress: (message) => process.stderr.write(`${message}\n`),
});
const readyMs = Date.now() - started;
await emulator.close();
process.stdout.write(
  `${JSON.stringify({ coldBootMs: emulator.timings.coldBootMs ?? null, snapshotBootMs: emulator.timings.bootMs, readyMs })}\n`,
);
