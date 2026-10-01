# The cloud cost runner (COST-0)

Runs Bench slices on Google Cloud, measures them, and turns the measurements into
$ per test with list prices. It is built for the cloud cost baseline: one cost
run, torn down afterwards. The product's own cloud workers (CLOUD-2) reuse the
image and the scripts.

| File | What it is |
|---|---|
| `Dockerfile` | The image: the engine (built), Chromium and the bench fixtures, on Node 24 and the Playwright base image (`mcr.microsoft.com/playwright:v1.63.0-noble`, the engine's Playwright). Generic: no project, account or key. Runs as `pwuser`. |
| `cloudbuild.yaml` | The remote build (this Mac has no Docker): hadolint, `docker build`, push to Artifact Registry. |
| `.gcloudignore` | What gets uploaded for the build: the workspace, minus installs, builds, local data and env files. The committed recordings go in. |
| `entry.ts` | One task: reads its slice from the env, runs it (`runSlice` in `@optestra/core/bench`), writes one cost measurement and the evidence to `$OUT/cost-runs/<id>/` (the bucket, mounted at `/mnt/evidence`). |
| `plan.json` | The executions of a cost run: slices, tasks, shape, tests in parallel, expected minutes. |
| `plan.sh` / `plan.ts` | Prints every resource and the expected $. Reads files only. |
| `up.sh` / `run.sh` / `down.sh` | Create / run / tear down. Idempotent; `DRY_RUN=1` prints every gcloud command; `CLOUD_TARGET=local` is the local stand-in. |
| `android.sh` | The Android slice on MOB-3's spot VM (calls their `scripts/android-vm/`). |
| `prices.yaml` | The list prices the meter applies, with their sources and the date checked. |
| `common.sh`, `.env.example` | Settings: env or the git-ignored `bench/cloud/.env`. |
| `RUNBOOK.md` | Tomorrow's run, step by step, with the expected calls, $ and time. |
| `reconcile.md` | Checking the meter against the BigQuery billing export. |
| `testdata/` | A local rehearsal (6 tasks) and its report: the meter's unit test. |

## Design

**One task = one slice.** A slice is a fixture (`shop`, `android`), a phase
(`author`, `replay`, `heal`), variants, reruns, an evidence mode (`full`,
`failures`, `minimal`) and optionally a corpus style. An execution's task *N*
runs `SLICES[N % length]`, so one execution can measure several slices at once.
`PARALLEL` runs that many tests at once inside the task: the tests are dealt to
`PARALLEL` lanes, each with its own fixture server and project copy. The shop's
state lives in its server, so parallel tests that share one server reset each
other's data; a first try did that and got 6 flaky and 1 failed out of 22.

**The Cloud Run Job** (`cost-<id>`, us-east4): 2 vCPU / 4 GiB by default
(`plan.json` sets the shape per execution, `run.sh` updates the job between
shapes), max retries 0, task timeout 45 min, a key-less service account
(objectUser on the bucket, logWriter), the bucket mounted with Cloud Storage
FUSE so the entry writes plain files. Labels: `app=<brand slug>`,
`lane=engine-core`, `cost-run=<id>`.

**The bucket** (`<project>-<brand slug>-cost-runs`, us-east4): uniform
access, public access prevention, no soft delete (so a delete is a delete), and
a lifecycle rule that deletes objects after `RETENTION_DAYS` (7).

**AI in the cloud**, two setups:
- **(a) API key** (`AI_MODE=api`): an Anthropic key in Secret Manager
  (`<brand slug>-anthropic-api-key`), mounted into the job as
  `ANTHROPIC_API_KEY`; `MODEL=anthropic:claude-sonnet-5-5`. You add the key's
  value yourself; no script reads or prints it.
- **(b) subscription** (`AI_MODE=local`, the default): author on this Mac with
  Claude Code (`claude-code:claude-sonnet-5-5`), then ship the recordings
  (`RECORDINGS=` points replay and heal at them). The cloud heal pass then has
  no fixer model, so it measures the no-AI heals; the AI heals' cost comes from
  the local run.

Tokens are priced at list rates either way (`packages/models/prices.yaml`).

**What a task measures** (`CostMeasurement`):
- wall time: the whole task, the tests only, Node start, setup and upload;
- CPU seconds: the container's cgroup in the cloud, the whole machine locally;
- peak memory: the cgroup's `memory.peak`, else the Node process;
- per test: verdict, duration, AI calls, tokens and list $, and the evidence it kept (bytes, files).

`run.sh` adds each task's creation time from gcloud, so the meter gets the
container start (scheduling, image pull, boot, Node).

## The meter

```bash
node packages/cli/bin/cli.js bench --meter bench/cloud/out/cost-runs/<id> [--out bench/results]
```

It writes `<date>-cloud-baseline.json` and `.md`.
- **Compute** is billed on allocation: task wall × (vCPU × $/vCPU-s + GiB × $/GiB-s), rounded up to 100 ms, at least 1 minute per task.
- **Per test** is the task time one more test adds. The rest of the task is the fixed per-run overhead: container start, Node, browser, upload, and the 1-minute minimum.
- **Storage** keeps the evidence 30 days (the product's retention), plus one Class A write per file.
- **The Android VM** is priced per hour (spot + pd-balanced) over the tests it ran, plus create and setup as a fixed cost.
- **Idle monthly** is the image in Artifact Registry and any secret versions over the free 6. The job, the empty bucket, Neon and WorkOS are $0.

The local rehearsal (`testdata/rehearsal-local`) gives on this Mac:
- web replay ≈ **$0.000032/test** at 4 tests in parallel on 2 vCPU / 4 GiB, $0.000054 one at a time;
- the 1-minute minimum makes any task cost at least **$0.00264**, so put many tests in one task;
- a full-evidence test costs about 3× a failures-mode test, because of the video and the trace.
