# Quickstart: the desktop app

The desktop app runs tests on your own computer, including sites on `localhost` and your office network. It needs no account and no command line, and local runs are free and unlimited.

::: info Status
Installers are built for macOS (`.dmg`), Windows (`.exe` installer and `.msi`) and Linux (`.AppImage` and `.deb`). Public downloads open with the first public release; this page describes the app as it is built today.
:::

## 1. Try the demo shop

Open the app. On **Projects**, press **Try the demo shop**: a small web shop that runs on your computer, with eleven example tests that are already recorded.

1. Pick a test, for example **Returning user can log in and out**, and press **Run**.
2. The **Test run** screen shows the run live: the step running now, the latest screenshot, the AI calls and cost (zero: the recording replays without AI), and a **Stop** button.
3. When it finishes, **Open the result**: the verdict, the one-line headline, **What was checked** (one sentence per check), before and after screenshots of every step, and **Open HTML report** for the full report with video and trace.

**Run all tests** runs the whole suite.

## 2. Your own project

A project is a folder with your tests and a `%config%` file.

- **Open folder** if your repository already has one (for example, made with [`%cli% init`](./cli.md)).
- **Create project** otherwise: give it a name and the address of the site to test. Creating a project never overwrites a file.

The **Tests** screen lists every test with its steps and problem count, the flows, the environment picker, and a **Setup check**: every problem with its exact fix (the same checks as [`%cli% doctor`](../troubleshooting.md)).

## 3. Write a test

The editor is plain text in the [test format](../writing/test-files.md):

- warnings as you type (the [lint rules](../writing/lint.md));
- suggestions after `{{`, at the start of a line, after `Use:` and `Exact:`;
- hover help, quick fixes and **Format**. A fix that touches an `Expect:`, `Soft:` or `Never:` line is shown for you to review, never applied on its own;
- **Save** won't overwrite changes made to the file elsewhere.

A test without a recording shows **Record with AI**: the AI carries out the steps once, and the **Recording** tab shows what it recorded. That needs an AI model: see step 4.

## 4. Settings

- **AI**: an API key (Anthropic, OpenAI, Google, OpenRouter and other providers), or your Claude or ChatGPT plan through [Claude Code or Codex](../ai/subscription.md): you sign in in their own app, never in ours.
- **Decision models**: optional, see [Decision models](../ai/decisions.md).
- **Secrets**: the names your tests use and whether each is set. Values are saved in this computer's keychain and never shown.
- **Test inbox**: for tests that read a verification email, see [Auth profiles and inboxes](../auth.md).

**What data goes where** (bottom of the menu) says in plain words what leaves your computer. The long version is [on this site](../security/data.md).

## 5. When a step needs a fix

If your app changed and a step no longer matches its recording, the run tries to heal it. By default a heal is a proposal: the result shows **Review fixes**, with what changes in the recording, why, and how confident it is. **Accept** updates the recording; **Reject** leaves it as it was. See [Healing](../runs/healing.md).

## Updates

The app checks for new versions a little after it starts and every few hours: it asks the releases page for the latest version, sending only the app version, the operating system and the processor type. Turn automatic updates off under **App updates**.
