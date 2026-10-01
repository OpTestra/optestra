# Accessibility warnings

With accessibility checks on, every page a run visits is checked with [axe-core](https://github.com/dequelabs/axe-core) against WCAG 2 A and AA (2.0, 2.1 and 2.2 AA rules). The problems are warnings, shown apart from pass and fail: they never fail a test or a run.

```yaml
# the project file
accessibility: warn   # off (the default) or warn
```

or for one run:

```sh
%cli% run --accessibility
```

## What is checked

Each page is checked once per attempt, when the test first gets there: the start page, then after each action that lands on another route. A problem is reported once per page and rule, with how many elements have it and a few of their selectors. Selectors and help texts pass through the secret scrubber.

The check runs in the page through the harness, and axe is removed again afterwards: the app's own scripts never see it.

## Where it shows

| Output | |
|---|---|
| Terminal | `2 accessibility warnings on 9 pages checked (not failures): color-contrast, label` |
| HTML report | An "Accessibility warnings" section: test, page, rule, impact, elements |
| JSON summary | `accessibility: { pages, ms, violations: [{ rule, impact, help, helpUrl, page, nodes }] }` per test |
| JUnit | `<property name="accessibility.pages">`, `<property name="accessibility.warnings">` and one `<property name="accessibility.warning">` per problem |
| Markdown summary | An "Accessibility warnings" block |

## Cost

On the demo shop a check takes about 40 to 50 ms per page (about 160 ms on a page with an embedded payment frame), about 60 ms on average: about 1.7 seconds over the 27 pages of its 11 tests. With `accessibility: off` nothing is injected or run, so replays are exactly as fast as without it.
