# Acme Shop for Android

The first Android Bench fixture (BEN-1): a small native app (Kotlin, plain
framework views, no AndroidX) on top of the shop website's server. It covers
sign-in, a list, a form, a dialog, a permission prompt, a deep link and a long
scrolling page. It talks only to the shop, through the emulator's host alias
(`http://10.0.2.2:4180`), plus one address outside the allowed domains that the
harness must refuse ("Check for updates" → `https://203.0.113.7/…`).

## Build and run

```bash
pnpm --filter @testament/fixture-android build:apks   # every variant; needs Java 17+, Gradle, ANDROID_HOME
pnpm --filter @testament/fixture-shop start -- --port 4180
```

The APKs land in `app/build/outputs/apk/<flavor>/debug/`; they are never
committed. From code: `apkPath(variant)`, `VARIANTS`, `APP_PACKAGE`
(`com.acme.shop`) and `ALLOWED_DOMAINS` (`10.0.2.2:4180`). The seeded user is
the shop's `ada@example.com` / `shop-demo-pass`.

## Variants

One codebase with switches (`app/src/main/kotlin/com/acme/shop/Variant.kt`), one
Gradle product flavor each:

| Variant | Flavor | What changes |
|---|---|---|
| `correct` | `correct` | Nothing. Every test passes. |
| `cosmetic` | `cosmetic` | Reworded actions and fields ("Log in", "Email address", "Add project", "Preferences"…), renamed resource ids, the New project button moved below the list. What tests check (headings, messages, list contents) reads the same. |
| `broken-login` | `brokenLogin` | The right password shows "Something went wrong". |
| `broken-silent-tap` | `brokenSilentTap` | False-pass trap: "Create project" looks tappable but does nothing. |
| `broken-not-saved` | `brokenNotSaved` | False-pass trap: the toast says "Project created" and the list shows it, but nothing was sent; a refresh shows it's gone. |
| `broken-crash` | `brokenCrash` | Opening a project crashes the app. |

## Tests and gold answers

`tests/*.test.md` (with `flows/sign-in.test.md`) and `manifest.yaml`, in the
shop's format (see [bench/README.md](../../README.md)). One difference: a failed
`Use:` flow is `failed` with the flow's cause, not `blocked`. `pnpm check` checks
the manifest is complete and consistent with the tests, the flavors and the view
ids. The reference suite (`packages/android/e2e/fixture-reference.test.ts`)
drives every test × variant through the Android harness and must reach exactly
the manifest's verdicts and failing steps.

## Recordings and the Bench (MOB-1)

`tests/.testament/*.steps.json` are the engine's recordings of every test,
authored once on the `correct` build with Claude Sonnet 4.6. A run replays them
with no AI:

```bash
pnpm --filter @testament/fixture-shop start -- --port 4180
SHOP_PASSWORD=shop-demo-pass testament run -C bench/fixtures/android   # 7 passed, 0 AI calls
pnpm bench:replay:android   # every variant scored against manifest.yaml (starts its own shop)
```

`bench:replay:android` runs each variant `--replay-only`, except `cosmetic`,
which may heal without AI (a miss only an AI heal could fix counts as "needs
AI", not as a wrong answer).
