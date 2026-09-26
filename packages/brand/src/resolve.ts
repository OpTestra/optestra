export const BRAND_KEYS = [
  "productName",
  "cliName",
  "npmScope",
  "desktopAppName",
  "webAppName",
  "domain",
  "configFileName",
  "dataDirName",
] as const;

export type BrandKey = (typeof BRAND_KEYS)[number];

export type Brand = Readonly<Record<BrandKey, string>>;

export function isBrandKey(key: string): key is BrandKey {
  return (BRAND_KEYS as readonly string[]).includes(key);
}

/** Lowercase, ASCII, dash-separated form of a product name. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates raw brand.json content and expands its placeholders:
 * `{Name}` becomes productName, `{name}` becomes its slug.
 */
export function resolveBrand(source: unknown): Brand {
  if (!isRecord(source)) throw new Error("brand.json must contain a JSON object");
  const productName = source.productName;
  if (typeof productName !== "string" || productName.trim() === "") {
    throw new Error('brand.json: "productName" must be a non-empty string');
  }
  const slug = slugify(productName);
  if (slug === "") throw new Error('brand.json: "productName" must contain letters or digits');

  for (const key of Object.keys(source)) {
    if (!key.startsWith("$") && !isBrandKey(key)) {
      throw new Error(`brand.json: unknown key "${key}"`);
    }
  }

  const resolved = {} as Record<BrandKey, string>;
  for (const key of BRAND_KEYS) {
    const raw = source[key];
    if (typeof raw !== "string" || raw === "") {
      throw new Error(`brand.json: "${key}" must be a non-empty string`);
    }
    resolved[key] = raw.replaceAll("{Name}", productName).replaceAll("{name}", slug);
  }

  if (!/^@[a-z0-9][a-z0-9._-]*$/.test(resolved.npmScope)) {
    throw new Error(`brand.json: invalid npmScope "${resolved.npmScope}"`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(resolved.cliName)) {
    throw new Error(`brand.json: invalid cliName "${resolved.cliName}"`);
  }
  if (/[\\/]/.test(resolved.dataDirName) || /[\\/]/.test(resolved.configFileName)) {
    throw new Error("brand.json: dataDirName and configFileName must be plain names");
  }
  return Object.freeze(resolved);
}
