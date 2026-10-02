#!/usr/bin/env bash
# Makes a reusable image from a set-up VM's disk, so later VMs boot with the
# SDK, the build and the AVD's clean snapshot in place and skip setup.sh:
#   ANDROID_VM_IMAGE=<name printed here> ./create.sh && ./run.sh
# Stops the VM first (a clean disk), then creates the image in the
# ANDROID_VM_IMAGE_FAMILY family with the same labels. An image is billed for
# storage until deleted (delete.sh --images); its ttl-minutes label (default
# 10080, 7 days; ANDROID_VM_IMAGE_TTL_MINUTES) says when that is due.
. "$(dirname "$0")/common.sh"

name="${ANDROID_VM_IMAGE_FAMILY}-$(date +%Y%m%d-%H%M%S)"
started=$(now_ms)
"${GCLOUD[@]}" compute instances stop "$ANDROID_VM_NAME" --zone "$ANDROID_VM_ZONE"
"${GCLOUD[@]}" compute images create "$name" \
  --source-disk "$ANDROID_VM_NAME" \
  --source-disk-zone "$ANDROID_VM_ZONE" \
  --family "$ANDROID_VM_IMAGE_FAMILY" \
  --storage-location "${ANDROID_VM_ZONE%-*}" \
  --labels "$LABELS,ttl-minutes=${ANDROID_VM_IMAGE_TTL_MINUTES:-10080}"
phase imageCreateMs $(($(now_ms) - started))
size=$("${GCLOUD[@]}" compute images describe "$name" --format 'value(archiveSizeBytes)')
echo "Image $name ($((size / 1024 / 1024)) MB stored). Boot from it with ANDROID_VM_IMAGE=$name."
