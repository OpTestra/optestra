# Android

Android apps use the same test format as websites. The Android harness is the counterpart of the browser harness: it boots and resets emulators, installs your APK fresh for every session, enforces the allowed domains at the network layer, observes screens through the accessibility tree, offers a closed set of actions, types secrets and captures evidence.

::: info Status
The harness, its setup commands and its safety model are built and tested on emulators. Authoring and running Android tests from `%cli% run` and the apps are being wired in now; this page will show the full flow when they land.
:::

## Setup

```sh
%cli% android setup                     # what's missing: adb, the emulator, system images, with sizes
%cli% android setup --android 16 17 --install
%cli% android doctor                    # checks everything a local run needs, changes nothing
%cli% android snapshot app.apk --allow 10.0.2.2:4180 --screenshot first.png
```

`setup` lists what is missing, with download and disk sizes and the exact `sdkmanager` commands. It downloads nothing unless you pass `--install`, then shows the sizes and asks (or `--yes`). Accepting the SDK licence (`sdkmanager --licenses`) is your own step. `snapshot` installs an APK on a fresh emulator and prints what the agent sees on its first screen.

The harness keeps its own emulators (AVDs) in `~/%dataDir%/android/avd` (override with `%ENV%ANDROID_HOME`).

## A project

```yaml
# %config%
version: 1
project:
  name: Acme Shop Android
  target: android
defaultEnvironment: local
environments:
  local:
    app: app-release.apk
    allowedDomains: [api.example.com]
secrets:
  SHOP_PASSWORD:
    domains: [com.acme.shop]      # for Android, the app packages a secret may be typed into
```

From the emulator, `10.0.2.2` is your own machine: `--allow 10.0.2.2:4180` lets the app reach a server on port 4180 of this computer, and nothing else on it.

## Versions and devices

| | |
|---|---|
| Android versions | 13 to 17 (API 33 to 37); 16 by default |
| Device profiles | `small-phone`, `pixel-8` (default), `pixel-9-pro-xl`, `small-tablet`, `pixel-tablet` |
| System images | Google APIs and ATD images (root adb is required, so Google Play images are not supported) |

Both lists are data, so new versions and devices need no engine change.

## How it stays safe

- **Fresh every time.** Each emulator boots read-only from a clean snapshot (no animations, no password echo, no private DNS probes) and never saves. A used emulator reboots from the snapshot before the next session, and the APK is installed fresh, so no data, permission or process carries over.
- **Allowed domains at the network layer.** Every TCP connection the device makes goes to a local guard, which reads the host name (the TLS SNI or the HTTP `Host`), checks it against the allowlist and that the IP really belongs to that name. A firewall inside the device (which the app can't change) lets only the app's own traffic out, and only to the guard; UDP (including QUIC) and every other process's traffic is refused. `10.0.2.2:<port>` reaches only that port on your machine, never adb or the emulator console.
- **Secrets typed, never seen.** Only into a field of the app under test, and only if the app's package is in the secret's `domains`. The value goes to the on-device driver over a local socket and is set directly, never on a command line. Other password fields show a fixed `••••••••`.
- **A closed action set.** No shell, no raw adb, no file access for the agent. The driver is %Name%'s own instrumentation APK (MIT, built from source); touching another app's screen is refused (`outside_app`).
- **Screen content is untrusted**, wrapped like page content for the web.

### Actions

`tap`, `long_press`, `type`, `clear`, `press` (Enter, Tab, Backspace, Escape, arrows…), `swipe`, `scroll`, `back`, `home`, `launch_app`, `rotate`, `open_deep_link` (in the app under test only; `http(s)` links must be allowed, `file:`, `content:` and `intent:` are refused), `permission` (allow, allow once, deny on the system prompt) and `waitFor`.

### Checks

`text`, `url` (matched against the `android-app://` URL, the component or the activity), `element_state`, `count`, `value` and `network`. `aria_snapshot`, `code` and model-judged checks are not supported on Android.

### Evidence

A video recorded by the emulator, `logcat.txt` (every line scrubbed), and a network log of the guard's requests and refusals with no headers or bodies. App crashes and "not responding" are findings, never dismissed; other packages' system dialogs are dismissed and recorded.

## Measured

On an Apple M5 with Android 16 (Google APIs, arm64, pixel-8): an emulator is ready from its snapshot in 1.2–4.6 s; a session starts on a fresh emulator in about 5–6.5 s (install, firewall, driver, idle system, launch); reading a screen takes 15–50 ms. The first run per emulator prepares the clean snapshot (a cold boot of about 19–46 s).

Known limits of the Android harness are listed with the others in [Known limits](./security/limits.md#android).
