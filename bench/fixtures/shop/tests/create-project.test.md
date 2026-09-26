---
name: A new project is saved
tags: [smoke, projects]
start: /login
setup:
  - request: POST /__test/seed
---

1. Use: flows/login.test.md
2. Click "Create project"
3. Expect: a dialog titled "New project" is open
4. Fill "Project name" with Q3 roadmap
5. Click "Create"
6. Expect: a message says "Project created"
7. Expect: the projects list shows "Q3 roadmap"
8. Reload the page
9. Expect: the projects list shows "Q3 roadmap"
