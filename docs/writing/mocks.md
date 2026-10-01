# Mocking the network

Two ways to control what the app's API answers, both inside the browser harness: a mock can only answer a request the [allowed domains](../environments.md#allowed-domains) already let through.

## Mock steps

A `Mock:` step answers the app's matching requests from that step on, instead of the app's server. It needs no AI and no recording.

```markdown
1. Use: flows/login.test.md
2. Mock: POST /api/projects returns 500 files/error.json
3. Click "Create project"
4. Fill "Project name" with Q3 roadmap
5. Click "Create"
6. Expect: a message says "Couldn't create project. Please try again."
```

`Mock: <METHOD> <path or URL> returns [status] [file]`

- **Method:** GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS.
- **Path or URL:** a path on the base URL (`/api/orders`) or an http(s) URL on an allowed domain. `*` matches anything (`/api/orders/*`). Without a `?`, any query string matches; with one, the query must match too. Values work: `/api/users/{{data.id}}`.
- **Status:** 100 to 599; 200 when left out.
- **File:** the response body, relative to the tests folder (`files/error.json`), never outside it. Its type comes from the extension (`.json`, `.html`, `.txt`, `.xml`, `.csv`). With no file the body is empty.

A later `Mock:` for the same request overrides an earlier one. A mock on a domain that isn't allowed blocks the test (`config_error`) and says which domain.

Every attempt lists the responses that came from a mock, with how many requests each answered: the HTML report's "Mocked responses", `mocks` in the [JSON summary](../reference/results-json.md), the JUnit property `mocked.responses`, and "(mocked)" in the Markdown summary. A test that passes because of a mock never looks like it passed against the real API.

Android tests can't mock (`MOCK_UNSUPPORTED`): the emulator's traffic doesn't go through the harness's route handler.

## Recorded traffic

For full determinism, keep the API's answers once and replay them on later runs:

```sh
%cli% run --record-network      # keep each test's fetch/XHR answers
%cli% run                       # answers them from the recording when there is one
%cli% run --live-network        # ignore the recordings: every request goes to the app
```

`--record-network` writes `%dataDir%/<test id>.network.har` next to the test's recording: a standard HAR 1.2 file, so it opens in browser devtools. Only fetch and XHR requests are kept (documents, scripts, styles and images always come from the app), only the ones the allowlist let through, text bodies pass through the secret scrubber, binary bodies are left out and of the headers only the content type is kept: no cookies, no tokens. Requests to the app's own origin are matched by path and query, so a recording made on one port or preview URL replays on another.

On replay, a request in the file gets its recorded answers in order (the last one repeats); anything else goes to the app. A `Mock:` step still wins over the recording. The attempt's mocks list one `recorded` entry with how many requests the file answered.

Commit the `.network.har` files with the recordings, or leave them out of git: runs without one simply go to the app.

## In exported specs

The [generated Playwright spec](../export.md) keeps `Mock:` steps, as `await mock(page, …)` with the same matching. Recorded traffic is a %Name% replay feature and isn't exported.
