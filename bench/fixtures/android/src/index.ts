import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Acme Shop for Android: one codebase (app/), one APK per variant (Gradle product
// flavors). The app talks to the shop website's server through the emulator's
// host alias, http://10.0.2.2:4180, so a test starts the shop on port 4180.

export const VARIANTS = [
  "correct",
  "cosmetic",
  "broken-login",
  "broken-silent-tap",
  "broken-not-saved",
  "broken-crash",
] as const;

export type Variant = (typeof VARIANTS)[number];

export const VARIANT_DESCRIPTIONS: Record<Variant, string> = {
  correct: "The reference build. Everything works.",
  cosmetic:
    "Same behaviour, different surface: reworded labels, renamed resource ids, the New project button moved below the list.",
  "broken-login": 'Signing in with the right password shows "Something went wrong".',
  "broken-silent-tap": 'False-pass trap: "Create project" looks tappable but does nothing.',
  "broken-not-saved":
    'False-pass trap: the toast says "Project created" and the list shows it, but nothing was saved: a refresh shows it\'s gone.',
  "broken-crash": "Opening a project crashes the app.",
};

/** The app's package name (the same for every variant). */
export const APP_PACKAGE = "com.acme.shop";

/** The shop server port the APKs are built for. */
export const SHOP_PORT = 4180;

/** Allowed domains for the fixture: the shop through the host alias. */
export const ALLOWED_DOMAINS = [`10.0.2.2:${SHOP_PORT}`] as const;

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const flavor = (variant: Variant) =>
  variant.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Where Gradle puts a variant's APK. */
export function apkPath(variant: Variant): string {
  const name = flavor(variant);
  return join(
    FIXTURE_DIR,
    "app",
    "build",
    "outputs",
    "apk",
    name,
    "debug",
    `acme-shop-android-${name}-debug.apk`,
  );
}

/** True when every variant's APK is built. */
export function apksBuilt(): boolean {
  return VARIANTS.every((variant) => existsSync(apkPath(variant)));
}

export { flavor as gradleFlavor };
