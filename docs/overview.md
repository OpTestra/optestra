# What %Name% is

%Name% tests your website or Android app from a plain-English description. You write what should happen:

```markdown
---
name: New customer can start a Pro trial
start: /pricing
data:
  email: "{{unique.email}}"
---

1. Click "Start free trial" on the Pro plan
2. Sign up with {{data.email}} and password {{secret.SHOP_PASSWORD}}
3. Expect: the page heading is "Check your email"
```

The first run uses AI to work out the steps and **records** exactly what it did. Every later run **replays** that recording with no AI, fast and free. Every `Expect:` line is compiled once into a typed check (for example "the main heading is exactly 'Check your email'") that plain code evaluates on every run. The AI only comes back when your app changed and a step no longer works, and even then it proposes a fix for you to approve. It never quietly turns a failed test into a pass.

## The pieces

| | What | Where it runs |
|---|---|---|
| **The engine** | Parses tests, drives the browser or emulator, records, replays, heals, writes results | Your machine, your CI, or our cloud workers |
| **The CLI** (`%cli%`) | Every engine action as a command, for CI pipelines, coding agents and power users | Wherever Node 24 runs |
| **The GitHub Action** | Runs the CLI on pull requests and posts one comment and a status check | Your own GitHub runners |
| **The desktop app** (%Desktop%) | The editor, live runs, results and fix review on your own computer, including `localhost` | macOS, Windows, Linux |
| **The web app** (%Web%) | The same screens in the browser, running on our servers | Any modern browser |

### What is open and what is paid

- **Open source (MIT):** the engine, the test format, the CLI, the GitHub Action, the MCP server for coding agents (in progress) and the Bench. You can read the code, which is why you can trust it, and why your tests outlive us.
- **Closed:** the desktop app, the web app and the cloud behind them (hosted browsers and emulators, history, monitoring, hosted AI, teams, billing).
- **Free:** the engine, the Action and the desktop app's local runs, forever. The web app has a free monthly allowance; paid plans add cloud runs, parallelism, monitoring and teams.

## The promises

Every feature has to keep these. When an idea conflicts with them, the promises win.

1. **Your tests are yours.** Every recorded website test is also a plain Playwright spec in your repository, which runs without %Name%. See [If %Name% disappears](./if-it-disappears.md).
2. **A pass means a real check passed.** Verdicts are decided by code from the checks. A model never decides pass or fail. See [Checks and verdicts](./runs/checks-and-verdicts.md).
3. **A run where nothing changed uses zero AI**, and runs at full speed. See [How a run works](./runs/how-a-run-works.md).
4. **Every fix is visible and reviewed.** Nothing is fixed silently. See [Healing](./runs/healing.md).
5. **Clear about data.** Run on your own computer with your own AI key or subscription, or on ours. We say plainly what goes where. See [What data goes where](./security/data.md).
6. **It learns.** Steps the AI worked out once are saved and reused, so each repeat run needs less AI than the last.

The apps add one more: **easy**. No command line, no setup, a first passing test within five minutes.

## Where to start

- Trying it out: [the desktop app](./quickstart/desktop.md) has a demo shop with eleven tests.
- In your own repository: [the CLI in five minutes](./quickstart/cli.md).
- Setting up CI: [the GitHub Action](./ci/github-action.md).
- Writing tests: [test files](./writing/test-files.md).
