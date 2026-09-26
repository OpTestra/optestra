# @testament/config

Project settings, environments and secrets. Read by the CLI, the desktop app's
Settings screen, the cloud API and workers, and every engine phase.

The project file is YAML (`testament.config.yaml`; the name comes from brand.json).
Loading is pure parsing: no code in config is ever executed.

## Entry points

| Import | Use | Runs in |
|---|---|---|
| `@testament/config` | schema, types, defaults, `resolveConfig`, diagnostics, `configJsonSchema`, `registerSection` | browser and Node |
| `@testament/config/node` | `findProject`, `loadProject`, `saveProject`, `createProject`, `.env` parsing, secret sources, `resolveSecrets`, `Redactor`, the redacting logger (`createLogger`, `logger`; core re-exports them) | Node |
| `@testament/config/reveal` | `revealSecret`: **restricted** (see below) | Node |
| `@testament/config/schema.json` | JSON Schema of the project file (generated at build) | editors, settings forms |

## Resolution order

Lowest to highest. Objects merge key by key; arrays and plain values replace;
`null` means "not set".

1. **Built-in defaults** from `defaults.yaml`, the only place for default values.
   A `"*"` entry inside a map applies to every entry (e.g. every environment).
2. **Project file.**
3. **Selected environment's overrides**: any section marked `environmentOverride`
   (today `run` and `secrets`) can be set inside an environment, e.g.
   `environments.production.run.retries: 0`.
4. **Environment variables.** `PREFIX_` is the upper-cased CLI name plus `_`
   (`TESTAMENT_` today):
   - `PREFIX_ENVIRONMENT` chooses the environment.
   - `PREFIX_<SECTION>_<FIELD>` sets a plain value, e.g. `PREFIX_RUN_RETRIES=0`
     or `PREFIX_RUN_BUDGET_MAX_PER_RUN_USD=2`. Lists are comma-separated.
   - `PREFIX_BASE_URL`, `PREFIX_APP` and `PREFIX_ALLOWED_DOMAINS` set the selected environment's values.
5. **Run options** passed by the caller (CLI flags, the apps).

The environment is chosen by: the caller's `environment` option, then
`PREFIX_ENVIRONMENT`, then `defaultEnvironment`, then the only environment if
there is just one. `allowedDomains` defaults to the host of `baseUrl`.

Every resolved value has a provenance entry (`default`, `project`, `environment`,
`envVar`, `runOption`, with file/line, environment or variable name), keyed by
config path such as `run.retries`.

## Diagnostics

Loading never throws on user mistakes. Invalid values fall back to their default
(or are dropped) and produce a diagnostic with a stable `code`, `severity`,
`message`, exact `fix`, and `file`/`line`/`path` when known.

`PROJECT_NOT_FOUND`, `YAML_SYNTAX`, `YAML_DUPLICATE_KEY`, `CONFIG_NOT_OBJECT`,
`VERSION_MISSING`, `VERSION_UNSUPPORTED`, `UNKNOWN_KEY` (warning), `REQUIRED_MISSING`,
`INVALID_VALUE`, `ENV_NONE_DEFINED` (warning), `ENV_NOT_SELECTED` (warning),
`ENV_NOT_FOUND`, `ENV_DEFAULT_UNKNOWN`, `ENV_BASE_URL_MISSING`, `ENV_APP_MISSING`,
`SECRET_NAME_INVALID`, `SECRET_DUPLICATE`, `SECRET_NO_DOMAINS`, `SECRET_UNDECLARED`,
`SECRET_MISSING`, `SECRET_INVALID`, `ENV_VAR_INVALID`, `ENV_VAR_UNKNOWN` (warning), `RUN_OPTION_INVALID`,
`ENV_FILE_SYNTAX` (warning).

## Secrets

The project file holds secret **names** and the domains each may be typed into,
never values. Values come from `SecretSource`s, first match wins:

