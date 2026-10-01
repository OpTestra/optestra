/**
 * Node entry: project files, YAML, `.env` files, secrets and the redactor.
 * The raw value of a secret is only available from `@optestra/config/reveal`.
 */
export { type DotenvResult, parseDotenv, readDotenvFile } from "./dotenv.js";
export {
  createLogger,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  logger,
} from "./logger.js";
export {
  applyPatch,
  type CreateProjectOptions,
  type CreateProjectResult,
  createProject,
  findProject,
  type LoadedProject,
  type LoadProjectOptions,
  loadProject,
  projectFile,
  type SaveResult,
  saveProject,
} from "./project.js";
export { defaultRedactor, Redactor, secretVariants } from "./redactor.js";
export {
  registerSecretType,
  type SecretTypeCheck,
  type SecretTypeDefinition,
  secretType,
} from "./secret-types.js";
export {
  asDynamicSecret,
  type CreateSecretOptions,
  createSecretValue,
  type SecretProducer,
  SecretValue,
} from "./secret-value.js";
export {
  dotenvSource,
  memorySource,
  processEnvSource,
  type ResolvedSecrets,
  type ResolveSecretsOptions,
  resolveSecrets,
  type SecretSource,
} from "./secrets.js";
export { type ParsedYaml, parseYaml } from "./yaml-file.js";
export {
  execPathIsNode,
  isNodeScript,
  type NodeRuntime,
  nodeOnPath,
  nodeRuntime,
} from "./node-runtime.js";
