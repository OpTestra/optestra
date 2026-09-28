# Quickstart: the web app

The web app shows the desktop app's screens in your browser, with your projects kept on our servers so you can reach them from anywhere. Nothing to install.

::: warning Status: not open yet
The web app runs today without accounts, for development. What it does now: create a project from a name and an address (or **Try the demo shop**), edit tests with live warnings, see recordings and stored results with screenshots, manage settings and secrets, and show what data goes where.

What arrives with accounts and cloud runs: sign-up, runs in cloud browsers, hosted AI, and checks that contact AI keys, decision models or inboxes. Until then, use the [desktop app](./desktop.md) or the [CLI](./cli.md) to run tests.
:::

## How it will work

1. **Sign up** on the website.
2. **Create a project**: paste your site's URL, or pick the demo shop.
3. **Pick where to test**: browser and device, for example Chromium on a laptop or WebKit at iPhone size.
4. **Write the test** in the editor, in the same [test format](../writing/test-files.md) the desktop app and the CLI use.
5. **Run** it and watch it live. The first run uses AI to work out the steps; later runs replay the recording without it.
6. **Read the result**: the verdict, the video and the exact check that decided it, and **Review fixes** when a step had to be healed.

## What differs from the desktop app

| | Desktop app | Web app |
|---|---|---|
| Where the browser runs | Your computer | Our cloud |
| Can reach `localhost` and private networks | Yes | No: public sites and previews, including [protected previews](../ci/previews.md#protected-previews) |
| Account | Not needed | Needed |
| Secrets | This computer's keychain, or `.env` files | Encrypted on the server; the page can set or clear them but never read them back |
| AI | Your key, or your Claude/ChatGPT plan through its own app | Hosted AI or your own key. Subscription tools (Claude Code, Codex) run only on your own computer, never in the cloud |
| Open a local folder | Yes | No: projects live in your account |

What the web app keeps, and what it never does: [What data goes where](../security/data.md#the-web-app).
