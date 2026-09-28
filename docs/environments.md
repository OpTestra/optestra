# Environments and devices

A project has named environments (for example `local`, `preview`, `staging`, `production`), each with its own address, allowed domains, secrets and settings. They live in the project file, `%config%`, next to your tests. The file holds no code and no secret values: loading it is pure parsing.

```yaml
version: 1

project:
  name: Acme Shop
  target: web            # web or android

defaultEnvironment: local

environments:
  local:
    baseUrl: http://127.0.0.1:4100
    allowedDomains: [127.0.0.1]
  staging:
    baseUrl: https://staging.example.com
    allowedDomains: [staging.example.com, "*.stripe.com"]
    vars:
      PLAN: pro
    run:
      retries: 2
  production:
    baseUrl: https://example.com
    production: true

secrets:
  SHOP_PASSWORD:
    domains: [127.0.0.1, staging.example.com]
    description: Password of the seeded user ada@example.com
```

Every key is in the [project file reference](./reference/config.md). `%cli% config --env staging` prints the resolved settings and where each value came from.

## Choosing an environment

The environment is, in order: the command's `--env` (`-e`), the `%ENV%ENVIRONMENT` variable, `defaultEnvironment`, or the only environment if there is just one.

Settings are resolved from, lowest first:

1. the built-in defaults;
2. the project file;
3. the selected environment's overrides: `run`, `secrets`, `models` and `decisions` can be set inside an environment (`environments.production.run.retries: 0`);
4. environment variables: `%ENV%<SECTION>_<FIELD>` sets a plain value (`%ENV%RUN_RETRIES=0`, `%ENV%RUN_BUDGET_MAX_PER_RUN_USD=2`; lists are comma-separated), and `%ENV%BASE_URL`, `%ENV%APP` and `%ENV%ALLOWED_DOMAINS` set the selected environment's values;
5. the command's flags (for example `run --base-url`, `--retries`, `--budget`).

Objects merge key by key; lists and plain values replace. A mistake never stops loading: an invalid value falls back to its default and is reported with its code, the exact fix and the line (see [Troubleshooting](./troubleshooting.md#project-file-problems)).

## Allowed domains

`allowedDomains` lists the hosts tests may reach; it defaults to the host of `baseUrl`. `example.com` allows exactly that host, `*.example.com` its subdomains only; a host allows every port. Everything else is refused **by the browser layer, not by a prompt**: navigations, iframes, popups, requests, sockets and redirects to other hosts never leave the machine. Web pages are http(s) only. See [the safety model](./security/safety-model.md#allowed-domains).

A refused main-page navigation blocks the step (`disallowed_domain`); a refused image or script is recorded and the test goes on. `%cli% snapshot <url> --env staging` prints what the agent sees on a page and any refused requests, which is the quickest way to find a missing domain (a payment iframe, an auth provider).

## Secrets

```yaml
secrets:
  SHOP_PASSWORD:
    domains: [shop.example.com]
    description: Password of the seeded test user
  ADMIN_TOTP:
    domains: [shop.example.com]
    type: totp
```

The file holds each secret's **name** and the **domains** it may be typed into, never its value. Values come from, first match wins:

- an environment variable of the same name;
- `.env.<environment>`, then `.env` in the project folder (git-ignored by `init`);
- the desktop app's keychain, in the desktop app.

A secret is typed only into a page (the element's own frame) on one of its domains, and only there; anywhere else the action is refused with `disallowed_domain`. A missing value blocks the test with `missing_secret`, never fails it. `type: totp` holds a TOTP seed and types the current one-time code: see [Auth profiles and inboxes](./auth.md#totp-secrets).

## Production mode

```yaml
environments:
  production:
    baseUrl: https://example.com
    production: true
```

In a production environment, destructive actions are refused unless the test declares them. The engine detects them from the target's name and text: **delete**, **pay**, **send**, **invite** and **cancel** (a bare "Cancel" button is left out, since it's every dialog's close button). A test that should be allowed to, say, delete something lists it:

```yaml
allowDestructive: [delete]
```

`Never:` guards apply in every environment, production or not. Lint warns about an undeclared destructive step (`destructive-undeclared`).

## Preview deploys and protected previews

`%cli% run --base-url <url>` (or `%ENV%BASE_URL`) runs against another address, for example a preview deploy. An environment's `protection` adds the headers a protected preview needs (Vercel deployment protection, Cloudflare Access, basic auth, a custom header), sent only to allowed hosts in each secret's domains. See [Preview deploys](./ci/previews.md).

## Browsers and devices

Tests run in Chromium by default. Choose per run:

```sh
%cli% run --browser webkit --device iphone-15
%cli% install-browsers --all      # Chromium, Firefox and WebKit
```

| Device presets | |
|---|---|
| Desktops and laptops | `desktop` (1920 × 1080), `laptop` (1440 × 900), `laptop-small` (1280 × 800) |
| Tablets | `ipad`, `ipad-pro`, `galaxy-tab` |
| Phones | `iphone-15`, `iphone-15-pro-max`, `pixel-8`, `galaxy-s24` |

Phones and tablets use Playwright's device descriptors (size, scale, touch, user agent). On Firefox, mobile emulation isn't available, so phones keep their size, scale and touch only. Presets are data (`packages/browser/src/devices.json`), so new devices need no engine change.

Every test gets a fresh browser context: no cookies, storage or permissions carry over from another test (a saved [auth profile](./auth.md) is the one deliberate exception).

::: info Not yet
A matrix of several browsers or devices in one run, and locale and timezone per environment, are not in the project file yet: the harness supports them, the settings come later. Android versions and device profiles: see [Android](./android.md).
:::
