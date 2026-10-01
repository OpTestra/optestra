#!/usr/bin/env bash
# Tears the cost run down, idempotently: the Cloud Run Job, the Artifact Registry
# repo (and its images), the bucket (after run.sh downloaded the results), the
# secret and the service account. APIs stay enabled (free). Prints what's left.
#   COST_RUN=… PROJECT_ID=… bench/cloud/down.sh     (KEEP_BUCKET=1 / KEEP_SECRET=1 to keep those)
. "$(dirname "$0")/common.sh"
require_gcloud

say "Cloud Run Job $JOB"
if exists run jobs describe "$JOB" --region "$REGION" || [ "$CLOUD_TARGET" = "local" ] || [ -n "$DRY_RUN" ]; then
  gc run jobs delete "$JOB" --region "$REGION"
fi
say "Artifact Registry repo $AR_REPO"
if exists artifacts repositories describe "$AR_REPO" --location "$REGION" || [ "$CLOUD_TARGET" = "local" ] || [ -n "$DRY_RUN" ]; then
  gc artifacts repositories delete "$AR_REPO" --location "$REGION"
fi
if [ -z "${KEEP_BUCKET:-}" ]; then
  say "Bucket gs://$BUCKET"
  if exists storage buckets describe "gs://$BUCKET" || [ "$CLOUD_TARGET" = "local" ] || [ -n "$DRY_RUN" ]; then
    gc storage rm --recursive "gs://$BUCKET"
  fi
fi
if [ -z "${KEEP_SECRET:-}" ]; then
  say "Secret $SECRET"
  if exists secrets describe "$SECRET" || [ "$CLOUD_TARGET" = "local" ] || [ -n "$DRY_RUN" ]; then
    gc secrets delete "$SECRET"
  fi
fi
say "Service account $SERVICE_ACCOUNT"
if exists iam service-accounts describe "$SERVICE_ACCOUNT" || [ "$CLOUD_TARGET" = "local" ] || [ -n "$DRY_RUN" ]; then
  gc projects remove-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:$SERVICE_ACCOUNT" --role roles/logging.logWriter --condition None || true
  gc iam service-accounts delete "$SERVICE_ACCOUNT"
fi

if [ "$CLOUD_TARGET" = "gcp" ] && [ -z "$DRY_RUN" ]; then
  say "Still labelled cost-run=$COST_RUN (should be empty, apart from the Android VM until its own delete):"
  gcloud --project "$PROJECT_ID" asset search-all-resources --query "labels.cost-run=$COST_RUN" \
    --format 'table(assetType,name)' 2>/dev/null || say "  (Cloud Asset API not enabled: check the console's labels view)"
fi
say "Down. The results stay in $RUN_OUT."
