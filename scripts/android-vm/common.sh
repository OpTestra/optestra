# Shared settings for the Android VM scripts. Sourced, not run.
#
# Everything comes from the environment, or from scripts/android-vm/.env
# (git-ignored; copy .env.example). Nothing here names a project or an account.

set -euo pipefail

VM_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$VM_SCRIPTS/../.." && pwd)"
# ANDROID_VM_ENV_FILE: settings kept outside the repo (default scripts/android-vm/.env).
ENV_FILE="${ANDROID_VM_ENV_FILE:-$VM_SCRIPTS/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

: "${ANDROID_VM_PROJECT:?set ANDROID_VM_PROJECT to the Google Cloud project ID (env or scripts/android-vm/.env)}"
ANDROID_VM_ZONE="${ANDROID_VM_ZONE:-us-east4-a}"
ANDROID_VM_NAME="${ANDROID_VM_NAME:-android-vm}"
ANDROID_VM_MACHINE="${ANDROID_VM_MACHINE:-n2-standard-4}"
# Hard cap: the VM (and its disk) is deleted when it runs out, whatever happens here.
ANDROID_VM_MAX_RUN="${ANDROID_VM_MAX_RUN:-3h}"
ANDROID_VM_DISK_GB="${ANDROID_VM_DISK_GB:-30}"
# A reusable image made by image.sh: boot from it and skip setup.sh.
ANDROID_VM_IMAGE="${ANDROID_VM_IMAGE:-}"
ANDROID_VM_IMAGE_FAMILY="${ANDROID_VM_IMAGE_FAMILY:-android-vm}"
ANDROID_VM_LANE="${ANDROID_VM_LANE:-mob}"
ANDROID_VM_COST_RUN="${ANDROID_VM_COST_RUN:-}"
# The spot price of the machine type, for the cost line in the JSON (optional).
ANDROID_VM_HOURLY_USD="${ANDROID_VM_HOURLY_USD:-}"
ANDROID_VM_OUT="${ANDROID_VM_OUT:-$REPO/android-vm-results}"
mkdir -p "$ANDROID_VM_OUT"
export ANDROID_VM_ZONE ANDROID_VM_MACHINE ANDROID_VM_MAX_RUN ANDROID_VM_DISK_GB ANDROID_VM_IMAGE ANDROID_VM_HOURLY_USD

# The brand's slug and env prefix, from the brand package (never a literal here).
BRAND_SLUG="$(node -p "require('$REPO/packages/brand/brand.json').productName.toLowerCase()")"
ENV_PREFIX="$(node -p "require('$REPO/packages/brand/brand.json').productName.toUpperCase()")_"

LABELS="app=$BRAND_SLUG,lane=$ANDROID_VM_LANE${ANDROID_VM_COST_RUN:+,cost-run=$ANDROID_VM_COST_RUN}"
GCLOUD=(gcloud --project "$ANDROID_VM_PROJECT" --quiet)
PHASES="$ANDROID_VM_OUT/phases.json"

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

# phase <name> <value>: records a number (or null) in phases.json.
phase() {
  node -e '
    const fs = require("fs");
    const [file, name, value] = process.argv.slice(1);
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    all[name] = value === "null" ? null : Number(value);
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  ' "$PHASES" "$1" "$2"
}

on_vm() {
  "${GCLOUD[@]}" compute ssh "$ANDROID_VM_NAME" --zone "$ANDROID_VM_ZONE" --command "$1"
}

to_vm() {
  "${GCLOUD[@]}" compute scp --zone "$ANDROID_VM_ZONE" "$@"
}

# The working tree (tracked and untracked, not ignored), so local changes run on the VM.
push_tree() {
  local tar="$ANDROID_VM_OUT/tree.tgz"
  (cd "$REPO" && git ls-files -co --exclude-standard -z | COPYFILE_DISABLE=1 tar --no-xattrs --null -T - -czf "$tar")
  to_vm "$tar" "$ANDROID_VM_NAME:tree.tgz"
  on_vm 'mkdir -p ~/engine && tar -xzf ~/tree.tgz -C ~/engine && rm ~/tree.tgz'
}

# The engine's own env (prefix from the brand), passed on to the VM's commands.
forwarded_env() {
  env | grep "^$ENV_PREFIX" | sed "s/'/'\\\\''/g; s/=\(.*\)/='\1'/" | tr '\n' ' ' || true
}

# After a failed ssh: was the spot VM preempted (Google deletes it then)?
# The status lags the lost connection by up to a minute, so look a few times.
preempted() {
  local status
  for _ in 1 2 3 4 5 6; do
    status=$("${GCLOUD[@]}" compute instances describe "$ANDROID_VM_NAME" --zone "$ANDROID_VM_ZONE" \
      --format 'value(status)' 2> /dev/null || echo GONE)
    [ "$status" != "RUNNING" ] && return 0
    on_vm true > /dev/null 2>&1 && return 1
    sleep 10
  done
  return 1
}
