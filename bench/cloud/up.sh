#!/usr/bin/env bash
# Creates what a cost run needs, idempotently (each step checks first):
# APIs, the Artifact Registry repo, the bucket (lifecycle: delete after
# RETENTION_DAYS, no soft delete), a key-less service account, the API-key
# secret for AI_MODE=api (you add its value), the image (Cloud Build) and the
# Cloud Run Job. Every resource is labelled app/lane/cost-run.
#   COST_RUN=… PROJECT_ID=… bench/cloud/up.sh          (DRY_RUN=1 to print only)
#   CLOUD_TARGET=local COST_RUN=… bench/cloud/up.sh    (the local stand-in)
. "$(dirname "$0")/common.sh"
require_gcloud
mkdir -p "$RUN_OUT/results"

if [ "$CLOUD_TARGET" = "local" ]; then
  say "Local stand-in: these are the gcloud commands up.sh runs in the cloud; locally it only builds."
fi

say "1/7 APIs"
gc services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com storage.googleapis.com iam.googleapis.com

say "2/7 Artifact Registry repo $AR_REPO"
if ! exists artifacts repositories describe "$AR_REPO" --location "$REGION"; then
  gc artifacts repositories create "$AR_REPO" --repository-format docker --location "$REGION" \
    --description "Cost-run runner images" --labels "$LABELS"
fi

say "3/7 Bucket gs://$BUCKET"
if ! exists storage buckets describe "gs://$BUCKET"; then
  gc storage buckets create "gs://$BUCKET" --location "$REGION" --default-storage-class STANDARD \
    --uniform-bucket-level-access --public-access-prevention --soft-delete-duration 0
fi
lifecycle="$(mktemp)"
printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":%s}}]}\n' "$RETENTION_DAYS" > "$lifecycle"
gc storage buckets update "gs://$BUCKET" --update-labels "$LABELS" --lifecycle-file "$lifecycle"
rm -f "$lifecycle"

say "4/7 Service account $SERVICE_ACCOUNT (no keys: it is attached to the job)"
if ! exists iam service-accounts describe "$SERVICE_ACCOUNT"; then
  gc iam service-accounts create "$SERVICE_ACCOUNT_NAME" --display-name "Cost-run tasks"
fi
gc storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member "serviceAccount:$SERVICE_ACCOUNT" --role roles/storage.objectUser
gc projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:$SERVICE_ACCOUNT" --role roles/logging.logWriter --condition None

secret_flags=()
if [ "$AI_MODE" = "api" ]; then
  say "5/7 Secret $SECRET (option a: the ${MODEL%%:*} API key, mounted as $AI_KEY_ENV)"
  if ! exists secrets describe "$SECRET"; then
    gc secrets create "$SECRET" --replication-policy user-managed --locations "$REGION" --labels "$LABELS"
  fi
  gc secrets add-iam-policy-binding "$SECRET" \
    --member "serviceAccount:$SERVICE_ACCOUNT" --role roles/secretmanager.secretAccessor
  if [ "$CLOUD_TARGET" = "gcp" ] && [ -z "$DRY_RUN" ] &&
    [ -z "$(gcloud --project "$PROJECT_ID" secrets versions list "$SECRET" --filter state=enabled --format 'value(name)' 2>/dev/null)" ]; then
    say "The secret has no value yet. Add the key yourself in your own terminal (read -s: not echoed, not in history):"
    say "  read -rs KEY && printf '%s' \"\$KEY\" | gcloud --project $PROJECT_ID secrets versions add $SECRET --data-file=- ; unset KEY"
    say "then run up.sh again."
    exit 2
  fi
  secret_flags=(--set-secrets "$AI_KEY_ENV=$SECRET:latest")
else
  say "5/7 Secret: skipped (AI_MODE=$AI_MODE: authoring runs on this Mac)"
fi

say "6/7 Image $IMAGE"
# Cloud Build's own service account pushes the image: newer projects don't give it
# that right by default, so grant it on this one repo (and log writing).
if [ "$CLOUD_TARGET" = "gcp" ]; then
  build_sa=""
  if [ -z "$DRY_RUN" ]; then
    build_sa="$(gcloud --project "$PROJECT_ID" builds get-default-service-account --format 'value(serviceAccountEmail)' 2>/dev/null |
      sed 's#^projects/[^/]*/serviceAccounts/##')"
  fi
  build_sa="${build_sa:-<the Cloud Build service account>}"
  gc artifacts repositories add-iam-policy-binding "$AR_REPO" --location "$REGION" \
    --member "serviceAccount:$build_sa" --role roles/artifactregistry.writer
  gc projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:$build_sa" --role roles/logging.logWriter --condition None
fi
started=$(now_ms)
if [ "$CLOUD_TARGET" = "local" ]; then
  (cd "$REPO" && pnpm build > /dev/null)
  say "  local: built the workspace (the image's 'pnpm build')"
elif exists artifacts docker images describe "$IMAGE"; then
  say "  already built"
  started=""
else
  gc builds submit "$REPO" --region "$REGION" --config "$CLOUD_DIR/cloudbuild.yaml" \
    --ignore-file "$CLOUD_DIR/.gcloudignore" --substitutions "_IMAGE=$IMAGE"
fi
if [ -n "$started" ] && [ -z "$DRY_RUN" ] && [ "$CLOUD_TARGET" = "gcp" ]; then
  node -e '
    const fs = require("fs"); const [file, ms] = process.argv.slice(1);
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    all.buildMinutes = Math.round(Number(ms) / 600) / 100;
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  ' "$RUN_OUT/cloud.json" "$(($(now_ms) - started))"
fi

say "7/7 Cloud Run Job $JOB"
gc run jobs deploy "$JOB" --image "$IMAGE" --region "$REGION" \
  --cpu "$CPU" --memory "${MEMORY_GIB}Gi" --tasks "$TASKS" --max-retries 0 --task-timeout "$TASK_TIMEOUT" \
  --service-account "$SERVICE_ACCOUNT" --labels "$LABELS" \
  --add-volume "name=evidence,type=cloud-storage,bucket=$BUCKET" \
  --add-volume-mount "volume=evidence,mount-path=/mnt/evidence" \
  --set-env-vars "COST_RUN=$COST_RUN,REGION=$REGION" ${secret_flags[@]+"${secret_flags[@]}"}

say "Up. Next: bench/cloud/run.sh; when done: bench/cloud/down.sh"
