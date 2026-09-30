# Record a test by clicking

Don't want to write steps? Click through your app and let %Name% write them, together with the recording that replays them with no AI.

```sh
%cli% record --url /login
```

A browser window opens on your app (the environment's `baseUrl`). Use the app as a person would. A small bar in the corner (● REC) marks what you expect:

- **Expect text**: select some text first to expect it (`the page shows "…"`), or click the button and then an element (a heading becomes `the page heading is "…"`, a message `a message says "…"`, a button `the "…" button is shown`). The keyboard shortcut is **Alt+Shift+E**.
- **Expect URL**: `the URL contains /the/current/path`.
- **Finish**: done. Closing the window or pressing Ctrl-C in the terminal finishes too.

Every expectation is checked on the page right away, like a [drafted](./describe.md) one: it must hold now and must not hold on an empty page or before your last action. The bar says when one isn't added, and why.

The terminal shows each step as you go, then the whole test:

```markdown
---
name: Returning user can log in
start: /login
data:
  email: ada@example.com
---

1. Fill "Email" with {{data.email}}
2. Fill "Password" with {{secret.SHOP_PASSWORD}}
3. Click "Log in"
4. Expect: the page heading is "Dashboard"
```

It is saved only when you say so: the terminal asks, or pass `--accept` (the tests folder) or `--out <file>`. It is never written over an existing file. The recording is saved next to the tests, like one from `%cli% author`, so `%cli% run` replays the test with no AI.

## What you type never lands in the file

- A value that matches one of the project's [secrets](../environments.md) is written as `{{secret.NAME}}`.
- A password that matches no secret is written as `{{secret.PASSWORD}}` (named after the field); the terminal tells you to declare that secret and set its value. The password itself is not kept anywhere, not even in the recording.
- An email address becomes `{{data.email}}`, and on a sign-up page `{{unique.email}}`, so every run signs up a new user.
- Other text becomes a `data` value named after the field (`{{data.projectName}}`), which you can edit in the frontmatter.

The test is linted before it is shown; `literal-credential` is always clean.

## How it works

Your clicks (and Enter in a field) are held for a moment while the browser harness does the same action itself, so each one is recorded with the element's locators and fingerprint, what the page did afterwards and how long it took to settle, exactly as when the AI authors a test. Typing, choosing in a list and picking a file are yours and are recorded as they are. Addresses you type in the address bar become `Go to …` steps. An uploaded file is recorded as `files/<name>`: copy it into the test's `files/` folder.

Options: `--name <name>`, `--browser <name>`, `--env <name>`, `-C <project>`.

Limits today: elements inside iframes are not recorded, and a click made while the harness is still performing the previous one goes through unrecorded (wait for the page to settle).
