# Cloud cost baseline (rehearsal-local, 2026-10-01)

Engine 0.1.0. Measured on: local. Reproduce: `bench --meter bench/cloud/testdata/rehearsal-local`.

- Cost run rehearsal-local: 6 task(s) (local), 101 test runs.
- Compute is billed on allocation: every task's wall time (container start included when known), rounded up to 100 ms, at least 1 minute, times its vCPU and GiB. Per-test compute is the task time one more test adds; the rest is the fixed per-run overhead.
- Storage per test keeps its evidence 30 days (the product's retention; this run's bucket deletes after 7) plus one Class A write per file. AI at list API prices (packages/models/prices.yaml), also for subscription calls.
- List prices before free tiers, checked 2026-10-01 (bench/cloud/prices.yaml).

## Per test

| | $ per test |
|---|---|
| Web, author (first run, AI included) | $0.000058 |
| Web, replay (unchanged app; evidence: failures, the default outside CI) | $0.00003177 |
| Web, heal (AI included) | $0.000094 |
| Android, replay | not measured |
| Android, author (AI included) | not measured |

Fixed per-run overhead (the cheapest shape; container start, Node, browser, upload, 1-minute minimum): $0.002640.

## Per run of N web tests, by shape

| Shape | Phase | 1 test | 10 tests | 20 tests | 50 tests | 100 tests |
|---|---|---|---|---|---|---|
| 2 vCPU / 4 GiB × 1 | replay | $0.00266 | $0.00280 | $0.00295 | $0.00342 | $0.00544 |
| 2 vCPU / 4 GiB × 1 | author | $0.00267 | $0.00295 | $0.00327 | $0.00421 | $0.00581 |
| 2 vCPU / 4 GiB × 1 | heal | $0.00268 | $0.00301 | $0.00338 | $0.00474 | $0.00946 |
| 2 vCPU / 4 GiB × 4 | replay | $0.00266 | $0.00280 | $0.00296 | $0.00343 | $0.00422 |

## Shapes

| Shape | Tasks | $/s | Overhead s | Replay s/test | Replay $/test |
|---|---|---|---|---|---|
| 2 vCPU / 4 GiB × 1 | 5 | 0.0000440 | 0.351 | 0.877 | $0.00005422 |
| 2 vCPU / 4 GiB × 4 | 1 | 0.0000440 | 0.564 | 0.364 | $0.00003177 |

## Per web test by evidence mode

| Shape | Phase | Evidence | Variants | Tests | s/test | Compute | Storage + writes | AI | Total |
|---|---|---|---|---|---|---|---|---|---|
| 2 vCPU / 4 GiB × 1 | author | failures | correct | 2 | 0.602 | $0.00002647 | $0.00003141 | $0.000000 | $0.00005787 |
| 2 vCPU / 4 GiB × 1 | replay | failures | correct | 22 | 0.877 | $0.00003861 | $0.00001562 | $0.000000 | $0.00005422 |
| 2 vCPU / 4 GiB × 1 | replay | full | correct+broken-total | 22 | 1.989 | $0.00008753 | $0.00007292 | $0.000000 | $0.00016045 |
| 2 vCPU / 4 GiB × 1 | replay | minimal | correct+broken-total | 22 | 1.79 | $0.00007876 | $0.00001943 | $0.000000 | $0.00009819 |
| 2 vCPU / 4 GiB × 1 | heal | failures | cosmetic | 11 | 1.304 | $0.00005737 | $0.00003705 | $0.000000 | $0.00009442 |
| 2 vCPU / 4 GiB × 4 | replay | failures | correct | 22 | 0.364 | $0.00001599 | $0.00001578 | $0.000000 | $0.00003177 |

## Measured

6 tasks, 101 test runs, 128 s of task time, 409.6 CPU-s (machine), peak memory 375 MiB. Container start: not measured ms median; Node start 31 ms; setup 17 ms.

| Fixture | Evidence mode | Passing test MiB | Failing test MiB | Files per test |
|---|---|---|---|---|
| shop | full | 0.464 | 0.985 | 12.3 |
| shop | failures | 0.054 | 0.168 | 3.8 |
| shop | minimal | 0.024 | 0.38 | 3.6 |

## One-off and idle

Image build: 9 min, $0.0540. AI: 2 calls, $0.0000 (scripted:stand-in).

Idle monthly cost: **$0.1100**.

- Artifact Registry: the runner image: $0.1100 (1.60 GiB, first 0.5 GiB-month free; down.sh deletes it)
- Secret Manager: the API key: $0.0000 (1 active version(s), 6 free)
- Cloud Run Job: $0.0000 (a job costs nothing between executions)
- Cloud Storage bucket: $0.0000 (evidence deleted after 7 days by the lifecycle rule; an empty bucket is free)
- Neon, WorkOS: $0.0000 (free tiers at this scale; not used by the runner)

Cloud Run's free tier (240,000 vCPU-s and 450,000 GiB-s a month) and Cloud Build's 2,500 free build-minutes would cover this whole run; the numbers above are before free tiers.

Run total: compute $0.0158, storage $0.002918, AI $0.0000, build $0.0540, Android VM $0.0000: **$0.0728**.
