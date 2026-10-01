---
name: A new project is saved
tags: [smoke, projects]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: sloppy re-phrasing of tests/create-project.test.md -->

1. Use: flows/login.test.md
2. click "New Project"
3. Expect: a dialog titled "New project" is open
4. Fill "Name" with Q3 roadmap
5. click "Create"
6. Expect: a message says "Project created"
7. Expect: the projects list shows "Q3 roadmap"
8. refresh the page
9. Expect: the projects list shows "Q3 roadmap"
