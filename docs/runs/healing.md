# Healing

When your app changes, a recorded step may no longer find its element: a button was renamed, a form moved. That is a **miss**. %Name% tries to heal it, cheapest first, and shows you every fix. **A heal changes how a step is done, never what is checked**: a heal can never make a failed check pass, and nothing edits an `Expect:` line.

## The ladder

| Rung | When | What happens |
|---|---|---|
| block | the action was refused, no AI is left, or the app is unreachable | the test is **blocked** with the reason |
| no heal | the validated element did nothing (the effect didn't show) | the step **fails**: "the right element was used, but nothing happened" |
| fallback locator | another locator stored in the recording finds the same element | acts on it, no AI; a heal proposal |
| re-find | ranking the page's elements against the recorded fingerprint gives one clear winner | acts on it, no AI; a heal proposal |
| no heal | the policy is `strict` | the step **fails** (test drift) |
| fixer | a fixer model is available and budget is left | the fixer redoes the step; a heal proposal |

An error page or a 5xx is not a miss: the step fails, and the failure cause decides whether it was the product or the environment. `--replay-only` and the `strict` policy never heal: any miss fails.

### The fixer

The fixer is the authoring agent in a "single step" mode, using the `fixer` model role (Haiku 4.5 by default, or your subscription). It gets the step, the step's recorded actions (done now, missed now, not done yet, with what each element was), why it missed, and the page. It has the same closed tool set, guards and `Never:` lines, never sees a check and never replans the test. Limits: 4 actions, 6 model calls, 2 failures in a row.

Its result counts only when:

1. the harness saw a visible change;
2. the step's recorded effect shows up in what it did;
3. the change passes a strict schema that allows only locator, action and wait changes;
4. every later check passes.

Otherwise the step fails with the fixer's reason. A budget or AI outage in the middle of a heal blocks the test (`budget_exceeded`, `ai_unavailable`).

## Policies

Per test (`heal:` in the frontmatter), else `run.healPolicy`.

| Policy | On a miss | Verdict | Recording |
|---|---|---|---|
| `strict` | no fallback, no re-find, no fixer: the step fails | failed | unchanged |
| `review` (default) | heals (no-AI rungs first, then the fixer) | healed | unchanged: the fix waits for you |
| `auto` | heals | healed (the headline says "applied") | a passed attempt's heals are applied at once; a heal classed as a **behaviour change** never is: it stays pending, with a warning |

A healed test fails the CLI's exit code and the CI check unless the policy is `auto`.

## Review and accept

```sh
%cli% heal                        # list the latest run's heals
%cli% heal --accept all           # accept every acceptable heal
%cli% heal <runDir> --accept 01K… --reject 01K…
%cli% heal --json                 # for agents and the apps
```

The list shows each heal with the recording's before and after (one line per command), how it was healed, its class, its confidence and the signals behind it, and "the app's behaviour may have changed — check before accepting" for a behaviour change. Only heals from an attempt that passed can be accepted: they proved themselves.

Accepting:

- applies the change to the recording: only the healed steps' commands change; step keys, other steps and every check stay exactly as they were. A step that changed since the run is a conflict, never applied twice;
- regenerates the portable Playwright spec (a spec you edited by hand is left alone, with a warning);
- records your decision in the run folder (the run's own results never change);
- writes labelled examples to the project's data folder, for evaluating and later training the decision models.

Rejecting leaves the recording as it was. **Nothing is committed to git**: you commit the updated recording like any other change. After an accept, the next run replays the step from the recording with zero AI.

In the apps, the same review is **Review fixes** on a result, with **Accept** and **Reject**.

## Classes

Every heal is classed as `cosmetic` (the same behaviour, a changed look or wording), `behavior_change`, or `unknown`. Rules decide most; they never answer `unknown` themselves. `auto` never applies a behaviour change.

## Repeated heals

Each result counts how often the test healed in its last 10 runs. At 3 or more, the run says "re-record this test", with the command:

```sh
%cli% run tests/checkout.test.md --rerecord
```

`heal --list`, the JSON results (`rerecord`) and the HTML report show it too.
