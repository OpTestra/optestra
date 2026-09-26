// The Inbox interface (SEC-5). Adapters: Mailpit, Mailosaur, MailSlurp. Nothing here
// throws for inbox trouble: misses come back typed, and later become Blocked.

export interface InboxMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  /** Plain-text body ("" when the email only has HTML). */
  text: string;
  /** HTML body ("" when the email is plain text). */
  html: string;
  /** ISO time the inbox received it. */
  receivedAt: string;
}

/**
 * Why no message (or value) came back:
 * - timeout: nothing matching arrived in time
 * - unauthorized: the API key is missing, wrong or not allowed on this host
 * - unavailable: the inbox service can't be reached or is failing
 * - not_configured: `inbox.provider` is none, or a required setting is missing
 * - bad_response: the service answered with something unexpected
 * - aborted: the caller cancelled
 */
export type InboxFailureReason =
  | "timeout"
  | "unauthorized"
  | "unavailable"
  | "not_configured"
  | "bad_response"
  | "aborted";

export interface InboxFailure {
  ok: false;
  reason: InboxFailureReason;
  /** Safe to show: never contains a key or a message body. */
  message: string;
  fix?: string;
}

export type InboxResult<T> = ({ ok: true } & T) | InboxFailure;

export interface WaitForMessageOptions {
  /** The recipient address. */
  to: string;
  subjectContains?: string;
  /** Only messages received at or after this time (a little clock skew is allowed). */
  since: Date;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface InboxCheck {
  ok: boolean;
  provider: string;
  /** Host every request goes to. */
  host: string;
  status: "ok" | InboxFailureReason;
  message: string;
  fix?: string;
}

export interface Inbox {
  readonly provider: "mailpit" | "mailosaur" | "mailslurp";
  /** Host every request goes to. */
  readonly host: string;
  /**
   * The domain every address of this inbox has, when there is one fixed domain
   * (Mailpit: the configured domain; Mailosaur: <serverId>.mailosaur.net). Used as
   * the domain of {{unique.email}} (ENV-3). MailSlurp: none (addresses are created).
   */
  readonly emailDomain: string | undefined;
  /** An address this inbox receives. `hint` becomes the local part where the provider allows it. */
  address(hint?: string): Promise<InboxResult<{ address: string }>>;
  /** Waits for the newest matching message. */
  waitForMessage(options: WaitForMessageOptions): Promise<InboxResult<{ message: InboxMessage }>>;
  /** Reachable and key valid. */
  check(): Promise<InboxCheck>;
}

/** Messages received this long before `since` still count (clocks differ). */
export const CLOCK_SKEW_MS = 2000;
