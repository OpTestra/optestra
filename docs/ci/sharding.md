# Sharding

Split a suite across machines with a matrix, then merge and post once. Each shard uploads its results; the final job merges them into one run, exactly as if one machine had run every test, and posts the comment and the check.

```yaml
jobs:
  e2e:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - uses: %repo%/packages/action@v1
        with:
          shard: ${{ matrix.shard }}/4

  e2e-report:
    needs: e2e
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v8
        with:
          pattern: %cli%-run-*
          path: shards
      - uses: %repo%/packages/action@v1
        with:
          merge: shards
```

Tests are split by id (sorted, dealt out in turn): every machine computes the same slices, they never overlap, and their sizes differ by at most one. The merged run interleaves the shards' events by time into one run folder and copies their artifacts; it reports exactly like an unsharded run.

Locally, or in any CI:

```sh
%cli% run --shard 2/4
%cli% merge-runs shard-1 shard-2 shard-3 shard-4 --out merged
```

`merge-runs` takes run folders, or folders that contain them (searched two levels deep), and prints the merged summary like `run`, with the same exit codes.

On the demo shop's nine tests on GitHub's Ubuntu runners, one job took 45.6 s of tests (2 min 7 s for the job); four shards took 8.1–16.5 s of tests each, and 2 min 19 s for the whole pipeline: the setup of each job (about a minute) dominates small suites.

Within one machine, `%cli% run --workers <n>` runs tests in parallel, one browser each.
