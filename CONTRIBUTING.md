# Contributing

Stub; a full guide comes before the repo goes public.

- Use Node 24 and the pnpm version pinned in `package.json`.
- Run `pnpm check` before pushing. CI runs it on Linux, macOS and Windows.
- Never hard-code the product name, CLI name, scope, domain, config file name or
  data dir name. Import them from the brand package.
- The engine must not depend on the closed apps, send telemetry, or make network calls.
- Add a changeset (`pnpm changeset`) for any user-visible change to a package.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`, ...).
