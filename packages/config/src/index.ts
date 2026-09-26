/**
 * Browser-safe entry: schema, types, defaults, merge, diagnostics and JSON Schema.
 * File access, `.env` files, secrets and the redactor live in `@testament/config/node`.
 */
export { BUILT_IN_DEFAULTS } from "./defaults.generated.js";
export {
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  hasErrors,
  type Severity,
} from "./diagnostics.js";
export { ENV_PREFIX, ENVIRONMENT_VAR, type EnvVarBinding, envVarBindings } from "./env-vars.js";
export { configJsonSchema } from "./json-schema.js";
export {
  type ConfigSource,
  type Layer,
  mergeLayers,
  type Provenance,
  SOURCE_ORDER,
} from "./merge.js";
export { deepMerge, formatPath, getAt, isPlainObject, type Path } from "./paths.js";
export {
  type BuiltSchemas,
  ConfigRegistry,
  createConfigRegistry,
  defaultRegistry,
  registerSection,
  type SectionDefinition,
} from "./registry.js";
export {
  type ResolvedProject,
  type ResolveOptions,
  resolveConfig,
  type SelectedEnvironment,
} from "./resolve.js";
export {
  CONFIG_VERSION,
  type Config,
  type ConfigPatch,
  type ConfigSections,
  type DeepPartial,
  domainSchema,
  type EnvironmentSettings,
  httpUrlSchema,
  type ProjectSettings,
  projectSchema,
  type RunOptions,
  type RunSettings,
  runSchema,
  SECRET_NAME,
  type SecretDeclaration,
  secretDeclarationSchema,
  secretsSchema,
} from "./schema.js";
