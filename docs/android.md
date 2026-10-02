# Android

Android apps use the same test format as websites. The Android harness is the counterpart of the browser harness: it boots and resets emulators, installs your APK fresh for every session, enforces the allowed domains at the network layer, observes screens through the accessibility tree, offers a closed set of actions, types secrets and captures evidence.

Author and run them like website tests: `%cli% author` records a test once on the emulator, `%cli% run` replays the recordings with no AI, and `%cli% export` writes them as [Maestro flows](./export.md#android-maestro-flows) that run without %Name%. The apps show Android runs like any other; running Android tests from the desktop app is coming.

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

From the emulator, `10.0.2.2` is your own machine: `--allow 10.0.2.2:4180` lets the app reach a server on port 4180 of this computer, and nothing else on it. `baseUrl` is optional: when set, `setup:` requests go there, from your machine.

## Authoring and running

```sh
%cli% author tests/sign-in.test.md       # the AI carries out each step once, on the emulator
%cli% run                                # replays every recording, no AI
%cli% run --android 15 --android 16 --device pixel-8 --device small-phone   # a matrix
%cli% run --locale de-DE --timezone Europe/Berlin
```

Tests are written the same way: "Tap", "Type … into", "Open the link acmeshop://…", "Allow camera access when Android asks", and checks like "the screen heading is", "the screen says", "a message says" (toasts count), "a dialog asks" and "the list shows". A matrix gives one result per Android version and device (`<test>@android16-pixel-8`). The locale sets the app's language (Android 13+ per-app language) and the timezone the device's, for that session only.

```yaml
android:
  version: "16"       # default Android version
  device: pixel-8     # default device profile
```

Environments may override both; `--android` and `--device` win. Not on Android yet: code steps (a TypeScript block) and saved logins (`auth:` profiles); such tests are blocked with the reason.

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

## Running Android on a Linux server

The x86_64 emulator needs hardware virtualization: KVM, so `/dev/kvm` must exist and be usable by the user running %cli% (`emulator -accel-check` says so). On a bare Linux machine that's the `kvm` group or a udev rule. On a cloud VM the hypervisor must pass virtualization through: **nested virtualization**. On Google Cloud that is an Intel machine type (N2, for example) created with `--enable-nested-virtualization`; the image needs no change. Without it the emulator doesn't start.

What to expect on a 4-vCPU `n2-standard-4` (Android 16, Google APIs x86_64, measured in MOB-3), next to an Apple M5:

| | n2-standard-4 | Apple M5 |
|---|---|---|
| First boot (makes the clean snapshot, once per machine image) | 61–65 s | 19–46 s |
| Boot from the clean snapshot | 5.7–9.2 s | 1.2–4.6 s |
| Reset between sessions (reboot from the snapshot) | 6–7 s | about 6 s |
| A session start (reset, install, firewall, driver, network, launch) | 22–31 s | 5–6.5 s |

Two things differ from a laptop, and %Name% handles both:

- **The network comes back late.** After a restore, the emulator re-creates the device's Wi-Fi 5–11 s later on such a host, and its mobile data connects 20–30 s later, on the same subnet, and can become the default network. An app request made in between fails on the device (the app only says it can't connect, and the network guard sees nothing). So mobile data is off on the device, and a session starts only once the app has a route to `10.0.2.2` over a default network that has stayed the same for a second; a long wait is in the session's notes. If an action still finds the device offline, the outcome says so.
- **Launches are slow.** A first launch takes 4–25 s. %Name% starts the app and waits up to 90 s for its screen (clearing other packages' system dialogs meanwhile), and a launch that fails says why.

To set up such a machine from scratch, run the suite and measure it, see `scripts/android-vm/` in the engine repository: it creates a spot VM on Google Cloud, installs everything CI has, makes a reusable disk image, and writes the timings as JSON.

Known limits of the Android harness are listed with the others in [Known limits](./security/limits.md#android).
