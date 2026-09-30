# Explore an app

Point %Name% at your app with a goal, and it roams toward it like a curious first-time user, reporting what goes wrong on the way:

```sh
%cli% explore --goal "a visitor can buy the Pro plan"
%cli% explore https://staging.example.com --goal "a new user can invite a teammate" --save-drafts drafts/
```

The AI drives the browser harness as when [drafting](./writing/describe.md) (the allowed domains, no destructive actions, bounded: 16 actions, 24 AI calls, 180 seconds). The problems are found by code, never by the model, each with its evidence and where it happened:

| Finding | When |
|---|---|
| `error_page` / `server_error` | A page answered 4xx / 5xx after an action. |
| `failed_request` / `server_error` | A request of the page failed, or answered 5xx. |
| `console_error` | The browser console showed an error or an uncaught exception. |
| `broken_link` | A link on a visited page leads to a page of the site that answers 4xx/5xx (up to `--links` links, default 25, checked through the harness). |
| `crash` | The page crashed. |
| `dead_end` | The AI found no way on toward the goal (with what blocked it). |

**Proposals, never alarms.** The way toward the goal is proposed as a test (when it reached the goal, a regression test for it), and an error page reached by clicking gets a proposed test that fails until it's fixed (`Expect: the page doesn't show "Something went wrong"`). Nothing is saved unless you pass `--save-drafts <folder>` (never into your tests), and exploring never fails a run or a PR: its exit code is 0 unless it couldn't run. `--json` prints everything for an agent.
