# Preview deploys

## Vercel and Netlify previews

They report a `deployment_status`. Run on the successful ones; the Action takes the preview URL from the event and finds the pull request by its commit:

```yaml
on:
  deployment_status:

jobs:
  e2e:
    # Only once the preview is live (also skips pending, failure and error statuses).
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.deployment.sha }}
      - uses: %repo%/packages/action@v1
        with:
          env: preview   # an environment whose allowedDomains include the preview host
        env:
          VERCEL_BYPASS: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

The base URL comes from `environment_url`. If the environment sets `allowedDomains`, include the preview's host (for example `*.vercel.app`); if it doesn't, the allowlist is the preview's host.

Outside the Action, `%cli% run --base-url <url>` (or `%ENV%BASE_URL`) does the same.

## Protected previews

Deployment protection, Cloudflare Access, basic auth or a custom header: the environment names the secrets, and each header is sent **only to allowed hosts in its secret's `domains`**, never anywhere else. Values never appear in evidence.

```yaml
# %config%
secrets:
  VERCEL_BYPASS:
    domains: ["*.vercel.app"]
environments:
  preview:
    baseUrl: https://example.vercel.app   # replaced by the deployment URL in CI
    allowedDomains: ["*.vercel.app"]
    protection:
      vercelBypass: VERCEL_BYPASS                      # x-vercel-protection-bypass
      # cloudflareAccess: { clientId: CF_ID, clientSecret: CF_SECRET }
      # basicAuth: { username: PREVIEW_USER, password: PREVIEW_PASSWORD }  # unless a request sets its own Authorization
      # headers: { X-Preview-Token: PREVIEW_TOKEN }
```

A missing protection secret blocks every test with `missing_secret` (neutral), instead of failing them all against a login wall. That is what happens on a pull request from a fork.

::: warning Redirects carry headers
Browsers keep a request's added headers when a server redirects it. A redirect to a host outside the allowlist is refused before anything is sent; a redirect to another *allowed* host would carry the header. Keep each secret's `domains` to the hosts you'd trust with it.
:::
