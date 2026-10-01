---
name: A new project is saved
tags: [smoke, projects]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: mixed re-phrasing of tests/create-project.test.md -->

1. Use: flows/login.test.md
2. Click "Create project" on the dashboard
3. Expect: a dialog titled "New project" is open
4. Type Q3 roadmap into the project name field
5. Click "Create"
6. Expect: a message says "Project created"
7. Expect: the projects list shows "Q3 roadmap"
8. Reload the page to make sure it was really saved
9. Expect: the projects list shows "Q3 roadmap"
