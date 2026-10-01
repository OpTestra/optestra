#!/usr/bin/env bash
# The Android slice of a cost run (COST-0), on MOB-3's spot VM. This script
# only calls MOB-3's scripts (scripts/android-vm/ on their branch until it is
# merged) and folds their numbers into this cost run; it never edits them.
#
#   ANDROID_VM_SCRIPTS   the folder with MOB-3's scripts (default: scripts/android-vm here)
#   ANDROID_VM_RUN       their script that runs a command on the VM in the repo copy
#                        (default: $ANDROID_VM_SCRIPTS/run.sh; see "Interface" below)
#   ANDROID_VM_PROJECT   as MOB-3's scripts read it (defaults to PROJECT_ID)
#   ANDROID_STYLES       corpus styles for the slice (default tidy,terse,spoken,sloppy)
#
# Interface this needs from MOB-3 (agreed through the architect):
#   create.sh, setup.sh, delete.sh   create / set up / delete the VM; phases.json in $ANDROID_VM_OUT
#   run.sh "<command>"               runs <command> in the repository copy on the VM, with the
#                                    emulator ready, and copies $ANDROID_VM_OUT back afterwards
# The VM gets ANDROID_VM_COST_RUN=$COST_RUN, so it carries the cost-run label.
. "$(dirname "$0")/common.sh"

ANDROID_VM_SCRIPTS="${ANDROID_VM_SCRIPTS:-$REPO/scripts/android-vm}"
ANDROID_VM_RUN="${ANDROID_VM_RUN:-$ANDROID_VM_SCRIPTS/run.sh}"
ANDROID_STYLES="${ANDROID_STYLES:-tidy,terse,spoken,sloppy}"
export ANDROID_VM_PROJECT="${ANDROID_VM_PROJECT:-$PROJECT_ID}"
export ANDROID_VM_COST_RUN="$COST_RUN"
export ANDROID_VM_LANE="$LANE"
export ANDROID_VM_OUT="${ANDROID_VM_OUT:-$RUN_OUT/android-vm}"
mkdir -p "$ANDROID_VM_OUT" "$RUN_OUT/results"

for script in create.sh setup.sh delete.sh; do
  if [ ! -f "$ANDROID_VM_SCRIPTS/$script" ] && [ "$CLOUD_TARGET" = "gcp" ]; then
    say "MOB-3's $script isn't in $ANDROID_VM_SCRIPTS (set ANDROID_VM_SCRIPTS to their checkout)."
    exit 2
  fi
done

# The slice on the VM: the replay of the gold tests (no AI), then each style's
# authoring needs a model, so with AI_MODE=local the VM only replays.
slices='[{"fixture":"android","phase":"replay","variants":["correct"],"reruns":3,"evidence":"failures"},{"fixture":"android","phase":"replay","evidence":"failures"}]'
command="cd ~/repo && for i in 0 1; do env ANDROID_VM=1 SHAPE_VCPU=4 SHAPE_MEMORY_GIB=16 COST_RUN=$COST_RUN SLICES='$slices' TASK_INDEX=\$i TASK_COUNT=2 OUT=\$HOME/android-out node bench/cloud/entry.ts; done && cp -r \$HOME/android-out/cost-runs/$COST_RUN/results/. $ANDROID_VM_OUT/ 2>/dev/null || true"

if [ "$CLOUD_TARGET" = "local" ] || [ -n "$DRY_RUN" ]; then
  say "Would run, in order:"
  say "  ANDROID_VM_COST_RUN=$COST_RUN $ANDROID_VM_SCRIPTS/create.sh"
  say "  ANDROID_VM_ACCEPT_SDK_LICENSES=yes $ANDROID_VM_SCRIPTS/setup.sh   (you accept the SDK licence)"
  say "  $ANDROID_VM_RUN \"$command\""
  say "  $ANDROID_VM_SCRIPTS/delete.sh"
  say "Corpus styles for the Android slice (authored on this Mac with AI_MODE=local): $ANDROID_STYLES"
  exit 0
fi

trap '"$ANDROID_VM_SCRIPTS/delete.sh" || say "delete.sh failed: check the VM (it is deleted at its time limit anyway)"' EXIT
"$ANDROID_VM_SCRIPTS/create.sh"
"$ANDROID_VM_SCRIPTS/setup.sh"
"$ANDROID_VM_RUN" "$command"

# Fold the VM's own times into the measurements (create, ssh ready, setup).
node -e '
  const fs = require("fs"); const path = require("path");
  const [vmOut, results, hourly] = process.argv.slice(1);
  const phases = fs.existsSync(path.join(vmOut, "phases.json")) ? JSON.parse(fs.readFileSync(path.join(vmOut, "phases.json"), "utf8")) : {};
  for (const f of fs.readdirSync(vmOut).filter((f) => f.startsWith("android-") && f.endsWith(".json"))) {
    const m = JSON.parse(fs.readFileSync(path.join(vmOut, f), "utf8"));
    m.where = "android-vm";
    m.shape = { ...m.shape, machine: process.env.ANDROID_VM_MACHINE || "n2-standard-4" };
    m.vm = { createMs: phases.createMs ?? null, sshReadyMs: phases.sshReadyMs ?? null, setupMs: phases.setupMs ?? null,
             diskGiB: Number(process.env.ANDROID_VM_DISK_GB || 30), hourlyUsd: hourly ? Number(hourly) : null };
    fs.writeFileSync(path.join(results, f), JSON.stringify(m, null, 2) + "\n");
  }
' "$ANDROID_VM_OUT" "$RUN_OUT/results" "${ANDROID_VM_HOURLY_USD:-}"
say "Android measurements are in $RUN_OUT/results; run.sh's report (or bench --meter $RUN_OUT) includes them."
