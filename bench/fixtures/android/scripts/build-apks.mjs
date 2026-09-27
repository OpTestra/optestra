// Builds every variant's APK with the system Gradle (no committed wrapper).
// Needs Java 17+, Gradle and the Android SDK (ANDROID_HOME).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../app", import.meta.url));
const result = spawnSync("gradle", ["-p", app, "assembleDebug", "--console=plain", "-q"], {
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
