# Known limits

What %Name% does not do, or does only partly, today. Each comes from the package that owns it; nothing here is hidden elsewhere.

## Browser harness

- **Redirects in Firefox and WebKit.** Both have the route layer and the main-frame check. How they honour the proxy's bypass list for redirects to loopback differs from Chromium (WebKit followed a `localhost` redirect in testing), so the network-layer redirect guarantee is proven on Chromium, which the cloud workers run.
- **Secrets in pixels.** A secret typed into a non-password field is masked with CSS, and videos and screenshots show the masked field. A page that copies the value elsewhere in its own DOM could still show it in pixels. The value never appears in text evidence.
- **Sockets from dedicated workers** are covered only by the proxy layer.
- **Headers across redirects.** Protected-preview headers are sent only to allowed hosts in their secret's domains, but browsers keep added headers on a redirect, so a redirect to another *allowed* host carries them. Keep each secret's `domains` narrow.

## Secrets

- A secret embedded in a larger encoded value (for example base64 of `user:password`) is not detected by the redactor unless the code that builds it registers the combined value.
- Saved-login values shorter than 6 characters (like `consent=1`) are not registered with the redactor: registering them would scrub every `1` in every log.

## Runs, checks and healing

- **Checks are never healed.** If the page renames what a check looks at (a field's label, say), the check fails and you update the test: heals change only how a step is done.
- **Some cosmetic changes need the fixer.** On the demo shop's cosmetic variant, 6 of 9 changes heal without AI; renamed buttons like "Create" → "Save project" need the fixer model.
- **`run` and `sql` setup hooks** aren't supported yet: a test with one stops with `hook_unsupported`. Only `request` hooks run.
- **Code steps** (` ```ts ` blocks) run through the generated Playwright spec and are not healed.
- **Speed.** Replay is slower than the plain Playwright specs today: on the demo shop, 39.7 s against 5.0 s, mostly from a fixed settle window after every action and per-step evidence (screenshots, trace, network log). Making replay as fast as plain Playwright is being worked on.
- **Shared test data.** Tests that change the same server data can collide with `--workers` above 1; give them their own data (`{{unique.*}}`, setup hooks) or run them in one worker.
- **One browser and device per run.** A matrix of browsers or devices, and locale and timezone per environment, are not in the project file yet.
- **Budgets:** one AI call already in flight can overshoot a cap. A model with no known price gets cost "unknown", never a guess.

## Decision models

- Laya (local, via Ollaya) is untrained: expect escalations (rules answers) until it is trained on your labels. Its same-element decisions take about 150 ms, over the 100 ms limit during runs, so they are skipped after 3 timeouts.
- Jev is too slow for during-run decisions (about 380 ms), so it is only used after runs.

## Inboxes

- Mailosaur and MailSlurp are tested against local fakes shaped like their documented APIs, not yet against the live services. Mailpit is tested against a real Mailpit in CI.

## Generated Playwright specs

- No healing, no model-judged checks, no `Never:` guards (they become annotations), no saved logins (each test logs in).
- The allowlist uses Playwright's route layer only: redirects to other hosts are not caught the way the harness's proxy catches them.
- `--reporter` on the command line replaces the scrubbing reporter; the global teardown scrubs again after the run, but a reporter that copies traces before the run ends (such as `blob`) could copy one first.
- Older Firefox versions ignore the CSS mask on secret fields.
- Output follows Biome's formatting; unusual shapes may still differ from a formatter.

## Android

- **Certificate pinning.** TLS is tunnelled, never decrypted, so pinned apps work, but the network log has one `CONNECT` entry per HTTPS connection, not its requests. Plain HTTP is logged per request.
- **Encrypted ClientHello (ECH)** hides the host name; such connections pass only if their IP is allowed.
- **DNS lookups** go to the emulator's resolver (the host's), so an app can learn whether a name resolves and could leak data in query names. No connection to a disallowed host is made.
- **Traffic the system makes for the app** (DownloadManager, media streaming in the media server, Play services) is refused, because only the app's own traffic may connect. WebView traffic runs in the app's process and passes.
- **Firewall refusals are counted, not itemised.**
- **Pixels.** Screen recordings show whatever the app draws: a secret typed into a non-password field is visible in the video (never in text evidence). Apps with `FLAG_SECURE` record as black.
- **Images.** Root adb is required, so Google Play system images are not supported (Google APIs and ATD images are). ATD images have no system UI, so toasts and notifications never appear on them.
- **Windows under a dialog** aren't interactive, so Android doesn't report them: while a dialog is open, the observation shows the dialog only.
- Running Android tests from `%cli% run` and the apps is being wired in.

## Apps

- The web app has no accounts, cloud runs or hosted AI yet: see [the web app quickstart](../quickstart/web.md).
- Desktop installers are not code-signed until the signing certificates are in place; until then only the Linux AppImage updates itself.
- The MCP server and the `AGENTS.md` snippet for coding agents are in progress: see [Coding agents](../coding-agents.md).
