import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brand } from "@testament/brand";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, sampleProject, tempDir } from "../sample.test-support.js";
import { createProject, findProject, loadProject, saveProject } from "./project.js";

afterEach(cleanup);

const configPath = (dir: string) => join(dir, brand.configFileName);

describe("loadProject", () => {
  it("loads the sample's staging environment with provenance and line numbers", () => {
    const loaded = loadProject(sampleProject(), { environment: "staging", env: {} });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.environment?.name).toBe("staging");
    expect(loaded.environment?.settings).toMatchObject({
      baseUrl: "https://staging.acme.test",
      allowedDomains: ["staging.acme.test", "auth.acme.test"],
      production: false,
      vars: { PLAN: "pro" },
    });
    expect(loaded.config.run.retries).toBe(2);
    expect(loaded.provenance["run.retries"]).toMatchObject({
      source: "environment",
      environment: "staging",
      line: 23,
    });
    expect(loaded.provenance["project.name"]).toMatchObject({ source: "project", line: 7 });
    expect(loaded.config.secrets.TEST_PASSWORD?.domains).toEqual(["auth.acme.test"]);
  });

  it("reports a missing project, bad YAML and duplicate secrets", () => {
    expect(loadProject(tempDir(), { env: {} }).diagnostics[0]?.code).toBe("PROJECT_NOT_FOUND");
    const bad = tempDir({ [brand.configFileName]: "version: 1\nproject: [unclosed\n" });
    expect(loadProject(bad, { env: {} }).diagnostics[0]?.code).toBe("YAML_SYNTAX");
    const duplicate = tempDir({
      [brand.configFileName]:
        "version: 1\nproject: { name: A, target: web }\nenvironments: { local: { baseUrl: 'http://localhost' } }\nsecrets:\n  PW:\n    domains: [localhost]\n  PW:\n    domains: [localhost]\n",
    });
    expect(loadProject(duplicate, { env: {} }).diagnostics).toContainEqual(
      expect.objectContaining({ code: "SECRET_DUPLICATE", line: 7, path: "secrets.PW" }),
    );
  });

  it("finds the project from a nested folder", () => {
    const dir = sampleProject();
    const nested = join(dir, "tests", "checkout");
    mkdirSync(nested, { recursive: true });
    expect(findProject(nested)).toBe(dir);
    expect(findProject(tempDir())).toBeUndefined();
  });
});

describe("saveProject", () => {
  it("changes one value and leaves every other byte identical", () => {
    const dir = sampleProject();
    const before = readFileSync(configPath(dir), "utf8");
    const result = saveProject(dir, {
      run: { healPolicy: "strict" },
      project: { name: "Acme Store" },
    });
    expect(result.ok).toBe(true);
    const after = readFileSync(configPath(dir), "utf8");
    expect(after).toBe(
      before
        .replace("healPolicy: review", "healPolicy: strict")
        .replace("name: Acme Shop", "name: Acme Store"),
    );
    expect(after).toContain("name: Acme Store # shown in the apps");
  });

  it("adds and removes keys while keeping comments and order", () => {
    const dir = sampleProject();
    const result = saveProject(dir, {
      environments: { production: { baseUrl: "https://acme.test", production: true } },
      run: { budget: { maxPerRunUsd: null } },
    });
    expect(result.ok).toBe(true);
    const after = readFileSync(configPath(dir), "utf8");
    expect(after).toContain("# Tests may also visit the login service.");
    expect(after).toContain("# Overrides for this environment only.");
    expect(after).not.toContain("maxPerRunUsd");
    expect(after.indexOf("staging:")).toBeLessThan(after.indexOf("production:"));
    expect(
      loadProject(dir, { environment: "production", env: {} }).environment?.settings.production,
    ).toBe(true);
  });

  it("refuses a change that introduces an error and leaves the file untouched", () => {
    const dir = sampleProject();
    const before = readFileSync(configPath(dir), "utf8");
    const result = saveProject(dir, { run: { retries: 99 } });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: "INVALID_VALUE", path: "run.retries" });
    expect(readFileSync(configPath(dir), "utf8")).toBe(before);
  });
});

describe("createProject", () => {
  it("writes a commented project that loads cleanly, plus .env.example and .gitignore", () => {
    const dir = tempDir();
    const result = createProject(dir, {
      name: "My: App",
      target: "web",
      baseUrl: "https://myapp.test",
    });
    expect(result.created.sort()).toEqual(
      [".env.example", ".gitignore", brand.configFileName].sort(),
    );
    const loaded = loadProject(dir, { env: {} });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.config.project.name).toBe("My: App");
    expect(loaded.environment?.settings.allowedDomains).toEqual(["myapp.test"]);
    expect(readFileSync(configPath(dir), "utf8")).toContain("# Secrets tests may use");
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    for (const entry of [".env", ".env.*", "!.env.example", `${brand.dataDirName}/`]) {
      expect(gitignore.split("\n")).toContain(entry);
    }
  });

  it("never overwrites existing files and only appends missing .gitignore lines", () => {
    const dir = tempDir({
      [brand.configFileName]: "# mine\n",
      ".env.example": "# mine\n",
      ".gitignore": "node_modules\n.env\n",
    });
    const result = createProject(dir, { name: "X", target: "android" });
    expect(result.skipped.sort()).toEqual([".env.example", brand.configFileName].sort());
    expect(result.updated).toEqual([".gitignore"]);
    expect(readFileSync(configPath(dir), "utf8")).toBe("# mine\n");
    expect(readFileSync(join(dir, ".env.example"), "utf8")).toBe("# mine\n");
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gitignore.startsWith("node_modules\n.env\n")).toBe(true);
    expect(gitignore.match(/^\.env$/gm)?.length).toBe(1);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });
});
