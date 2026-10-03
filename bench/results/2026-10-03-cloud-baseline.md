# Cost baseline baseline-20261003 (2026-10-03)

Model ollama-cloud:deepseek-v4.1-flash as planner and fixer. Engine 0.1.0. Prices: bench/cloud/prices.yaml, checked 2026-10-01, list before free tiers.

- Cost run baseline-20261003: 9 task(s) (cloud-run), 726 test runs.
- Compute is billed on allocation: every task's wall time (container start included when known), rounded up to 100 ms, at least 1 minute, times its vCPU and GiB. Per-test compute is the task time one more test adds; the rest is the fixed per-run overhead.
- Storage per test keeps its evidence 30 days (the product's retention; this run's bucket deletes after 7) plus one Class A write per file. AI at list API prices (packages/models/prices.yaml), also for subscription calls.
- List prices before free tiers, checked 2026-10-01 (bench/cloud/prices.yaml).
- Corpus: every entry authored once on the model as planner and fixer (one pass, no retries); its recordings replayed with no AI on every variant; one cosmetic pass with the fixer. Per-test author cost = AI (drafting included for descriptions) + the cloud's compute for authoring one test.
- Android: MOB-3's spot VM (n2-standard-4, nested virtualization, 30 GiB pd-balanced). Cold = create + setup + replay; image = a VM from the reusable image + replay. Flakiness (tests that didn't give the manifest's verdict) is reported apart from cost; their VM time is in the cost.

## Headline numbers

| | $ |
|---|---|
| Web test, author (AI + cloud), tidy style | $0.00376 |
| Web test, replay (cheapest good shape) | $0.00006370 |
| Web test, heal (cloud cosmetic pass, per test) | $0.000303 |
| Run of 20 web tests (cheapest good shape) | $0.00288 |
| Fixed overhead per run (cheapest shape) | $0.00161 |
| Android test, cold VM: all-in / marginal | $0.00097 / $0.000766 |
| Android test, VM from the image: all-in / marginal | $0.00124 / $0.001214 |
| Idle month (staging, reaper, registry, image) | $0.5124 |
| AI for the whole run: 2247 calls | $0.8220 list, $0.4110 off-peak |

Cheapest good shape: **1 vCPU / 2 GiB × 1**: every correct replay passed, 20 tests in 116.5 s (CI-6: at most 600 s).

## Shapes (web replay of the unchanged app, 110 test runs each)

| Shape | Verdicts | s/test | 20 tests | Run of 20 | $/test |
|---|---|---|---|---|---|
| 1 vCPU / 2 GiB × 1 ✓ | 110/110 passed | 2.169 | 116.5 s | $0.00288 | $0.00006370 |
| 1 vCPU / 2 GiB × 4 | 109/110 passed | 2.526 | 132.8 s | $0.00327 | $0.00007287 |
| 2 vCPU / 4 GiB × 1 ✓ | 110/110 passed | 1.388 | 125.8 s | $0.00585 | $0.00007683 |
| 2 vCPU / 4 GiB × 4 | 109/110 passed | 1.907 | 136 s | $0.00633 | $0.00010108 |

## Per phrasing style (web): authoring and wrong verdicts