- `processEnvSource()`: variables of the same name.
- `dotenvSource(dir)`: `.env.<environment>`, then `.env`.
- `memorySource(values)`: tests, and apps that bring their own store.

The desktop keychain and the cloud vault will be further `SecretSource`s.

A loaded secret is a `SecretValue`. Printing, logging, JSON-encoding, inspecting
or interpolating it gives `[secret:NAME]`. Every loaded value (and its
URL-encoded, form-encoded, JSON-escaped and base64/base64url forms) is registered
with the process-wide `defaultRedactor`. The engine logger in `core` passes every
line through it.

**`@testament/config/reveal` is restricted.** Only these places may import it
(`test/guards.test.ts` lists the files):
- the browser and Android drivers, to type a value into an allowed domain;
- `packages/models`, to send a provider key to that provider's own host;
- `packages/decide` (`src/node/systemone/`), to send a decision model key (e.g.
  `JEV_API_KEY`) to that backend's own host;
- `packages/auth` (`src/inbox/transport.ts`), to send an inbox API key to that
  inbox's own host.

It has two functions: `revealSecret(secret)` (the stored value) and
`prepareSecret(secret)` (async: the value to type *now*; drivers call it right
before typing).

### Secret types

A declaration may set `type` (default `text`). Other types are registered by the
package that owns them, like config sections
(`registerSecretType({ type, check, producer })` in `/node`):
- `totp` (from `@testament/auth`): the value is a TOTP seed (base32 or an
  `otpauth://` URI) and typing it types the current code.

`resolveSecrets` checks each typed value with the type's `check`. A bad value is
`SECRET_INVALID` (in `invalid`, never in `secrets`), and the message never
includes the value. Parts of the value the type names (e.g. the seed inside the
URI) are registered with the redactor too. A good value becomes a **dynamic**
`SecretValue` (`secret.dynamic`, `secret.type`). `prepareSecret` produces its
value at the moment of typing and registers it with the redactor first.
`asDynamicSecret(secret, type, produce)` makes one directly (e.g. an inbox code
that arrives by email).

Nothing else may: not logging, reports, AI prompts or the apps.

Known limit: a secret embedded inside a larger encoded blob (for example
base64 of `user:password`) is not detected. Callers that build such values must
register the combined value with the redactor.

## Saving

`saveProject(dir, patch)` validates the change and refuses it if it introduces
errors. Writes are atomic. Changing an existing plain value rewrites only that
value, so the rest of the file stays byte-identical. Adding or removing keys,
or replacing lists, goes through the YAML document model: comments and key order
are kept, but spacing in the file may be normalised.

## Adding a section (later phases)

```ts
import { registerSection } from "@testament/config";
import { z } from "zod";

registerSection({
  key: "models",
  schema: z.strictObject({ provider: z.string(), maxTokens: z.number().int() }),
  defaults: { provider: "hosted", maxTokens: 4096 }, // or put them in defaults.yaml
  environmentOverride: true,
});

declare module "@testament/config" {
  interface ConfigSections {
    models: { provider: string; maxTokens: number };
  }
}
```

The section then shows up in validation, defaults, env vars
(`PREFIX_MODELS_PROVIDER`), environment overrides and the JSON Schema. No
loader or merge change is needed. Register it when the owning package loads,
before any config is loaded. Values in `defaults.yaml` under the same key win
over `defaults`.

Registered sections today: `models` (from `@testament/models`), `tests` (where
the test files are) and `lint` (rule levels, strict) from `@testament/spec`,
`decisions` (decision backend and its jev/kev/laya settings, thresholds, time limits,
cache) from `@testament/decide`, and `auth` (login profiles, TOTP) and `inbox` (test
email inboxes) from `@testament/auth`. Import the owning package before
loading config, or the section is reported as unknown. The full schema
including `models` is `@testament/models/schema.json`.

After editing `defaults.yaml`, run `pnpm --filter ./packages/config gen:defaults`.
A test fails if you forget.
