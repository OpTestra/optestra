#!/usr/bin/env bash
# Runs the cost run's executions (plan.json, or EXECUTIONS=name,name), waits for
# each, records gcloud's task times in cloud.json, downloads the results and
# writes the report with `bench --meter` (bench/results/<date>-cloud-baseline.*).
#   COST_RUN=… PROJECT_ID=… bench/cloud/run.sh
#   CLOUD_TARGET=local COST_RUN=… bench/cloud/run.sh   (the entry runs here; same JSON)
. "$(dirname "$0")/common.sh"
require_gcloud
mkdir -p "$RUN_OUT/results"
EXECUTIONS="${EXECUTIONS:-}"
REPORT_OUT="${REPORT_OUT:-$REPO/bench/results}"

# name<TAB>slices-json<TAB>tasks<TAB>parallel<TAB>cpu<TAB>memoryGiB<TAB>ai, one line per execution
plan_lines() {
  node -e '
    const plan = require(process.argv[1]);
    const pick = (process.argv[2] || "").split(",").filter(Boolean);
    for (const e of plan.executions)
      if (!pick.length || pick.includes(e.name))
        console.log([e.name, JSON.stringify(e.slices), e.tasks, e.parallel, e.cpu, e.memoryGiB, e.ai ? 1 : 0].join("\t"));
  ' "$CLOUD_DIR/plan.json" "$EXECUTIONS"
}

record_tasks() { # execution-name
  if [ "$CLOUD_TARGET" = "local" ] || [ -n "$DRY_RUN" ]; then return 0; fi
  gcloud --project "$PROJECT_ID" run jobs executions tasks list --execution "$1" --region "$REGION" --format json |
    node -e '
      const fs = require("fs"); const [file, execution] = process.argv.slice(1);
      const tasks = JSON.parse(fs.readFileSync(0, "utf8"));
      const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      all.tasks = (all.tasks || []).filter((t) => t.execution !== execution);
      for (const t of tasks)
        all.tasks.push({
          execution,
          index: Number(t.spec?.index ?? t.status?.index ?? t.metadata?.annotations?.["run.googleapis.com/task-index"] ?? 0),
          createTime: t.metadata?.creationTimestamp ?? t.createTime ?? null,
          startTime: t.status?.startTime ?? t.startTime ?? null,
        });
      fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
    ' "$RUN_OUT/cloud.json" "$1"
}

shape_now=""
# REPORT_ONLY=1: no executions, only the download and the report.
[ -n "${REPORT_ONLY:-}" ] && EXECUTIONS="-none-"
while IFS=$'\t' read -r name slices tasks parallel cpu memory ai; do
  model=""
  if [ "$ai" = "1" ]; then
    if [ "$AI_MODE" = "api" ]; then model="$MODEL";
    elif [[ "$name" == author* ]]; then say "skip $name (AI_MODE=local: author on this Mac, see RUNBOOK)"; continue;
    fi
  fi
  say "── $name: $tasks task(s), $cpu vCPU / $memory GiB, $parallel at a time${model:+, model $model}"
  if [ "$CLOUD_TARGET" = "local" ]; then
    # The local stand-in: the image's entry, once per task, on this machine.
    for ((i = 0; i < tasks; i++)); do
      env COST_RUN="$COST_RUN" EXECUTION="$name" SLICES="$slices" PARALLEL="$parallel" OUT="$OUT" \
        SHAPE_VCPU="$cpu" SHAPE_MEMORY_GIB="$memory" TASK_INDEX="$i" TASK_COUNT="$tasks" \
        ${model:+MODEL="$model"} ${SCRIPTED:+SCRIPTED="$SCRIPTED"} ${RECORDINGS:+RECORDINGS="$RECORDINGS"} \
        node "$CLOUD_DIR/entry.ts" | grep -E '^\{"costRun' || { say "task $i failed"; exit 1; }
    done
    continue
  fi
  if [ "$shape_now" != "$cpu/$memory" ]; then
    gc run jobs update "$JOB" --region "$REGION" --cpu "$cpu" --memory "${memory}Gi"
    shape_now="$cpu/$memory"
  fi
  vars="^##^SLICES=$slices##PARALLEL=$parallel##SHAPE_VCPU=$cpu##SHAPE_MEMORY_GIB=$memory"
  [ -n "$model" ] && vars="$vars##MODEL=$model"
  [ -n "${RECORDINGS:-}" ] && vars="$vars##RECORDINGS=$RECORDINGS"
  if [ -n "$DRY_RUN" ]; then
    gc run jobs execute "$JOB" --region "$REGION" --tasks "$tasks" --wait --update-env-vars "$vars"
    continue
  fi
  execution="$(gcloud --project "$PROJECT_ID" --quiet run jobs execute "$JOB" --region "$REGION" \
    --tasks "$tasks" --wait --update-env-vars "$vars" --format 'value(metadata.name)')"
  say "  execution $execution done"
  record_tasks "$execution"
done < <(plan_lines)

if [ "$CLOUD_TARGET" = "gcp" ] && [ -z "$DRY_RUN" ]; then
  say "Downloading results (evidence stays in the bucket until down.sh)"
  gcloud --project "$PROJECT_ID" storage cp -r "gs://$BUCKET/cost-runs/$COST_RUN/results" "$RUN_OUT/"
  node -e '
    const fs = require("fs"); const [file, image] = process.argv.slice(1);
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    if (image) all.imageGiB = Math.round(Number(image) / 1024 ** 3 * 100) / 100;
    if (process.env.AI_MODE === "api") all.secretVersions = 1;
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  ' "$RUN_OUT/cloud.json" \
    "$(gcloud --project "$PROJECT_ID" artifacts docker images describe "$IMAGE" --format 'value(image_summary.size_bytes)' 2>/dev/null || true)"
fi
[ -n "$DRY_RUN" ] && exit 0

say "Report"
node "$REPO/packages/cli/bin/cli.js" bench --meter "$RUN_OUT" --out "$REPORT_OUT"