| Style | Route | Lint ok/warn/rej | Authored passed | Wrong passes | Wrong fails | Calls/test | AI $/test | off-peak | Author $/test | Heal $/test |
|---|---|---|---|---|---|---|---|---|---|---|
| tidy | file | 11/0/0 | 9/11 | 0/15 | 13/73 | 11.55 | $0.00326 | $0.00163 | $0.00376 | $0.00107 |
| terse | file | 10/1/0 | 6/11 | 0/15 | 37/73 | 13.45 | $0.00644 | $0.00322 | $0.00694 | $0.00098 |
| terse | description | 10/1/0 | 7/11 | 1/15 | 25/73 | 22.36 | $0.00875 | $0.00438 | $0.00924 | $0.00079 |
| verbose | description | 0/0/11 | 8/11 | 1/15 | 20/73 | 21.55 | $0.00769 | $0.00384 | $0.00818 | $0.00104 |
| verbose | file | 0/0/11 | 0/11 | 0/15 | 73/73 | 0.73 | $0.00016 | $0.00008 | $0.00065 | $0.00000 |
| acceptance | description | 0/0/11 | 7/11 | 1/15 | 27/73 | 23.82 | $0.00907 | $0.00453 | $0.00956 | $0.00083 |
| acceptance | file | 0/0/11 | 0/11 | 0/15 | 73/73 | 1.55 | $0.00047 | $0.00023 | $0.00096 | $0.00009 |
| gherkin | description | 0/0/11 | 7/11 | 1/15 | 26/73 | 21.45 | $0.00827 | $0.00413 | $0.00876 | $0.00059 |
| gherkin | file | 0/0/11 | 0/11 | 0/15 | 73/73 | 0.73 | $0.00016 | $0.00008 | $0.00065 | $0.00000 |
| spoken | description | 0/0/11 | 7/11 | 2/15 | 26/73 | 22.73 | $0.00854 | $0.00427 | $0.00904 | $0.00093 |
| spoken | file | 0/0/11 | 0/11 | 0/15 | 73/73 | 0.73 | $0.00016 | $0.00008 | $0.00065 | $0.00000 |
| sloppy | file | 11/0/0 | 6/11 | 0/15 | 33/73 | 10.45 | $0.00308 | $0.00154 | $0.00358 | $0.00087 |
| mixed | file | 11/0/0 | 11/11 | 0/15 | 1/73 | 11.73 | $0.00316 | $0.00158 | $0.00365 | $0.00009 |

## Per complexity (web, every style)

| Complexity | Tests | AI $/test | off-peak | Author $/test |
|---|---|---|---|---|
| medium | 78 | $0.00307 | $0.00153 | $0.00356 |
| complex | 65 | $0.00634 | $0.00317 | $0.00683 |

## Android

| Path | VM s | Create | Setup | Replay | Tests | All-in $/test | Marginal $/test | VM $ | Verdicts (match / healed / needs AI / mismatch) |
|---|---|---|---|---|---|---|---|---|---|
| cold | 2362.8 | 14.5 s | 433.7 s | 1864.6 s | 42 | $0.00097 | $0.000766 | $0.0408 | 35 / 5 / 2 / 0 |
| image | 3022.6 | 25.6 s | – s | 2954 s | 42 | $0.00124 | $0.001214 | $0.0522 | 35 / 5 / 2 / 0 |

| Android style | Route | Authored passed | Wrong passes | Wrong fails | Calls/test | AI $/test |
|---|---|---|---|---|---|---|
| tidy | file | 4/4 | 0/6 | 0/18 | 10.5 | $0.00284 |
| terse | file | 2/4 | 0/6 | 10/18 | 11.5 | $0.00610 |
| spoken | file | 0/4 | 0/6 | 18/18 | 0 | $0.00000 |
| sloppy | file | 2/4 | 0/6 | 7/18 | 10 | $0.00320 |

## Idle month

