import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The cost-run files (COST-0, bench/cloud) without Docker or gcloud: the image
// is generic and pinned, nothing names a project, an account or a key, every
// resource is labelled, and every script that changes the cloud goes through
// the one wrapper that DRY_RUN and the local stand-in print instead.
// hadolint runs as Cloud Build's first step; these are its rules that matter here.

const root = fileURLToPath(new URL("..", import.meta.url));
const cloud = join(root, "bench", "cloud");
const read = (file: string) => readFileSync(join(cloud, file), "utf8");
const dockerfile = read("Dockerfile");
const scripts = readdirSync(cloud).filter((f) => f.endsWith(".sh"));

describe("the cost-run image", () => {
  it("is the engine's Playwright and Node, pinned", () => {
    const playwright = JSON.parse(readFileSync(join(root, "packages/browser/package.json"), "utf8"))
      .dependencies.playwright as string;
    expect(dockerfile).toContain(`ARG PLAYWRIGHT_VERSION=${playwright}`);
    expect(dockerfile).toMatch(
      /^FROM mcr\.microsoft\.com\/playwright:v\$\{PLAYWRIGHT_VERSION\}-noble$/m,
    );
    const node = readFileSync(join(root, ".nvmrc"), "utf8").trim();
    expect(dockerfile).toMatch(new RegExp(`^ARG NODE_VERSION=${node}\\.\\d+\\.\\d+$`, "m"));
    expect(dockerfile).toContain("sha256sum -c -");
    expect(dockerfile).not.toMatch(/:latest\b/);
  });

  it("follows hadolint's main rules", () => {
    const lines = dockerfile.split("\n");
    const shell = lines.findIndex((l) => l.startsWith('SHELL ["/bin/bash", "-o", "pipefail"'));
    const firstPipe = lines.findIndex((l) => l.startsWith("RUN") && /\|/.test(l));
    // DL4006: pipefail before any RUN with a pipe.
    expect(shell).toBeGreaterThan(-1);
    expect(firstPipe === -1 || shell < firstPipe).toBe(true);
    // DL3002: not root at the end; DL3025: JSON form for ENTRYPOINT.
    const user = lines.findLastIndex((l) => l.startsWith("USER "));
    expect(lines[user]).not.toMatch(/root/);
    expect(user).toBeLessThan(lines.findIndex((l) => l.startsWith("ENTRYPOINT")));
    expect(dockerfile).toMatch(/^ENTRYPOINT \["node", "bench\/cloud\/entry\.ts"\]$/m);
    // DL3020: COPY, not ADD; DL3009-style: no apt cache left (no apt at all).
    expect(dockerfile).not.toMatch(/^ADD /m);
    expect(dockerfile).not.toMatch(/apt-get/);
  });

  it("is built by Cloud Build with hadolint first, from the repository root", () => {
    const build = read("cloudbuild.yaml");
    expect(build.indexOf("name: hadolint/")).toBeLessThan(
      build.indexOf("name: gcr.io/cloud-builders/docker"),
    );
    expect(build.indexOf("name: hadolint/")).toBeGreaterThan(-1);
    expect(build).toContain('"-f", "bench/cloud/Dockerfile"');
    expect(build).toContain('images: ["${_IMAGE}"]');
  });

  it("uploads the recordings but no installs, builds, local data or env files", () => {
    const ignore = read(".gcloudignore")
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .join("\n");
    for (const line of ["**/node_modules/", "**/dist/", "**/.env", "bench/cloud/out/"])
      expect(ignore).toContain(line);
    // tests/<data dir>/*.steps.json are committed and replayed in the cloud.
    expect(ignore).not.toMatch(/^\*\*\/\.[a-z]+\/$/m);
    expect(ignore).not.toMatch(/tests\//);
  });
});

describe("the cost-run scripts", () => {
  it("parse, and each one sources common.sh", () => {
    for (const file of scripts) {
      expect(spawnSync("bash", ["-n", join(cloud, file)]).status, file).toBe(0);
      if (file !== "common.sh") {
        expect(read(file), file).toMatch(/^#!\/usr\/bin\/env bash\n/);
        expect(read(file), file).toContain('. "$(dirname "$0")/common.sh"');
      }
    }
  });

  it("name no project, account, key or product literal", () => {
    const files = readdirSync(cloud).filter(
      (f) => !f.endsWith(".md") && f !== "testdata" && f !== "out",
    );
    for (const file of files) {
      const text = read(file);
      // A literal project in an account (`@my-project.iam…`); `@$PROJECT_ID.iam…` is fine.
      expect(text, file).not.toMatch(/@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com/);
      expect(text, file).not.toMatch(/sk-ant-|AIza[0-9A-Za-z_-]{20}|AKIA[0-9A-Z]{16}|-----BEGIN/);
      expect(text, file).not.toMatch(/--project[= ](?!"?\$|%s)/);
    }
    // The .env holding the project ID is never committed.
    expect(spawnSync("git", ["check-ignore", "-q", "bench/cloud/.env"], { cwd: root }).status).toBe(
      0,
    );
  });

  it("change the cloud only through gc (which DRY_RUN and the local stand-in print)", () => {
    // Raw gcloud calls are reads, the one execute whose output names the execution,
    // and the results download.
    const allowed =
      /gcloud --project "\$PROJECT_ID"( --quiet)? (run jobs executions tasks list|run jobs execute|storage cp|artifacts docker images describe|secrets versions list|asset search-all-resources|builds get-default-service-account)|gcloud --project "\$PROJECT_ID" --quiet "\$@"|command -v gcloud|gcloud isn't installed|gcloud auth/;
    for (const file of scripts) {
      for (const line of read(file).split("\n")) {
        if (!/\bgcloud\b/.test(line) || /^\s*#/.test(line) || /^\s*(say|echo|printf)\b/.test(line))
          continue;
        if (/^\s*gc /.test(line) || /printf '  gcloud/.test(line)) continue;
        expect(line, `${file}: ${line.trim()}`).toMatch(allowed);
      }
    }
  });

  it("label every resource they create", () => {
    const up = read("up.sh");
    for (const create of ["artifacts repositories create", "secrets create", "run jobs deploy"]) {
      const at = up.indexOf(create);
      expect(at, create).toBeGreaterThan(-1);
      expect(up.slice(at, up.indexOf("\n\n", at)), create).toContain('--labels "$LABELS"');
    }
    expect(up).toContain('--update-labels "$LABELS"');
    expect(read("common.sh")).toContain('LABELS="app=$BRAND_SLUG,lane=$LANE,cost-run=$COST_RUN"');
    expect(read("android.sh")).toContain('export ANDROID_VM_COST_RUN="$COST_RUN"');
  });

  it("tear down what up.sh creates", () => {
    const down = read("down.sh");
    for (const what of [
      "run jobs delete",
      "artifacts repositories delete",
      "storage rm --recursive",
      "secrets delete",
      "iam service-accounts delete",
    ])
      expect(down, what).toContain(what);
  });
});

describe("the run plan", () => {
  const plan = JSON.parse(read("plan.json")) as {
    executions: Array<{
      name: string;
      slices: Array<{ fixture: string; phase: string; evidence?: string }>;
      tasks: number;
      parallel: number;
      cpu: number;
      memoryGiB: number;
      expectedMinutes: number;
    }>;
  };

  it("has valid slices and shapes Cloud Run accepts", () => {
    const names = new Set<string>();
    for (const e of plan.executions) {
      expect(names.has(e.name), e.name).toBe(false);
      names.add(e.name);
      expect(e.slices.length).toBeGreaterThan(0);
      expect(e.tasks).toBeGreaterThanOrEqual(1);
      expect([1, 2, 4, 8]).toContain(e.cpu);
      // Cloud Run: at least 0.5 GiB per vCPU... and at most 4 GiB per vCPU at these sizes.
      expect(e.memoryGiB / e.cpu).toBeGreaterThanOrEqual(0.5);
      expect(e.memoryGiB / e.cpu).toBeLessThanOrEqual(4);
      for (const s of e.slices) {
        expect(["shop", "android"]).toContain(s.fixture);
        expect(["author", "replay", "heal"]).toContain(s.phase);
        if (s.evidence) expect(["full", "failures", "minimal"]).toContain(s.evidence);
      }
    }
    // The brief's two parallelism settings, on the default shape.
    expect(
      plan.executions.filter((e) => e.cpu === 2 && e.memoryGiB === 4).map((e) => e.parallel),
    ).toEqual(expect.arrayContaining([1, 4]));
  });
});
