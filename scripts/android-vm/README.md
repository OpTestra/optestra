# Android on a Linux VM (Google Cloud)

Scripts that run the Android suite on a spot `n2-standard-4` with nested
virtualization: the machine type CI's Linux job and cloud Android runs use. They
measure every phase and write one JSON file for the cost meter (COST-0).

All of them run on your machine and reach the VM over `gcloud compute ssh`. You
sign in to gcloud yourself (`gcloud auth login`); nothing here handles
credentials, and nothing names a project: settings come from the environment or
`scripts/android-vm/.env` (git-ignored, see `.env.example`), or a file outside the
repo named by `ANDROID_VM_ENV_FILE` (needed when the project ID contains the
product name, which `pnpm brand:check` refuses anywhere in the tree).

```bash
cp scripts/android-vm/.env.example scripts/android-vm/.env   # set ANDROID_VM_PROJECT
scripts/android-vm/create.sh      # the spot VM, capped by --max-run-duration
scripts/android-vm/setup.sh       # JDK, Node, Gradle, Android SDK, APKs, AVD + snapshot
scripts/android-vm/run.sh         # bench:replay:android, headless → android-vm-results/vm-run.json
scripts/android-vm/delete.sh      # the VM and its disk; lists anything left
```

| Script | Does |
|---|---|
| `create.sh` | `gcloud compute instances create`: spot, `--enable-nested-virtualization`, `--max-run-duration` (default 3h; Google deletes the VM and its disk then, whatever else happens), `--instance-termination-action DELETE`, a 30 GB pd-balanced disk, labels `app=<brand>,lane=<lane>[,cost-run=<id>],ttl-minutes=<the same limit>`. Ubuntu 24.04 LTS, or `ANDROID_VM_IMAGE`. |
| `setup.sh` | Copies the working tree and runs `vm-setup.sh` on the VM: the packages CI's Android job has (`platforms;android-36`, `build-tools;36.0.0`, `system-images;android-36;google_apis;x86_64`, emulator, platform-tools), OpenJDK 21 (Ubuntu's; CI uses Temurin 21), Node from `.nvmrc`, Gradle 9.7.1 (every download checksum-checked), the KVM udev rule, the driver and fixture APKs, then one emulator boot that makes the AVD and its clean snapshot. Idempotent. Accepting the Android SDK licence is your call: it needs `ANDROID_VM_ACCEPT_SDK_LICENSES=yes`. |
| `run.sh` | Copies the working tree (`ANDROID_VM_SYNC=0` to skip), rebuilds what changed (the APKs and the driver), and runs `bench:replay:android`; options go to it (`run.sh --variant correct`). `run.sh "<command>"` (or `run.sh -- <command…>`) runs any command with bash in the repo copy on the VM (`~/engine`, also `~/repo`) instead. A command writes its results to `$ANDROID_VM_OUT`, which on the VM is a folder copied back into `$ANDROID_VM_OUT` here afterwards; if the command names this machine's `$ANDROID_VM_OUT` path, it is rewritten to the VM's. Names a spot preemption when it is one. |
| `image.sh` | Stops the VM and makes a reusable image of its disk (family `ANDROID_VM_IMAGE_FAMILY`, label `ttl-minutes`: `ANDROID_VM_IMAGE_TTL_MINUTES`, default 10080). A VM created with `ANDROID_VM_IMAGE=<name>` boots with everything in place, AVD snapshot included, and skips `setup.sh`. Images are billed for storage until deleted. |
| `delete.sh` | Deletes the VM and its disk (`--images`: the images too), then lists anything still labelled for this app and lane. |

The Android command-line tools collect usage data only when opted in; on the VM
they are not (`~/.android/analytics.settings`, `hasOptedIn: false`).

## The JSON (`android-vm-results/vm-run.json`)

Named so it is never taken for one of a command's own `android-*.json`
measurements in the same folder.

Every number is milliseconds unless its name says otherwise; `null` when the
phase didn't happen in this run (e.g. `setupMs` on a VM from a reusable image).

```jsonc
{
  "kind": "android-vm-run",
  "version": 1,
  "date": "2026-10-02T…Z",
  "commit": "…", "dirty": false,          // the local tree that was copied
  "vm": {
    "machineType": "n2-standard-4", "zone": "us-east4-b", "provisioning": "spot",
    "maxRunDuration": "3h", "diskGb": 30,
    "image": "ubuntu-2404-lts-amd64",      // or the reusable image's name
    "fromReusableImage": false,
    "cpus": 4, "memoryMb": 16008, "cpuModel": "…", "kernel": "…"
  },
  "phases": {
    "createMs": 13196,                     // the create API call
    "sshReadyMs": 37267,                   // until a command runs on the VM
    "setupMs": 322401,                     // setup.sh end to end (null from an image)
    "setup": {                             // its steps (null from an image)
      "packagesMs": 30834, "kvmMs": 46, "nodeMs": 2364, "gradleMs": 1952,
      "androidSdkMs": 57202, "buildMs": 97337, "firstBootMs": 93416,
      "setupTotalMs": 283407, "diskUsedMb": 14552
    },
    "emulatorColdBootMs": 61077,           // first boot: makes the clean snapshot (once per disk)
    "emulatorSnapshotBootMs": 9240,        // this run's boot from the snapshot
    "buildMs": 0,                          // rebuilding before the command
    "commandMs": 0,                        // the command (the replay)
    "imageCreateMs": null                  // image.sh, when it ran
  },
  "command": "pnpm bench:replay:android --json ~/results/replay.json",   // or the command given
  "exit": 0,
  "preempted": false,                      // a spot preemption cut the run short
  "replay": {                              // null for run.sh -- <command>
    "summary": { "tests": 56, "match": 0, "healed": 0, "needsAi": 0, "mismatch": 0, "aiCalls": 0 },
    "wallMsPerTest": { "n": 56, "mean": 0, "p50": 0, "p90": 0, "max": 0 },
    "machineCpuMsPerTest": 0,              // all cores' CPU time during the replay, per test
    "evidenceBytes": { "total": 0, "perTest": 0 },
    "variants": { "correct": { "tests": 7, "machineCpuMs": 0, "evidenceBytes": 0 } },
    "variantWallMs": { "correct": 0 },
    "mismatches": []
  },
  "cost": { "vmSeconds": 0, "hourlyUsd": null, "usd": null }   // ANDROID_VM_HOURLY_USD gives the price
}
```

`cost.vmSeconds` runs from `create.sh` to the end of `run.sh`. The replay runs
with the CI evidence settings (`video: false`), so `evidenceBytes` are the
run folders without a screen video.