- Staging web app (Cloud Run service): $0.0000 (min instances 0: scales to zero, billed only while serving)
- VM reaper (Cloud Run service + Cloud Scheduler): $0.1032 (4383 calls a month × 0.94 s at 1 vCPU / 0.25 GiB (list, inside Cloud Run's free tier); 1 scheduler job(s), 3 free per billing account)
- Artifact Registry (images that stay): $0.0000 (0.25 GiB, first 0.5 GiB-month free; the cost-run repo is deleted)
- Android image android-vm-20261003-110740: $0.4092 (7.44 GiB stored at $0.055/GiB-month; deleted after its ttl (7 days))
- Total: **$0.5124**

## Reconciliation and notes

- Run window for the billing export: 2026-10-03 05:00–09:15 UTC, label cost-run=baseline-20261003 (job, bucket, registry repo, secret, VMs, image). The BigQuery export was enabled during the run; if it does not include that window, compare the console's Billing > Reports view filtered by the label instead.
- Ollama: the usage page shows no per-day breakdown, so compare the month-to-date change. The meter estimates 2,247 calls: $0.82 at the peak list rate, $0.41 at the off-peak rate that applies on a Saturday (the whole run).
- The bill will be higher than the per-test prices: the Android VMs were up 6.71 h in total (about $0.42 at list) against about 1.5 h of measured work. A dropped ssh killed two replays' output (re-run detached on the same VMs), the first cold VM's replay hit a gcloud 502, and two corpus VMs stopped early (a 502 before start, then a missing CLI build) before any AI call. Also 3 failed Cloud Builds (about 5 min) and 1 failed job execution (about 4 min, the evidence copy to the bucket mount) before the fixes.
- Flakiness, kept apart from cost: the web 4-lane shapes had 1 flaky test in 110 on both sizes; Android had 0 mismatches in 84 replays (cold 42, image 42: 35 match, 5 healed, 2 need AI each).
- Wrong passes: 0 on every file-route style; 6 on the description route (drafts that dropped a bug-catching check: checkout-trial on broken-total ×4, create-project on broken-not-saved ×2).
- Not run: the OpenRouter slice (no OpenRouter key supplied).

## The cloud tasks (meter)

Engine 0.1.0. Measured on: cloud-run. Reproduce: `bench --meter bench/results/2026-10-03-cost-run`.

- Cost run baseline-20261003: 9 task(s) (cloud-run), 726 test runs.
- Compute is billed on allocation: every task's wall time (container start included when known), rounded up to 100 ms, at least 1 minute, times its vCPU and GiB. Per-test compute is the task time one more test adds; the rest is the fixed per-run overhead.
- Storage per test keeps its evidence 30 days (the product's retention; this run's bucket deletes after 7) plus one Class A write per file. AI at list API prices (packages/models/prices.yaml), also for subscription calls.
- List prices before free tiers, checked 2026-10-01 (bench/cloud/prices.yaml).

## Per test

| | $ per test |
|---|---|
| Web, author (first run, AI included) | $0.003504 |
| Web, replay (unchanged app; evidence: failures, the default outside CI) | $0.00006370 |
| Web, heal (AI included) | $0.000303 |
| Android, replay | not measured |
| Android, author (AI included) | not measured |

Fixed per-run overhead (the cheapest shape; container start, Node, browser, upload, 1-minute minimum): $0.001610.

## Per run of N web tests, by shape

| Shape | Phase | 1 test | 10 tests | 20 tests | 50 tests | 100 tests |
|---|---|---|---|---|---|---|
| 1 vCPU / 2 GiB × 1 | replay | $0.00167 | $0.00225 | $0.00288 | $0.00479 | $0.00798 |
| 1 vCPU / 2 GiB × 4 | replay | $0.00188 | $0.00254 | $0.00327 | $0.00545 | $0.00910 |
| 2 vCPU / 4 GiB × 1 | replay | $0.00439 | $0.00509 | $0.00585 | $0.00816 | $0.01200 |
| 2 vCPU / 4 GiB × 1 | author | $0.00782 | $0.03936 | $0.07440 | $0.17952 | $0.35473 |
| 2 vCPU / 4 GiB × 1 | heal | $0.00462 | $0.00735 | $0.01038 | $0.01947 | $0.03462 |
| 2 vCPU / 4 GiB × 4 | replay | $0.00441 | $0.00532 | $0.00633 | $0.00936 | $0.01442 |

## Shapes

| Shape | Tasks | $/s | Overhead s | Replay s/test | Replay $/test |
|---|---|---|---|---|---|
| 1 vCPU / 2 GiB × 1 | 1 | 0.0000220 | 73.103 | 2.169 | $0.00006370 |
| 1 vCPU / 2 GiB × 4 | 1 | 0.0000220 | 82.239 | 2.526 | $0.00007287 |
| 2 vCPU / 4 GiB × 1 | 6 | 0.0000440 | 98.055 | 1.388 | $0.00007683 |
| 2 vCPU / 4 GiB × 4 | 1 | 0.0000440 | 97.879 | 1.907 | $0.00010108 |

## Per web test by evidence mode

| Shape | Phase | Evidence | Variants | Tests | s/test | Compute | Storage + writes | AI | Total |
|---|---|---|---|---|---|---|---|---|---|
| 1 vCPU / 2 GiB × 1 | replay | failures | correct | 110 | 2.169 | $0.00004773 | $0.00001597 | $0.000000 | $0.00006370 |
| 1 vCPU / 2 GiB × 4 | replay | failures | correct | 110 | 2.526 | $0.00005557 | $0.00001730 | $0.000000 | $0.00007287 |
| 2 vCPU / 4 GiB × 1 | author | failures | correct | 11 | 10.857 | $0.00047770 | $0.00001728 | $0.003009 | $0.00350409 |
| 2 vCPU / 4 GiB × 1 | replay | failures | correct | 110 | 1.388 | $0.00006106 | $0.00001577 | $0.000000 | $0.00007683 |
| 2 vCPU / 4 GiB × 1 | replay | failures | every variant | 88 | 3.313 | $0.00014576 | $0.00002669 | $0.000000 | $0.00017245 |
| 2 vCPU / 4 GiB × 1 | replay | full | every variant | 88 | 4.156 | $0.00018286 | $0.00007465 | $0.000000 | $0.00025751 |
| 2 vCPU / 4 GiB × 1 | replay | minimal | every variant | 88 | 3.527 | $0.00015519 | $0.00002302 | $0.000000 | $0.00017821 |
| 2 vCPU / 4 GiB × 1 | heal | failures | cosmetic | 11 | 3.8 | $0.00016721 | $0.00004216 | $0.000094 | $0.00030301 |
| 2 vCPU / 4 GiB × 4 | replay | failures | correct | 110 | 1.907 | $0.00008389 | $0.00001718 | $0.000000 | $0.00010108 |

## Measured

9 tasks, 726 test runs, 2599.9 s of task time, 2126.5 CPU-s (machine), peak memory 487 MiB. Container start: 14357 ms median, 32929 ms max; Node start 278 ms; setup 180 ms.

| Fixture | Evidence mode | Passing test MiB | Failing test MiB | Files per test |
|---|---|---|---|---|
| shop | full | 0.465 | 0.647 | 12.7 |
| shop | failures | 0.06 | 0.457 | 3.4 |
| shop | minimal | 0.04 | 0.249 | 4.2 |

## One-off and idle

Image build: 3.73 min, $0.0224. AI: 132 calls, $0.0341 (ollama-cloud:deepseek-v4.1-flash).

Idle monthly cost: **$0.0740**.

- Artifact Registry: the runner image: $0.0740 (1.24 GiB, first 0.5 GiB-month free; down.sh deletes it)
- Secret Manager: the API key: $0.0000 (1 active version(s), 6 free)
- Cloud Run Job: $0.0000 (a job costs nothing between executions)
- Cloud Storage bucket: $0.0000 (evidence deleted after 7 days by the lifecycle rule; an empty bucket is free)
- Neon, WorkOS: $0.0000 (free tiers at this scale; not used by the runner)

Cloud Run's free tier (240,000 vCPU-s and 450,000 GiB-s a month) and Cloud Build's 2,500 free build-minutes would cover this whole run; the numbers above are before free tiers.

Run total: compute $0.1071, storage $0.017309, AI $0.0341, build $0.0224, Android VM $0.0000: **$0.1809**.
