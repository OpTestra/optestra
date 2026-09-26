import { describe, expect, it } from "vitest";
import source from "../brand.json" with { type: "json" };
import { brand } from "./index.js";
import { BRAND_KEYS, resolveBrand, slugify } from "./resolve.js";

const template = {
  productName: "Acme Probe",
  cliName: "{name}",
  npmScope: "@{name}",
  desktopAppName: "{Name}",
  webAppName: "{Name} Web",
  domain: "{name}.io",
  configFileName: "{name}.config.ts",
  dataDirName: ".{name}",
};

describe("resolveBrand", () => {
  it("expands {Name} and {name}", () => {
    expect(resolveBrand(template)).toEqual({
      productName: "Acme Probe",
      cliName: "acme-probe",
      npmScope: "@acme-probe",
      desktopAppName: "Acme Probe",
      webAppName: "Acme Probe Web",
      domain: "acme-probe.io",
      configFileName: "acme-probe.config.ts",
      dataDirName: ".acme-probe",
    });
  });

  it("rejects missing keys, unknown keys and invalid names", () => {
    const { cliName: _omit, ...missing } = template;
    expect(() => resolveBrand(missing)).toThrow(/cliName/);
    expect(() => resolveBrand({ ...template, extra: "x" })).toThrow(/unknown key/);
    expect(() => resolveBrand({ ...template, npmScope: "no-at" })).toThrow(/npmScope/);
  });

  it("slugifies accents and punctuation", () => {
    expect(slugify("Ünïcode & Co.")).toBe("unicode-co");
  });

  it("exports a fully resolved brand from brand.json", () => {
    expect(brand).toEqual(resolveBrand(source));
    for (const key of BRAND_KEYS) expect(brand[key]).not.toMatch(/[{}]/);
  });
});
