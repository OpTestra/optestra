#!/usr/bin/env bash
# Creates the spot VM: n2 with nested virtualization (for the emulator's KVM),
# a hard --max-run-duration after which Google deletes it, labels for the bill.
# Boots Ubuntu LTS, or ANDROID_VM_IMAGE (made by image.sh) to skip setup.
# Records createMs (the API call) and sshReadyMs (until a command runs on it).
. "$(dirname "$0")/common.sh"

if [ -n "$ANDROID_VM_IMAGE" ]; then
  image=(--image "$ANDROID_VM_IMAGE")
else
  image=(--image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud)
fi

# ttl-minutes (the VM hard rule): the same limit as --max-run-duration, in minutes.
ttl=$(node -e '
  const t = process.argv[1]; let m = 0;
  for (const [, n, u] of t.matchAll(/(\d+)([dhms])/g)) m += Number(n) * { d: 1440, h: 60, m: 1, s: 1 / 60 }[u];
  if (!m) process.exit(1);
  process.stdout.write(String(Math.ceil(m)));
' "$ANDROID_VM_MAX_RUN") || { echo "ANDROID_VM_MAX_RUN must look like 3h, 90m or 1h30m." >&2; exit 2; }

started=$(now_ms)
"${GCLOUD[@]}" compute instances create "$ANDROID_VM_NAME" \
  --zone "$ANDROID_VM_ZONE" \
  --machine-type "$ANDROID_VM_MACHINE" \
  --enable-nested-virtualization \
  --provisioning-model SPOT \
  --instance-termination-action DELETE \
  --max-run-duration "$ANDROID_VM_MAX_RUN" \
  "${image[@]}" \
  --boot-disk-size "${ANDROID_VM_DISK_GB}GB" \
  --boot-disk-type pd-balanced \
  --boot-disk-auto-delete \
  --labels "$LABELS,ttl-minutes=$ttl"
created=$(now_ms)
phase createMs $((created - started))

# Until sshd answers (the first ssh also adds the key gcloud made for this account).
for _ in $(seq 1 60); do
  if on_vm true > /dev/null 2>&1; then break; fi
  sleep 5
done
on_vm true
phase sshReadyMs $(($(now_ms) - created))
phase vmStartedAt "$started"
echo "VM $ANDROID_VM_NAME is up in $ANDROID_VM_ZONE (deleted by Google after $ANDROID_VM_MAX_RUN at the latest)."
