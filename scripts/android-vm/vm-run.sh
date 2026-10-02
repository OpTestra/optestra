#!/usr/bin/env bash
# Runs ON the VM (run.sh copies it there): rebuilds what changed, then runs one
# command, timing the build and the command into ~/results/run-phases.json.
set -euo pipefail
# shellcheck disable=SC1091
. "$HOME/.android-vm-env"
cd "$HOME/engine"
# ~/repo: the name callers use for the repo copy.
[ -e "$HOME/repo" ] || ln -s "$HOME/engine" "$HOME/repo"
rm -rf "$HOME/results" && mkdir -p "$HOME/results/out"
# Where the command writes its results; run.sh copies them back.
export ANDROID_VM_OUT="$HOME/results/out"
# The first boot setup.sh did on this disk (absent on a disk from a reusable image).
[ -f "$HOME/first-boot.json" ] && cp "$HOME/first-boot.json" "$HOME/results/"

ms() { date +%s%3N; }
t=$(ms)
pnpm install --frozen-lockfile > "$HOME/results/install.log" 2>&1
pnpm --filter ./packages/android build:driver
pnpm --filter ./bench/fixtures/android build:apks
build=$(($(ms) - t))

# The machine, for the record.
python3 - > "$HOME/results/machine.json" <<'PY'
import json, os
mem = next(int(l.split()[1]) for l in open("/proc/meminfo") if l.startswith("MemTotal"))
cpu = next(l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name"))
print(json.dumps({"cpus": os.cpu_count(), "memoryMb": mem // 1024, "cpuModel": cpu,
                  "kernel": os.uname().release}))
PY

t=$(ms)
status=0
bash -c "$1" 2>&1 | tee "$HOME/results/output.log" || status=${PIPESTATUS[0]}
echo "{\"buildMs\": $build, \"commandMs\": $(($(ms) - t)), \"exit\": $status}" > "$HOME/results/run-phases.json"
exit "$status"
