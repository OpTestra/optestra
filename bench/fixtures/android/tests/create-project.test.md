---
name: A new project is saved
tags: [smoke, projects]
setup:
  - request: POST /__test/seed
    body: { projects: [Website redesign] }
---

1. Use: flows/sign-in.test.md
2. Tap "New project"
3. Type Q3 roadmap into "Project name"
4. Tap "Create project"
5. Expect: a message says "Project created"
6. Expect: the list shows "Q3 roadmap"
7. Tap "Refresh"
8. Expect: the list shows "Q3 roadmap"
