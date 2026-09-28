---
layout: home
hero:
  name: "%Name%"
  text: Tests in plain English. Replayed with no AI. Owned by you.
  tagline: Write what should happen. The first run works out the steps with AI and records them; every later run replays the recording with no AI and checks every Expect line with plain code.
  actions:
    - theme: brand
      text: Quickstart
      link: /quickstart/cli
    - theme: alt
      text: What it is
      link: /overview
    - theme: alt
      text: Writing tests
      link: /writing/test-files
features:
  - title: A pass means a real check passed
    details: Every Expect line becomes a typed check that code evaluates on every run. A model never decides pass or fail.
    link: /runs/checks-and-verdicts
  - title: Zero AI when nothing changed
    details: Recordings replay without a model. The AI comes back only for a step that no longer works.
    link: /runs/how-a-run-works
  - title: Every fix is reviewed
    details: A heal changes how a step is done, never what is checked, and waits for your approval by default.
    link: /runs/healing
  - title: Your tests are Playwright code
    details: Every recorded test is also a plain Playwright spec that runs without %Name% installed.
    link: /if-it-disappears
  - title: Clear about data
    details: Your own key or subscription, on your own machine. The engine sends nothing to us.
    link: /security/data
  - title: Safe by construction
    details: Allowed domains enforced below the browser, a closed action set, secrets typed but never seen.
    link: /security/safety-model
---
