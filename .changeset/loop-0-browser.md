---
"@optestra/browser": minor
"@optestra/cli": minor
---

Add the browser harness (`@optestra/browser`): `openSession` gives a fresh,
isolated Playwright context behind a network guard (route layer, refusing proxy
and main-frame check), a closed set of typed actions with post-state and settle
timing, accessibility observations with short refs and ranked locator
candidates, domain-bound secret typing that never reaches outputs or evidence,
screenshots, and scrubbed evidence (trace, video, console, network). The CLI
gains `install-browsers` and the `snapshot` debug command.
