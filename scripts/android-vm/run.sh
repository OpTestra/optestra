#!/usr/bin/env bash
# Runs the Android suite on the VM, headless, and writes its timings
# ($ANDROID_VM_OUT/vm-run.json).
#
#   run.sh                          bench:replay:android, every variant
#   run.sh --variant correct        a slice: the arguments go to bench:replay:android
#   run.sh "<command>"              any command, run by bash in the repo copy on the VM
#   run.sh -- <command…>            the same, unquoted, e.g.
#                                   run.sh -- pnpm --filter ./packages/android test:android
#
# A command writes its own results to $ANDROID_VM_OUT: on the VM that is a folder
# copied back into $ANDROID_VM_OUT here afterwards (the local path, if the command
# names it, is rewritten to the VM's folder). The repo copy is ~/engine, also ~/repo.
#
# Copies the working tree first (ANDROID_VM_SYNC=0 to skip) and rebuilds what
# changed (the TypeScript and the APKs; Gradle skips what is up to date).
. "$(dirname "$0")/common.sh"

if [ "${1:-}" = "--" ]; then
  shift
  command="$*"
  kind=command
elif [ -n "${1:-}" ] && [ "${1#-}" = "$1" ]; then
  command="$*"
  kind=command
else
  command="pnpm bench:replay:android --json ~/results/replay.json $*"
  kind=replay
fi

# The command may name this machine's $ANDROID_VM_OUT; on the VM it is ~/results/out.
if [ "$kind" = command ]; then
  # shellcheck disable=SC2016
  vm_out='$HOME/results/out' # expanded on the VM, not here
  command="${command//"$ANDROID_VM_OUT"/$vm_out}"
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
  # What the command wrote to $ANDROID_VM_OUT on the VM, next to phases.json here.
  if [ -d "$ANDROID_VM_OUT/vm/out" ]; then cp -R "$ANDROID_VM_OUT/vm/out/." "$ANDROID_VM_OUT/"; fi
fi
phase runMs $(($(now_ms) - started))

(cd "$REPO" && node "$VM_SCRIPTS/report.mjs" "$ANDROID_VM_OUT" "$kind" "$command" "$status")
echo "Wrote $ANDROID_VM_OUT/vm-run.json (exit $status)."
exit "$status"
