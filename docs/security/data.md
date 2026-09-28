# What data goes where

The short version: **the engine sends nothing to us.** There is no telemetry and no analytics, and a test in the engine's own suite fails if a telemetry or analytics library is ever added. It talks to the network only through a few named files, each pinned to one configured host, and only when a run needs it. Your secrets are typed into your site and nowhere else.

The engine is open source, so every statement here can be checked in the code; the file names are given where it helps.

## At a glance

| Destination | When | What is sent |
|---|---|---|
| **The site you test** | every run | what a browser sends: page requests, form fills, your secrets typed into their allowed domains |
| **Your AI provider** | authoring, a step without a recording, a heal that needs the fixer, an Expect line no rule can compile, a model-judged `Soft:` check | the step, a text description of the page, sometimes a screenshot. [Details](#ai-providers) |
| **A decision model** | only if you set one up (or set `JEV_API_KEY`) | short typed questions about a run, redacted. [Details](#decision-models) |
| **A test inbox** | only if configured, when a step needs an email | a request for the latest email to a test address. [Details](#test-inboxes) |
| **GitHub** | in the GitHub Action | the PR comment, the check, artifacts. [Details](#github) |
| **Update feed** | the desktop app, unless you turn it off | the app version, OS and processor type. [Details](#desktop-app-updates) |
| **Us** | never, from the engine | nothing |

A replay where nothing changed contacts **only your site** (plus a decision model if you configured one for after-run decisions, and a model for any model-judged `Soft:` check).

## The site you test

The browser (or Android emulator) reaches only the [allowed domains](../environments.md#allowed-domains) of the environment; everything else is refused below the page, before anything is sent. A secret is typed only into a page on one of its own `domains`. `setup` request hooks go to allowed hosts only, with no redirects. [Protected preview](../ci/previews.md#protected-previews) headers are sent only to allowed hosts in their secret's domains.

## AI providers

**What a prompt contains** (built by `packages/core`, sent by `packages/models/src/transport.ts`):

- **Authoring a step:** the step's text with variables filled in (secrets as `{{secret.NAME}}`), the step's variables (plain values shown, such as a generated email address; secrets by name only), the test's `Never:` lines, this step's actions so far and what each changed, and the page as an accessibility snapshot: its roles, names and visible text, wrapped as untrusted content. A downsampled screenshot (a JPEG at most 1280 px wide) is added only when needed: the snapshot was truncated, an iframe has no usable elements, or the model asked to look.
- **Compiling an Expect line** that no rule can map: the line, the rules that were tried, and the page. A line that uses a secret is never sent.
- **A model-judged `Soft:` check:** a screenshot of the page or element, and the question.
- **The fixer:** the step, its recorded actions and what each element was, why it missed, and the page.

**Never in a prompt:** secret values (the page text is scrubbed, secret fields are masked on screen), your API keys (each key goes only to its own provider's host, in the request's authentication), your test files as a whole, recordings, run results, cookies, other tests' pages.

**Remember:** the page is whatever your app shows. If a test's pages show personal data (a real customer's name, an order), that text is in the accessibility snapshot and may be in a screenshot. Test with test data.

**Where it goes:**

- With an **API key**, to that provider (Anthropic, OpenAI, Google, OpenRouter, your own server…), under your account and that provider's terms.
- With your **subscription** (Claude Code, Codex), through the vendor's own CLI, signed in as you, to that vendor. %Name% never touches the tool's sign-in. See [Use your AI subscription](../ai/subscription.md).
- With a **local model** (Ollama, vLLM, LM Studio), nowhere off your machine.

Every call is recorded in the run (role, provider, model, tokens, cost, latency, outcome, and the model's short note, scrubbed).

## Decision models

Off by default during runs (rules only). After a run, Jev is used only if `JEV_API_KEY` is set; Kev and Laya only when you choose them. What is sent: the decision's state and question text, redacted first. For `page_is_error`, the HTTP status and the page's title, main heading and a sample of its visible text. No screenshots, no test files, no keys except the backend's own (`packages/decide/src/node/systemone/transport.ts`).

- **Jev** (hosted by TypeSafe AI, in the US). TypeSafe says it doesn't train on requests; zero data retention is on their enterprise plan.
- **Kev** and **Laya** run on your own machine or server.

## Test inboxes

Only when `inbox.provider` is set, and only when a step needs an email: a search for the latest message to the test's address, then that message. Mailpit runs on your machine or in your CI. Mailosaur and MailSlurp are hosted: their API key is sent only to their own host. The engine reads one message and keeps nothing; codes and links are typed like secrets and never stored (`packages/auth/src/inbox/transport.ts`).

## GitHub

The GitHub Action talks only to GitHub's API with the workflow's own token: it finds the pull request, reads its changed files (to flag changed `Expect:` lines), posts or edits its one comment and creates the check (`packages/action/src/transport.ts`). The comment is built from the run's scrubbed results. Artifacts (the HTML report, videos, traces, screenshots, all scrubbed of secrets) are uploaded to your repository's Actions artifacts, where your repository's retention settings apply. Videos and screenshots are pictures of your app.

## Desktop app updates

The installed desktop app checks for new versions a little after it starts and every few hours: a GET of the release feed file from the public releases page on GitHub, and the new version when there is one. The request carries the app version; the operating system and processor type are implied by which file it asks for. No account, project or usage information. Turn automatic updates off in **App updates**; then nothing is checked unless you press **Check for updates**.

Checks you start in the app or the CLI (`models --check`, `decisions --check`, `inbox check`, `doctor`) contact those services to confirm a key or connection works, only when you run them.

## What stays on your machine

| What | Where |
|---|---|
| Tests, flows, recordings, generated specs | your repository (committed) |
| The project file | your repository; secret **names** only |
| Secret values | environment variables, `.env` files (git-ignored), the desktop app's keychain |
| Run results and evidence: screenshots, video, trace, console log, network log (no bodies, cookies or `Authorization` headers) | `%dataDir%/runs/` in the project (git-ignored) |
| Saved logins (cookies and local storage) | `%dataDir%/auth/`, owner-only (`0600`), with its own `.gitignore` |
| AI usage, decision cache, labelled examples, authoring reports | `%dataDir%/` in the project |

## How secrets are kept out

- A secret value is a special type: printing, logging or serializing it gives `[secret:NAME]`.
- Every loaded secret, and its URL-encoded, form-encoded, JSON-escaped and base64 forms, is registered with a redactor that every log line, event, result and text artifact passes through. The run writer refuses artifacts that weren't scrubbed.
- The browser types a secret only at the moment of typing, pauses the trace around it, and masks the field on screen.
- Only a short, pinned list of files may reveal a secret's value (the drivers that type it, and the transports that send a key to its own host); a test enforces the list.
- Known limit: a secret inside a larger encoded value (say, base64 of `user:password`) is not detected unless the code building it registers it. See [Known limits](./limits.md).

## The web app

The web app keeps your projects on its server so you can reach them from any browser: the project file, tests, recordings and run results, and secret values **encrypted** (the page can set or clear them, never read them back; they are accepted only over a secure connection). It sets one session cookie that protects your changes against other sites; no trackers, no advertising, and nothing about you or your usage is sent to anyone else.

Not live yet: accounts, runs in cloud browsers and hosted AI. Today the server sends nothing to an AI provider, and subscription tools (Claude Code, Codex) only ever run on your own computer. When cloud runs launch, this page will list what the cloud stores and for how long, per plan.
