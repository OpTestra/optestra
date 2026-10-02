#!/usr/bin/env bash
# Runs ON the VM (setup.sh copies it there). Installs what CI's Android job has,
# builds the APKs, and boots the emulator once so the AVD and its clean snapshot
# exist. Each step is timed into ~/setup-phases.json. Safe to run again.
set -euo pipefail

SDK="$HOME/android-sdk"
TOOLS="$HOME/tools"
ENGINE="$HOME/engine"
# CI's packages (.github/workflows/ci.yml, android job).
PACKAGES=(platform-tools emulator "platforms;android-36" "build-tools;36.0.0" "system-images;android-36;google_apis;x86_64")
GRADLE_VERSION=9.7.1
OUT="$HOME/setup-phases.json"
echo '{}' > "$OUT"

ms() { date +%s%3N; }
record() { python3 - "$OUT" "$1" "$2" <<'PY'
import json, sys
path, name, value = sys.argv[1:]
data = json.load(open(path))
data[name] = None if value == "null" else int(value)
json.dump(data, open(path, "w"), indent=2)
PY
}
step() { # step <name> <command…>: runs and times one phase
  local name=$1 t; shift
  t=$(ms)
  echo "── $name"
  "$@"
  record "${name}Ms" $(($(ms) - t))
}

packages() {
  sudo apt-get update -qq
  # The JDK for Gradle, and the libraries the headless emulator loads.
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    openjdk-21-jdk-headless unzip xz-utils curl python3 \
    libpulse0 libnss3 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
    libxkbfile1 libgl1 libegl1 libasound2t64 libbz2-1.0 > /dev/null
}

kvm() {
  if [ ! -e /dev/kvm ]; then
    echo "No /dev/kvm: the VM needs --enable-nested-virtualization (create.sh sets it)." >&2
    exit 1
  fi
  # As CI does: KVM for every user, so no re-login is needed.
  echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' |
    sudo tee /etc/udev/rules.d/99-kvm4all.rules > /dev/null
  sudo udevadm control --reload-rules
  sudo udevadm trigger --name-match=kvm
  ls -l /dev/kvm
}

node_js() {
  [ -x "$TOOLS/node/bin/node" ] && return
  mkdir -p "$TOOLS"
  local base="https://nodejs.org/dist/latest-v$(cat "$ENGINE/.nvmrc").x" file
  curl -fsSL "$base/SHASUMS256.txt" -o /tmp/node-sums
  file=$(grep -o 'node-v[0-9.]*-linux-x64.tar.xz' /tmp/node-sums | head -1)
  curl -fsSL "$base/$file" -o "/tmp/$file"
  (cd /tmp && grep " $file\$" node-sums | sha256sum -c -)
  rm -rf "$TOOLS/node" && mkdir -p "$TOOLS/node"
  tar -xJf "/tmp/$file" -C "$TOOLS/node" --strip-components 1
}

gradle() {
  [ -x "$TOOLS/gradle/bin/gradle" ] && return
  local url="https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
  curl -fsSL "$url" -o /tmp/gradle.zip
  echo "$(curl -fsSL "$url.sha256")  /tmp/gradle.zip" | sha256sum -c -
  rm -rf "$TOOLS/gradle" "$TOOLS/gradle-$GRADLE_VERSION"
  unzip -q /tmp/gradle.zip -d "$TOOLS" && mv "$TOOLS/gradle-$GRADLE_VERSION" "$TOOLS/gradle"
}

android_sdk() {
  local manager="$SDK/cmdline-tools/latest/bin/sdkmanager"
  if [ ! -x "$manager" ]; then
    # The newest Linux command-line tools and their SHA-1, from Google's repository index.
    read -r zip sha1 < <(curl -fsSL https://dl.google.com/android/repository/repository2-3.xml | python3 -c '
import re, sys, xml.etree.ElementTree as ET
best = None
for archive in ET.parse(sys.stdin).getroot().iter("archive"):
    url = archive.findtext("complete/url") or ""
    m = re.fullmatch(r"commandlinetools-linux-(\d+)_latest\.zip", url)
    if m and (best is None or int(m[1]) > best[0]):
        best = (int(m[1]), url, archive.findtext("complete/checksum"))
print(best[1], best[2])')
    curl -fsSL "https://dl.google.com/android/repository/$zip" -o /tmp/cmdline-tools.zip
    echo "$sha1  /tmp/cmdline-tools.zip" | sha1sum -c -
    rm -rf "$SDK/cmdline-tools" && mkdir -p "$SDK/cmdline-tools"
    unzip -q /tmp/cmdline-tools.zip -d "$SDK/cmdline-tools" && mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
  fi
  [ "${ANDROID_VM_ACCEPT_SDK_LICENSES:-}" = "yes" ] || { echo "The SDK licence was not accepted." >&2; exit 2; }
  # Newer tools stop reading the prompt early: `yes` then dies of SIGPIPE, which is fine.
  { yes || true; } | "$manager" --licenses > /dev/null
  { yes || true; } | "$manager" "${PACKAGES[@]}" > /dev/null
  "$SDK/emulator/emulator" -accel-check
}

engine() {
  cd "$ENGINE"
  corepack enable --install-directory "$TOOLS/node/bin" > /dev/null 2>&1 || corepack enable
  pnpm install --frozen-lockfile
  pnpm --filter ./packages/android build:driver
  pnpm --filter ./bench/fixtures/android build:apks
  pnpm exec tsc -b packages/android
}

write_env() {
  local javac
  javac=$(readlink -f "$(command -v javac)")
  cat > "$HOME/.android-vm-env" <<EOF
export ANDROID_HOME="$SDK"
export JAVA_HOME="${javac%/bin/javac}"
export PATH="$TOOLS/node/bin:$TOOLS/gradle/bin:$SDK/platform-tools:$SDK/emulator:\$PATH"
EOF
}

# The AVD and its clean snapshot: the engine makes both on its first boot (cold).
first_boot() {
  cd "$ENGINE"
  node scripts/android-vm/boot.mjs > "$HOME/first-boot.json"
  cat "$HOME/first-boot.json"
}

all=$(ms)
step packages packages
step kvm kvm
write_env
# shellcheck disable=SC1091
. "$HOME/.android-vm-env"
step node node_js
step gradle gradle
step androidSdk android_sdk
step build engine
step firstBoot first_boot
record setupTotalMs $(($(ms) - all))
record diskUsedMb "$(df -m --output=used / | tail -1 | tr -d ' ')"
echo "Setup finished."
cat "$OUT"
