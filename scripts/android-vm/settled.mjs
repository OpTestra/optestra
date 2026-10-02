// The gate before image.sh takes an image: boots the emulator from its clean
// snapshot, as every session does, and watches what is in front for
// ANDROID_VM_SETTLED_SECONDS (default 60). If anything takes the foreground
// (first-run apps, the launcher's setup), it exits 1 and says what: an image of
// that disk would replay it into every session. Run on the VM from the repo
// root, after `tsc -b packages/android`.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const seconds = Number(process.env.ANDROID_VM_SETTLED_SECONDS ?? 60);
const android = await import(
  pathToFileURL(join(process.cwd(), "packages/android/dist/index.js")).href
);
const emulator = await android.launchEmulator({
  onProgress: (message) => process.stderr.write(`${message}\n`),
});
const front = () => {
  const out = spawnSync(
    emulator.sdk.adb,
    [
      "-s",
      emulator.serial,
      "shell",
      "dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity'",
    ],
    { encoding: "utf8", timeout: 10_000 },
  ).stdout;
  return /ActivityRecord\{\S+ \S+ (\S+)/.exec(out ?? "")?.[1] ?? null;
};
let first = null;
const seen = [];
try {
  const started = Date.now();
  first = front();
  while (Date.now() - started < seconds * 1000) {
    await new Promise((ok) => setTimeout(ok, 1000));
    const now = front();
    if (now !== first && !seen.includes(now ?? "nothing")) seen.push(now ?? "nothing");
  }
} finally {
  await emulator.close();
}
const settled = first !== null && seen.length === 0;
process.stdout.write(`${JSON.stringify({ settled, seconds, front: first, tookTheFront: seen })}\n`);
process.exit(settled ? 0 : 1);
