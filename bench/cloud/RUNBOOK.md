# Cloud cost baseline: the run (2026-10-02)

The exact order, with the expected calls, $ and time. Nothing here runs until
the user approves the estimate (MODEL RULE: ask with a call estimate first,
report the real numbers after, never retry a real-model run).

Estimates come from `bench --corpus` (EVAL-0's Sonnet 5.5 numbers per test) and
`plan.sh` (prices checked 2026-10-01). Times are wall clock on this Mac and in
us-east4.

## 0. Before you start (the user)

1. Install the Google Cloud CLI, then `gcloud auth login` and
   `gcloud auth application-default login`. Nobody else enters credentials.
2. `cp bench/cloud/.env.example bench/cloud/.env`, set `PROJECT_ID` (the
   "Optestra" project's ID) and `COST_RUN=baseline-20261002`.
3. Turn on the BigQuery billing export (today) so tomorrow's costs can be
   checked against the meter (`reconcile.md`). Data shows up within a day.
4. Pick the AI setup:
   - **(b) subscription** (`AI_MODE=local`, default): Claude Code signed in on this Mac.
     Corpus authoring runs here and the cloud only replays and heals.
   - **(a) API key** (`AI_MODE=api`): create an Anthropic API key. After `up.sh`
     creates the secret, add the key yourself:
     `gcloud --project $PROJECT_ID secrets versions add <brand slug>-anthropic-api-key --data-file=-`
     (it reads the key from your terminal).
5. Android: MOB-3's VM scripts (`scripts/android-vm/`, on `mob-3` until merged).
   Set `ANDROID_VM_SCRIPTS` to their folder, and accept the Android SDK licence
   when their `setup.sh` asks (`ANDROID_VM_ACCEPT_SDK_LICENSES=yes`).
6. Pick the corpus tier (below) and approve its calls and $.

```bash
pnpm install && pnpm build
bench/cloud/plan.sh            # prints every resource and the expected $
```

## 1. The corpus on Sonnet 5.5 (this Mac)

One command per tier. Each style runs once. Results are saved after every style
(`bench/results/<date>-corpus-models.json`).

| Tier | What | AI calls | AI $ (list) | Time |
|---|---|---|---|---|
| **Full** | all 8 styles × 11 shop tests (both routes) + Android tidy/terse/sloppy × 4 tests | ≈ 1,409 | ≈ $7.90 | ≈ 2 h |
| **Recommended** | all 8 styles × 4 shop tests (login, create-project, settings-profile, checkout-trial) + Android × 2 (sign-in, create-project) | ≈ 532 | ≈ $2.96 | ≈ 50 min |
| **Minimal** (near EVAL-0's scale) | 6 styles (tidy, terse, acceptance, spoken, sloppy, mixed) × 3 shop tests (login, create-project, checkout-trial) + Android × 2 | ≈ 325 | ≈ $1.74 | ≈ 35 min |

EVAL-0 used ~205 calls (~$1.06) for 11 web tests. The prose styles' file
route costs nothing: lint rejects text with no numbered steps before any AI call.

```bash
# Full
node packages/cli/bin/cli.js bench --corpus --fixture all --models claude-code:claude-sonnet-5-5 --yes
# Recommended
node packages/cli/bin/cli.js bench --corpus --fixture all --test login --test create-project --test settings-profile --test checkout-trial --test sign-in --models claude-code:claude-sonnet-5-5 --yes
# Minimal
node packages/cli/bin/cli.js bench --corpus --fixture all --test login --test create-project --test checkout-trial --test sign-in --style tidy --style terse --style acceptance --style spoken --style sloppy --style mixed --models claude-code:claude-sonnet-5-5 --yes
```

With option (a), use `--models anthropic:claude-sonnet-5-5` (and
`ANTHROPIC_API_KEY` in the shell, from your own key). The calls and $ are the
same; the $ is then real, not covered by the subscription.

The Android part needs the emulator and the fixture APKs on this Mac
(`pnpm --filter @optestra/fixture-android build:apks` with JAVA_HOME set to a
JDK 21). Without them, the command skips Android with one line and the shop
part still runs. Running without `--yes` prints the estimate again and stops.

## 2. Up, then 10 replays on correct (Google Cloud)

```bash
bench/cloud/up.sh     # ≈ 15 min: APIs, registry, bucket, service account, (secret), Cloud Build ≈ 12 min, job
EXECUTIONS=replay-correct-p1,replay-correct-p4,replay-correct-small,replay-variants,evidence-modes bench/cloud/run.sh
```

| Execution | Tasks × shape | What it measures | ≈ Time | ≈ $ |
|---|---|---|---|---|
| replay-correct-p1 | 1 × 2 vCPU / 4 GiB, 1 at a time | 10 replays of correct (110 test runs), container start | 4 min | $0.011 |
| replay-correct-p4 | 1 × 2 vCPU / 4 GiB, 4 at a time | the same, 4 in parallel | 2 min | $0.005 |
| replay-correct-small | 1 × 1 vCPU / 2 GiB | the cheapest shape | 3 min | $0.004 |
| replay-variants | 1 × 2 vCPU / 4 GiB | every variant once: failing tests' evidence | 4 min | $0.011 |
| evidence-modes | 2 × 2 vCPU / 4 GiB | full vs minimal evidence | 2 min | $0.011 |

AI: 0 calls (replay uses none; any call on correct is a bug the report shows).

## 3. One cosmetic heal pass

```bash
EXECUTIONS=heal-cosmetic bench/cloud/run.sh                 # option (b): no-AI heals only
AI_MODE=api EXECUTIONS=heal-cosmetic,author-gold bench/cloud/run.sh   # option (a): the fixer in the cloud, + authoring there
```

- (b): 0 AI calls in the cloud. The AI heals' cost comes from step 1's cosmetic passes.
- (a): heal ≈ 4 calls, $0.02; author-gold ≈ 108 calls, $0.51, 8 min.
- Cloud: ≈ $0.008 (heal), ≈ $0.021 (author).

## 4. The Android slice on MOB-3's VM

```bash
bench/cloud/android.sh
```

This creates the VM: n2-standard-4 spot, nested virtualization, 30 GiB
pd-balanced, labelled with this cost run, deleted by Google after 3 h at the
latest. It then sets the VM up, replays the Android gold tests (correct ×3, and
every variant once) and deletes the VM.
- AI: 0 calls on the VM; Android authoring is in step 1.
- Time: ≈ 1.5–2 h, mostly the one-time setup (SDK, AVD, snapshot) unless
  MOB-3's image is used (`ANDROID_VM_IMAGE`).
- Cost: ≈ $0.06/h with its disk, ≈ $0.12 for 2 h.

## 5. Report and teardown

```bash
REPORT_ONLY=1 bench/cloud/run.sh   # downloads every task's result and writes the report
# or: node packages/cli/bin/cli.js bench --meter bench/cloud/out/cost-runs/$COST_RUN
bench/cloud/down.sh  # job, registry, bucket, secret, service account; lists anything still labelled
```

Commit `bench/results/<date>-cloud-baseline.json` and `.md`, and the corpus
results. They replace the estimates in PRODUCT-FACTS.md sections 5–8.

## The whole day

| | AI calls | AI $ | Cloud $ | Time |
|---|---|---|---|---|
| Full corpus + cloud (b) | ≈ 1,409 | ≈ $7.90 | ≈ $0.27 | ≈ 5 h |
| Recommended + cloud (b) | ≈ 532 | ≈ $2.96 | ≈ $0.27 | ≈ 3.5 h |
| Minimal + cloud (b) | ≈ 325 | ≈ $1.74 | ≈ $0.27 | ≈ 3 h |
| … with option (a) in the cloud | + ≈ 112 | + ≈ $0.53 | ≈ $0.29 in all | + 10 min |

The cloud $ is list price before free tiers. Cloud Run's free tier (240,000
vCPU-s a month) and Cloud Build's 2,500 free minutes would cover all of it, so
the bill itself should show close to $0 for Cloud Run and Cloud Build. The
meter reports list prices so the numbers carry over to a paid scale.

## If something goes wrong

- **The build can't push**: up.sh grants the Cloud Build service account
  `artifactregistry.writer` on the repo. If your organisation's policy blocks
  that, grant it in the console and run up.sh again (it skips what exists).
- **A task fails**: run.sh stops and tells you which. Fix, then run only what's
  left (`EXECUTIONS=…`). Never re-run a real-model step to get a better number.
- **Anything left running**: down.sh is safe to run again. The VM deletes
  itself at its time limit.

## What the 2026-10-03 run taught (baseline-20261003)

- **Ollama Cloud, not Sonnet**: the run used `ollama-cloud:deepseek-v4.1-flash` for
  everything (EVAL-1's winner); `AI_MODE=api` mounts `OLLAMA_API_KEY` from
  `<slug>-ollama-api-key` (common.sh picks the variable and secret from the model's provider).
- **The image** needed three fixes found by the first builds: no `xz` in the
  Playwright base (Node's `.tar.gz`), `/app` owned by root (chowned before
  `USER`), pnpm's corepack folder created first.
- **Evidence on the bucket mount**: Cloud Storage FUSE refuses chmod/utimes, so
  `fs.cpSync` failed with EPERM after all the tests had run and the measurement
  was lost. Evidence is now copied as bytes and a failed upload is recorded.
- **Parallel lanes**: 4 lanes on one task gave 1 flaky test in 110 on both
  sizes; the cheapest shape that kept every verdict was 1 vCPU / 2 GiB, one
  test at a time.
- **Android over ssh**: `gcloud compute scp` and `ssh` return transient 502s,
  and a dropped ssh kills the remote command's output pipe (`tee`), so a long
  `run.sh` replay can finish without its JSON. Long commands now run detached on
  the VM (`nohup`, a done marker, polled), copies retry, and a real-AI command
  is never re-run. (For MOB-3's `run.sh`: the same change there.)
- **A VM from the image replayed slower** than the cold VM that made it (the
  disk restored from an image loads lazily on first read). Measure a second run
  on the same VM before pricing image-based Android runs.
- **The 3-hour cap** (`--max-run-duration`) is per VM: put a long slice (the
  Android corpus) on its own VM rather than after a replay.
