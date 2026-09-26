import { brand } from "@testament/brand";
import { z } from "zod";
import { isPlainObject } from "./paths.js";
import { type ConfigRegistry, defaultRegistry } from "./registry.js";

/** Settings with a built-in default are optional in the file. */
function relaxRequired(node: unknown, defaults: unknown): void {
  if (!isPlainObject(node)) return;
  const defaultsObject = isPlainObject(defaults) ? defaults : {};
  if (isPlainObject(node.properties)) {
    if (Array.isArray(node.required)) {
      node.required = node.required.filter((key) => defaultsObject[String(key)] === undefined);
      if ((node.required as unknown[]).length === 0) delete node.required;
    }
    for (const [key, child] of Object.entries(node.properties))
      relaxRequired(child, defaultsObject[key]);
  }
  if (isPlainObject(node.additionalProperties))
    relaxRequired(node.additionalProperties, defaultsObject["*"]);
}

/**
 * JSON Schema (draft 2020-12) of the project file, for editor autocomplete and
 * the apps' settings forms. Includes every registered section.
 */
export function configJsonSchema(
  registry: ConfigRegistry = defaultRegistry,
): Record<string, unknown> {
  const schema = z.toJSONSchema(registry.schemas().config, { unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  relaxRequired(schema, registry.defaults());
  return {
    ...schema,
    title: `${brand.productName} project config`,
    description: `Schema of ${brand.configFileName}. Secret values never go in this file.`,
  };
}
