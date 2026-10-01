---
name: Returning user can sign in
tags: [smoke, auth]
auth: none
setup:
  - request: POST /__test/seed
    body: { projects: [Website redesign] }
timeout: 1m
---

<!-- corpus: spoken re-phrasing of tests/sign-in.test.md -->

okay so type ada at example dot com in the email box and the shop password in the password box and tap sign in, and you should land on projects, the heading says projects, and the list should have website redesign in it
