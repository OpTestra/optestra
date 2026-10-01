---
name: A new project is saved
tags: [smoke, projects]
setup:
  - request: POST /__test/seed
    body: { projects: [Website redesign] }
---

<!-- corpus: sloppy re-phrasing of tests/create-project.test.md -->

1. Use: flows/sign-in.test.md
2. Tap "Create project"
3. Type Q3 roadmap into "Name"
4. Tap "Create"
5. Expect: a message says "Project created"
6. Expect: the list shows "Q3 roadmap"
7. Tap "Reload"
8. Expect: the list shows "Q3 roadmap"
