# Other CI systems

Everything the GitHub Action does is the open CLI underneath. The pattern is
the same everywhere:

1. `%cli% doctor --json --strict`: a pre-check. Exit 0 when the project,
   environment, secrets, browser and AI setup are ready. Anything else stops the
   job with the reason, before any test runs.
2. `%cli% run --replay-only`: exit 0 passed, 1 failed, 2 blocked.
3. `%cli% results <run> --junit junit.xml --markdown summary.md`: JUnit for
   the CI's test tab, Markdown for a merge-request note.
4. `%cli% report <run>`: the offline HTML report in the run folder. Keep the
   whole folder as an artifact (videos, traces, screenshots).

Decide what exit code 2 (blocked: couldn't run) means for you. The recipes treat
it as "don't fail the pipeline, but make it visible" (GitHub's neutral).

Secrets come from the CI's secret store as environment variables, by the names
your project declares. Never expose them to jobs for merge requests from forks.

## Docker image

```dockerfile
# Playwright's image has Chromium's system libraries.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN npm install -g %scope%/cli@0.4.2 && %cli% install-browsers
WORKDIR /work
ENTRYPOINT ["%cli%"]
```

```bash
docker run --rm -v "$PWD:/work" -e TEST_PASSWORD %cli%-cli run --replay-only
```

## GitLab CI

```yaml
e2e:
  image: mcr.microsoft.com/playwright:v1.63.0-noble
  variables:
    %ENV%BASE_URL: $CI_ENVIRONMENT_URL   # a review app, if you have one
  script:
    - npm install -g %scope%/cli@0.4.2
    - %cli% install-browsers
    - %cli% doctor --json --strict
    - set +e; %cli% run --replay-only; code=$?; set -e
    - run=$(ls -d %dataDir%/runs/* | sort | tail -1)
    - %cli% results "$run" --junit junit.xml --markdown summary.md || true
    - %cli% report "$run"
    - cp -r "$run" e2e-run
    - if [ "$code" = 2 ]; then echo "Some tests were blocked (couldn't run); see summary.md"; exit 0; fi
    - exit $code
  artifacts:
    when: always
    paths: [e2e-run, summary.md]
    reports:
      junit: junit.xml
```

Sharding: `parallel: 4` and `%cli% run --shard $CI_NODE_INDEX/$CI_NODE_TOTAL`,
then a later job with `needs:` runs `%cli% merge-runs <artifact folders> --out merged`.

## CircleCI

```yaml
version: 2.1
jobs:
  e2e:
    docker:
      - image: mcr.microsoft.com/playwright:v1.63.0-noble
    parallelism: 4
    steps:
      - checkout
      - run: npm install -g %scope%/cli@0.4.2 && %cli% install-browsers
      - run: %cli% doctor --json --strict
      - run:
          name: Run tests
          command: |
            set +e
            %cli% run --replay-only --shard $((CIRCLE_NODE_INDEX + 1))/$CIRCLE_NODE_TOTAL
            code=$?
            run=$(ls -d %dataDir%/runs/* | sort | tail -1)
            %cli% results "$run" --junit results/junit.xml
            %cli% report "$run"
            mkdir -p artifacts && cp -r "$run" artifacts/run
            [ "$code" = 2 ] && exit 0
            exit $code
      - store_test_results:
          path: results
      - store_artifacts:
          path: artifacts
workflows:
  e2e:
    jobs: [e2e]
```

## Bitbucket Pipelines

```yaml
image: mcr.microsoft.com/playwright:v1.63.0-noble
pipelines:
  pull-requests:
    "**":
      - step:
          name: e2e
          script:
            - npm install -g %scope%/cli@0.4.2
            - %cli% install-browsers
            - %cli% doctor --json --strict
            - set +e; %cli% run --replay-only; code=$?; set -e
            - run=$(ls -d %dataDir%/runs/* | sort | tail -1)
            # Bitbucket reads JUnit files from test-results/ automatically.
            - mkdir -p test-results && %cli% results "$run" --junit test-results/junit.xml || true
            - %cli% report "$run" && cp -r "$run" e2e-run
            - if [ "$code" = 2 ]; then exit 0; fi
            - exit $code
          artifacts:
            - e2e-run/**
```

Bitbucket doesn't pass secured variables to pull requests from forks; tests that
need them are Blocked (missing secret), exit 2.

## Preview URLs

Point a run at a preview with `--base-url <url>` (or the `%ENV%BASE_URL`
variable). Protected previews: see [Protected previews](./previews.md#protected-previews);
it's project configuration, so it works the same in every CI.
