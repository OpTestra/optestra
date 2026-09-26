import source from "../brand.json" with { type: "json" };
import { type Brand, resolveBrand } from "./resolve.js";

export { BRAND_KEYS, type Brand, type BrandKey, resolveBrand, slugify } from "./resolve.js";

/** Resolved product naming. Every name in code must come from here. */
export const brand: Brand = resolveBrand(source);
