# Variables and test data

Write `{{namespace.name}}` anywhere in a step, in `start`, in `data` values and in flow params. Spaces inside the braces are allowed (`{{ data.email }}`). Write `\{{` for literal braces.

| Namespace | Meaning |
|---|---|
| `data.x` | From the frontmatter `data` (or the environment's override of it). |
| `env.X` | The selected environment's `vars` in the project file. |
| `secret.X` | A credential, UPPER_SNAKE_CASE, declared under `secrets:` in the project file. Never resolved in the test: only the browser or Android driver types it, into an allowed domain. |
| `params.x` | Flows only: a param of this flow. |
| `unique.email`, `unique.id`, `unique.name` | Fresh values per run, so parallel runs don't collide. |
| `faker.name`, `faker.firstName`, `faker.lastName`, `faker.email`, `faker.company`, `faker.phone`, `faker.city` | Realistic values from small built-in word lists. |
| `inbox.code`, `inbox.link`, `inbox.subject` | From the latest email to the test's address in the [test inbox](../auth.md#inboxes): the one-time code, the verify or magic link (only on an allowed domain) and the subject. Read at run time and typed like a secret. |

## data

```yaml
data:
  email: "{{unique.email}}"
  plan: Pro
  greeting: "Welcome to {{data.plan}}"
```

One value each (text, number, true or false). Values may use other data, `env`, `secret`, `unique` and `faker`; they are resolved in dependency order, and a loop is an error (`DATA_CYCLE`). To reuse one generated value in several steps, put it in `data`: `{{data.email}}` is the same address in every step, while `{{unique.email}}` written twice gives two addresses.

## Generated values

Generated values are different on every run and every parallel worker, but repeatable: each depends on the run's seed, the test and where it is used. `{{unique.email}}` uses the domain `example.test`, or the test inbox's domain when a Mailpit or Mailosaur inbox is configured, so the address can receive email.

A sign-up with a fixed address fails as soon as two runs overlap, or on the second run; lint suggests a generated one (`fixed-email`).

## env

```yaml
# %config%
environments:
  staging:
    baseUrl: https://staging.example.com
    vars:
      PLAN: pro
```

`{{env.PLAN}}` is `pro` on staging. A missing var is an error in the editor (`ENV_UNDEFINED`) and blocks the test at run time (`config_error`).

## Secrets

```yaml
# %config%
secrets:
  SHOP_PASSWORD:
    domains: [shop.example.com]
    description: Password of the seeded test user
```

The project file holds secret **names** and the domains each may be typed into, never values. Values come from environment variables of the same name, then `.env.<environment>`, then `.env` (the desktop app also reads its keychain). A secret is typed only into a page on one of its `domains`; anywhere else the action is refused. It never appears in a recording, a report, a log or an AI prompt: they show `{{secret.NAME}}` or `[secret:NAME]`. See [Environments](../environments.md#secrets) and [the safety model](../security/safety-model.md#secrets).

## In recordings

Recordings store templates, not values: a recorded fill is `{{data.email}}`, never the address it typed this time, and a value that equals a variable's value is written back as that variable. So one recorded login works for many test users, and no secret or one-time code ever enters a recording.
