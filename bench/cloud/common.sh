# Shared settings for the cost-run scripts (COST-0). Sourced, not run.
#
# Everything comes from the environment or from bench/cloud/.env (git-ignored;
# copy .env.example). Nothing here names a project, an account or a key.
#
#   CLOUD_TARGET=gcp     (default) Google Cloud through gcloud
#   CLOUD_TARGET=local   the local stand-in: same scripts, the task's entry runs
#                        on this machine, nothing is created anywhere
#   DRY_RUN=1            print every gcloud command instead of running it

set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$CLOUD_DIR/../.." && pwd)"
if [ -f "$CLOUD_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$CLOUD_DIR/.env"
  set +a
fi

CLOUD_TARGET="${CLOUD_TARGET:-gcp}"
DRY_RUN="${DRY_RUN:-}"
REGION="${REGION:-us-east4}"
# The cost run: one id per baseline, a label value (lowercase, digits, dashes).
COST_RUN="${COST_RUN:-}"
LANE="${LANE:-engine-core}"
# Shape of one task (billing is on allocation) and tests in parallel inside it.
CPU="${CPU:-2}"
MEMORY_GIB="${MEMORY_GIB:-4}"
PARALLEL="${PARALLEL:-1}"
TASKS="${TASKS:-1}"
TASK_TIMEOUT="${TASK_TIMEOUT:-45m}"
# AI in the cloud: api = an Anthropic key in Secret Manager (option a);
# local = author on this Mac with the subscription, ship recordings (option b).
AI_MODE="${AI_MODE:-local}"
MODEL="${MODEL:-anthropic:claude-sonnet-5-5}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

# The brand's slug, from the brand package (never a literal here).
BRAND_SLUG="$(node -p "require('$REPO/packages/brand/brand.json').productName.toLowerCase()")"

if [ -z "$COST_RUN" ]; then
  echo "Set COST_RUN (e.g. COST_RUN=baseline-$(date +%Y%m%d)) in the environment or bench/cloud/.env." >&2
  exit 2
fi
if ! [[ "$COST_RUN" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]]; then
  echo "COST_RUN must be lowercase letters, digits and dashes (it is a label value and part of names)." >&2
  exit 2
fi

LABELS="app=$BRAND_SLUG,lane=$LANE,cost-run=$COST_RUN"
# Resource names: one set per cost run, so down.sh removes exactly these.
AR_REPO="${AR_REPO:-$BRAND_SLUG-cost}"
IMAGE_NAME="${IMAGE_NAME:-bench-runner}"
JOB="${JOB:-cost-$COST_RUN}"
SERVICE_ACCOUNT_NAME="${SERVICE_ACCOUNT_NAME:-cost-runner}"
# The API key the model's provider reads (option a), and the secret holding it.
case "${MODEL%%:*}" in
  ollama-cloud) AI_KEY_ENV=OLLAMA_API_KEY; key_name=ollama ;;
  openrouter) AI_KEY_ENV=OPENROUTER_API_KEY; key_name=openrouter ;;
  *) AI_KEY_ENV=ANTHROPIC_API_KEY; key_name=anthropic ;;
esac
SECRET="${SECRET:-$BRAND_SLUG-$key_name-api-key}"
OUT="${OUT:-$CLOUD_DIR/out}"
RUN_OUT="$OUT/cost-runs/$COST_RUN"

if [ "$CLOUD_TARGET" = "gcp" ]; then
  PROJECT_ID="${PROJECT_ID:-<PROJECT_ID>}"
  BUCKET="${BUCKET:-$PROJECT_ID-$BRAND_SLUG-cost-runs}"
  IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/$IMAGE_NAME:$COST_RUN"
  SERVICE_ACCOUNT="$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com"
else
  PROJECT_ID="${PROJECT_ID:-local-stand-in}"
  BUCKET="local"
  IMAGE="local/$IMAGE_NAME:$COST_RUN"
  SERVICE_ACCOUNT="local"
fi

say() { printf '%s\n' "$*" >&2; }

# gc <args…>: gcloud for this project, quietly; printed instead under DRY_RUN or the local stand-in.
gc() {
  if [ -n "$DRY_RUN" ] || [ "$CLOUD_TARGET" = "local" ]; then
    printf '  gcloud --project %s' "$PROJECT_ID" >&2
    printf ' %q' "$@" >&2
    printf '\n' >&2
    return 0
  fi
  gcloud --project "$PROJECT_ID" --quiet "$@"
}

# exists <describe args…>: true when gcloud can describe it (always false when printing).
exists() {
  if [ -n "$DRY_RUN" ] || [ "$CLOUD_TARGET" = "local" ]; then return 1; fi
  gcloud --project "$PROJECT_ID" --quiet "$@" > /dev/null 2>&1
}

require_gcloud() {
  if [ "$CLOUD_TARGET" = "gcp" ] && [ "$PROJECT_ID" = "<PROJECT_ID>" ]; then
    say "Set PROJECT_ID to the Google Cloud project ID (env or bench/cloud/.env)."
    exit 2
  fi
  if [ "$CLOUD_TARGET" = "gcp" ] && [ -z "$DRY_RUN" ] && ! command -v gcloud > /dev/null; then
    say "gcloud isn't installed. Install the Google Cloud CLI, then run: gcloud auth login && gcloud auth application-default login"
    exit 2
  fi
}

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
