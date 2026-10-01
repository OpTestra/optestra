---
"@optestra/spec": minor
"@optestra/config": minor
"@optestra/contract": minor
"@optestra/cli": minor
---

Add test lint and editor support to `@optestra/spec`: data-driven lint rules
(vague steps, unobservable or missing expectations, soft-only tests, missing
start, compound expectations, literal credentials, fixed emails, undeclared
destructive steps, vague guards, fixed waits, duplicate names, unused flows) with
quick fixes that never change an expectation line, `checkTest` combining parse,
expand and lint, a `lint` config section, and `createLanguageService` for editors.
The CLI gains `lint [paths] [--fix] [--strict] [--json]`. `testIdFromPath` now
drops the whole `.test.md` suffix (`tests/login.test.md` → `tests__login`).
