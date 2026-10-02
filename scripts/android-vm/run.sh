#!/usr/bin/env bash
# Runs the Android suite on the VM, headless, and writes the JSON COST-0 reads
# ($ANDROID_VM_OUT/android-vm-run.json).
#
#   run.sh                          bench:replay:android, every variant
#   run.sh --variant correct        a slice: the arguments go to bench:replay:android
#   run.sh -- <command…>            any other command in the repo, e.g.
#                                   run.sh -- pnpm --filter ./packages/android test:android
#
# Copies the working tree first (ANDROID_VM_SYNC=0 to skip) and rebuilds what
# changed (the TypeScript and the APKs; Gradle skips what is up to date).
. "$(dirname "$0")/common.sh"

if [ "${1:-}" = "--" ]; then
  shift
  command="$*"
  kind=command
else
  command="pnpm bench:replay:android --json ~/results/replay.json $*"
  kind=replay
fi

started=$(now_ms)
[ "${ANDROID_VM_SYNC:-1}" = "1" ] && push_tree
to_vm "$VM_SCRIPTS/vm-run.sh" "$ANDROID_VM_NAME:vm-run.sh"
status=0
on_vm "$(forwarded_env) bash ~/vm-run.sh $(printf '%q' "$command")" || status=$?
rm -rf "$ANDROID_VM_OUT/vm"
if [ "$status" = 255 ] && preempted; then
  phase preempted 1
  echo "The spot VM was preempted (Google stops and deletes it): nothing ran to the end. Create a new one." >&2
else
  to_vm --recurse "$ANDROID_VM_NAME:results" "$ANDROID_VM_OUT/vm"
fi
phase runMs $(($(now_ms) - started))

(cd "$REPO" && node "$VM_SCRIPTS/report.mjs" "$ANDROID_VM_OUT" "$kind" "$command" "$status")
echo "Wrote $ANDROID_VM_OUT/android-vm-run.json (exit $status)."
exit "$status"
