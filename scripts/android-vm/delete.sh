#!/usr/bin/env bash
# Deletes the VM (and its disk), and with --images every image in the
# ANDROID_VM_IMAGE_FAMILY family. Then lists anything still labelled for this
# app and lane, so nothing is left running or stored by mistake.
. "$(dirname "$0")/common.sh"

if "${GCLOUD[@]}" compute instances describe "$ANDROID_VM_NAME" --zone "$ANDROID_VM_ZONE" > /dev/null 2>&1; then
  "${GCLOUD[@]}" compute instances delete "$ANDROID_VM_NAME" --zone "$ANDROID_VM_ZONE" --delete-disks all
fi
if [ "${1:-}" = "--images" ]; then
  for image in $("${GCLOUD[@]}" compute images list --no-standard-images \
    --filter "family=$ANDROID_VM_IMAGE_FAMILY" --format 'value(name)'); do
    "${GCLOUD[@]}" compute images delete "$image"
  done
fi

filter="labels.app=$BRAND_SLUG AND labels.lane=$ANDROID_VM_LANE"
echo "Still there (app=$BRAND_SLUG, lane=$ANDROID_VM_LANE):"
echo "  VMs:    $("${GCLOUD[@]}" compute instances list --filter "$filter" --format 'value(name)' | tr '\n' ' ')"
echo "  disks:  $("${GCLOUD[@]}" compute disks list --filter "$filter" --format 'value(name)' | tr '\n' ' ')"
echo "  images: $("${GCLOUD[@]}" compute images list --no-standard-images --filter "$filter" --format 'value(name)' | tr '\n' ' ')"
