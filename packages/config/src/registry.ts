import { z } from "zod";
import { BUILT_IN_DEFAULTS } from "./defaults.generated.js";
import { deepMerge } from "./paths.js";
import {
  defaultEnvironmentSchema,
  environmentBaseShape,
  projectSchema,
  runSchema,
  secretsSchema,
} from "./schema.js";

export interface SectionDefinition {
  /** Top-level key in the project file, camelCase. */
  key: string;
  /** Schema of the fully resolved section (after defaults). */
  schema: z.ZodType;
  /** Defaults for the section. Values in defaults.yaml under the same key win. */
  defaults?: unknown;
  /** The section may be absent after resolution. */
  optional?: boolean;
  /** Environments may override this section (e.g. `environments.production.run`). */
  environmentOverride?: boolean;
}

export interface BuiltSchemas {
  /** One environment entry, including allowed section overrides. */
  environment: z.ZodObject;
  /** The whole resolved config. */
  config: z.ZodObject;
}

const RESERVED = new Set(["version"]);

/**
 * The set of top-level config sections. Later phases add sections with
 * `registerSection` instead of editing the loader or the merge code.
 */
export class ConfigRegistry {
  readonly #sections = new Map<string, SectionDefinition>();
  #built: BuiltSchemas | undefined;

  register(section: SectionDefinition): this {
    if (!/^[a-z][A-Za-z0-9]*$/.test(section.key) || RESERVED.has(section.key)) {
      throw new Error(`Invalid config section key "${section.key}"`);
    }
    if (this.#sections.has(section.key)) {
      throw new Error(`Config section "${section.key}" is already registered`);
    }
    this.#sections.set(section.key, section);
    this.#built = undefined;
    return this;
  }

  has(key: string): boolean {
    return this.#sections.has(key);
  }

  get sections(): readonly SectionDefinition[] {
    return [...this.#sections.values()];
  }

  /** Keys environments may override. */
  get overridableKeys(): string[] {
    return this.sections.filter((s) => s.environmentOverride).map((s) => s.key);
  }

  /** Built-in defaults for every registered section. */
  defaults(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const { key, defaults } of this.#sections.values()) {
      const merged = deepMerge(defaults, BUILT_IN_DEFAULTS[key]);
      if (merged !== undefined) out[key] = merged;
    }
    return out;
  }

  schemas(): BuiltSchemas {
    if (this.#built) return this.#built;
    const environmentShape: Record<string, z.ZodType> = { ...environmentBaseShape };
    for (const section of this.sections.filter((s) => s.environmentOverride)) {
      const override =
        section.schema instanceof z.ZodObject ? section.schema.partial() : section.schema;
      environmentShape[section.key] = override
        .optional()
        .describe(`Overrides of "${section.key}" for this environment.`);
    }
    const environment = z.strictObject(environmentShape);
    const configShape: Record<string, z.ZodType> = { version: z.literal(1) };
    for (const section of this.sections) {
      const schema =
        section.key === "environments"
          ? z
              .record(z.string().min(1), environment)
              .describe("Named environments, e.g. local, preview, staging, production.")
          : section.schema;
      configShape[section.key] = section.optional ? schema.optional() : schema;
    }
    this.#built = { environment, config: z.strictObject(configShape) };
    return this.#built;
  }
}

/** A registry with the core sections: project, defaultEnvironment, environments, secrets, run. */
export function createConfigRegistry(): ConfigRegistry {
  return new ConfigRegistry()
    .register({ key: "project", schema: projectSchema })
    .register({ key: "defaultEnvironment", schema: defaultEnvironmentSchema, optional: true })
    .register({ key: "environments", schema: z.record(z.string(), z.unknown()) })
    .register({ key: "secrets", schema: secretsSchema, environmentOverride: true })
    .register({ key: "run", schema: runSchema, environmentOverride: true });
}

/** The registry the loader uses unless one is passed in. */
export const defaultRegistry: ConfigRegistry = createConfigRegistry();

/** Adds a section to the default registry. Call once, at module load of the owning package. */
export function registerSection(section: SectionDefinition): void {
  defaultRegistry.register(section);
}
