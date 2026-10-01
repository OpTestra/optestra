---
name: A new project is saved
tags: [smoke, projects]
setup:
  - request: POST /__test/seed
    body: { projects: [Website redesign] }
---

<!-- corpus: terse re-phrasing of tests/create-project.test.md -->

1. Use: flows/sign-in.test.md
2. new project
3. name Q3 roadmap
4. create project
5. expect: "Project created" message
6. expect: list shows Q3 roadmap
7. refresh
8. expect: Q3 roadmap still listed
