---
name: A new project is saved
tags: [smoke, projects]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: terse re-phrasing of tests/create-project.test.md -->

1. Use: flows/login.test.md
2. click create project
3. expect: new project dialog open
4. name: Q3 roadmap
5. create
6. expect: toast "Project created"
7. expect: list shows Q3 roadmap
8. reload
9. expect: Q3 roadmap still in the list
