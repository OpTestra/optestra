# Describe a test in one sentence

Type what a test should show, and %Name% explores your running app with AI and drafts it:

```sh
%cli% new "a returning user can log in and see the dashboard"
```

The AI uses the app through the same browser harness as authoring (the allowed domains, secrets typed by the harness, page content treated as untrusted data) and, while exploring, never does a destructive action (delete, pay, send, invite, cancel). Steps are written by %Name% from the elements it used (`Click "Log in"`), never by the model, and each expectation it proposes is checked on the page before it is kept, like one you [record](./record.md). The draft is linted.

It prints the draft and where it would go, and saves nothing unless you say so: the terminal asks, or pass `--accept` (only a lint-clean draft, into the tests folder) or `--out <file>`. Options: `--start <path>` (default `/`), `--env <name>`, `--headed`, `--json`.

Exploring is bounded: 16 actions, 24 AI calls, 180 seconds. A draft that hit a limit says so.

**Starter tests.** `%cli% init --suggest` explores a new project's home page and proposes three drafts (the home page loads, sign-up, log in, or what the AI suggests) and asks before saving each one.
