/**
 * Login building blocks (SEC-3, SEC-4, SEC-5): auth profiles with saved sessions,
 * TOTP secrets and test email inboxes. Node only; the pure code/link extraction is
 * also available as `@optestra/auth/extract`.
 *
 * Importing this registers the `auth` and `inbox` config sections and the `totp`
 * secret type. Import it before loading config or resolving secrets.
 */
import "./section.js";
import "./totp-secret.js";

export {
  createInbox,
  type CreatedInbox,
  type CreateInboxOptions,
  inboxEmailDomain,
  resolveInboxKey,
} from "./inbox/create.js";
export {
  type ExtractableMessage,
  type ExtractedLink,
  type ExtractedLinks,
  extractCode,
  extractLinks,
  htmlToText,
  pickLink,
  urlAllowed,
} from "./inbox/extract.js";
export { createMailosaurInbox, type MailosaurOptions } from "./inbox/mailosaur.js";
export { createMailpitInbox, type MailpitOptions } from "./inbox/mailpit.js";
export { createMailslurpInbox, type MailslurpOptions } from "./inbox/mailslurp.js";
export type { FetchLike } from "./inbox/transport.js";
export {
  CLOCK_SKEW_MS,
  type Inbox,
  type InboxCheck,
  type InboxFailure,
  type InboxFailureReason,
  type InboxMessage,
  type InboxResult,
  type WaitForMessageOptions,
} from "./inbox/types.js";
export {
  createInboxValues,
  INBOX_MEMBERS,
  INBOX_SECRET_NAMES,
  InboxValueError,
  inboxSecret,
  type InboxLookup,
  type InboxMember,
  type InboxValue,
  type InboxValueFailureReason,
  type InboxValues,
  type InboxValuesOptions,
} from "./inbox/values.js";
export {
  type AuthDiagnostic,
  type AuthDiagnosticCode,
  checkProfiles,
  checkTestAuth,
  type TestAuth,
  testAuth,
} from "./profiles.js";
export {
  type AuthProfile,
  type AuthSettings,
  authSchema,
  INBOX_PROVIDERS,
  type InboxProvider,
  type InboxSettings,
  inboxSchema,
  PROFILE_NAME,
  type ProfileCheck,
  REUSE_MODES,
  type ReuseMode,
} from "./section.js";
export {
  type EnsureProfileOptions,
  type EnsureResult,
  ensureProfile,
  type LoginRequest,
  type LoginResult,
  profileFingerprint,
  registerStorageState,
  type SavedSession,
  type SessionEntry,
  type SessionKey,
  SessionStore,
  type SessionStoreOptions,
  type StorageState,
  type ValidateRequest,
} from "./session-store.js";
export {
  base32Decode,
  base32Encode,
  type FreshCodeOptions,
  freshTotp,
  hotp,
  msRemaining,
  type ParsedSeed,
  parseTotpSeed,
  TOTP_ALGORITHMS,
  type TotpAlgorithm,
  type TotpSeed,
  totp,
  verifyTotp,
} from "./totp.js";
export { totpSecretType } from "./totp-secret.js";
