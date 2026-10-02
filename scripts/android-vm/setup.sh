#!/usr/bin/env bash
# Sets up a fresh VM: copies the working tree, then runs vm-setup.sh on it
# (JDK, Node, Gradle, Android SDK as CI has it, /dev/kvm, the APKs, the AVD and
# its clean snapshot). Idempotent: a second run skips what is there.
#
# The Android SDK licence must be accepted to install the SDK. That is your
# call: set ANDROID_VM_ACCEPT_SDK_LICENSES=yes once you have read it
# (`sdkmanager --licenses` shows it).
. "$(dirname "$0")/common.sh"

if [ "${ANDROID_VM_ACCEPT_SDK_LICENSES:-}" != "yes" ]; then
  echo "Set ANDROID_VM_ACCEPT_SDK_LICENSES=yes to accept the Android SDK licence on the VM." >&2
  exit 2
fi

started=$(now_ms)
push_tree
to_vm "$VM_SCRIPTS/vm-setup.sh" "$ANDROID_VM_NAME:vm-setup.sh"
on_vm "ANDROID_VM_ACCEPT_SDK_LICENSES=yes $(forwarded_env) bash ~/vm-setup.sh"
to_vm "$ANDROID_VM_NAME:setup-phases.json" "$ANDROID_VM_OUT/setup-phases.json"
phase setupMs $(($(now_ms) - started))
echo "Setup done; its phases are in $ANDROID_VM_OUT/setup-phases.json."
