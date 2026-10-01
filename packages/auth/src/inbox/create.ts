import type { Config } from "@optestra/config";
import { processEnvSource, type SecretSource, type SecretValue } from "@optestra/config/node";
import type { InboxSettings } from "../section.js";
import { failure } from "./common.js";
import { createMailosaurInbox } from "./mailosaur.js";
import { createMailpitInbox } from "./mailpit.js";
import { createMailslurpInbox } from "./mailslurp.js";
import type { FetchLike } from "./transport.js";
import type { Inbox, InboxFailure } from "./types.js";

export interface CreateInboxOptions {
  /** Where the API keys come from (default: the process environment). */
  sources?: readonly SecretSource[];
  environment?: string | undefined;
  /** Tests pass a fake fetch. */
  fetch?: FetchLike;
  /** Mailpit poll interval (tests). */
  pollMs?: number;
}

export type CreatedInbox = { ok: true; inbox: Inbox } | InboxFailure;

function hostMatches(host: string, domain: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return domain.startsWith("*.") ? name.endsWith(domain.slice(1).toLowerCase()) : name === domain;
}

/**
 * An inbox key from the secret sources. A `keySecret` not declared under
 * `secrets:` may only be sent to the provider's own host (as for model keys); a
 * declared one must list that host in its domains.
 */
export function resolveInboxKey(
  config: Pick<Config, "secrets">,
  keySecret: string,
  baseUrl: string,
  options: CreateInboxOptions = {},
): { ok: true; key: SecretValue } | InboxFailure {
  const sources = options.sources ?? [processEnvSource()];
  let found: SecretValue | undefined;
  for (const source of sources) {
    found = source.get(keySecret, options.environment);
    if (found) break;
  }
  if (!found) {
    return failure(
      "unauthorized",
      `The inbox API key ${keySecret} is not set.`,
      `Set ${keySecret} (environment variable or .env).`,
    );
  }
  const host = new URL(baseUrl).host;
  const declared = config.secrets?.[keySecret];
  if (declared && !declared.domains.some((domain) => hostMatches(host, domain))) {
    return failure(
      "unauthorized",
      `Secret ${keySecret} may not be sent to ${host} (its domains: ${declared.domains.join(", ")}).`,
      `Add ${host.replace(/:\d+$/, "")} to secrets.${keySecret}.domains.`,
    );
  }
  return { ok: true, key: found };
}

/** The configured inbox, or a typed reason there is none. Makes no network call. */
export function createInbox(
  config: Pick<Config, "secrets"> & { inbox: InboxSettings },
  options: CreateInboxOptions = {},
): CreatedInbox {
  const settings = config.inbox;
  switch (settings.provider) {
    case "none":
      return failure(
        "not_configured",
        "No test inbox is configured (inbox.provider is none).",
        "Set inbox.provider to mailpit, mailosaur or mailslurp in the project file.",
      );
    case "mailpit":
      return {
        ok: true,
        inbox: createMailpitInbox({
          url: settings.mailpit.url,
          domain: settings.mailpit.domain,
          ...(options.fetch && { fetch: options.fetch }),
          ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
        }),
      };
    case "mailosaur": {
      const s = settings.mailosaur;
      if (!s.serverId) {
        return failure(
          "not_configured",
          "inbox.mailosaur.serverId is not set.",
          "Set inbox.mailosaur.serverId to the server id shown in the Mailosaur dashboard.",
        );
      }
      const key = resolveInboxKey(config, s.keySecret, s.baseUrl, options);
      if (!key.ok) return key;
      return {
        ok: true,
        inbox: createMailosaurInbox({
          baseUrl: s.baseUrl,
          serverId: s.serverId,
          key: key.key,
          keySecret: s.keySecret,
          ...(options.fetch && { fetch: options.fetch }),
        }),
      };
    }
    case "mailslurp": {
      const s = settings.mailslurp;
      const key = resolveInboxKey(config, s.keySecret, s.baseUrl, options);
      if (!key.ok) return key;
      return {
        ok: true,
        inbox: createMailslurpInbox({
          baseUrl: s.baseUrl,
          ...(s.inboxId && { inboxId: s.inboxId }),
          key: key.key,
          keySecret: s.keySecret,
          ...(options.fetch && { fetch: options.fetch }),
        }),
      };
    }
  }
}

/**
 * The domain for {{unique.email}} / {{faker.email}} when an inbox is configured
 * (ENV-3): pass it as `emailDomain` to `expandTest`. Undefined = keep the default.
 */
export function inboxEmailDomain(settings: InboxSettings): string | undefined {
  switch (settings.provider) {
    case "mailpit":
      return settings.mailpit.domain;
    case "mailosaur":
      return settings.mailosaur.serverId
        ? `${settings.mailosaur.serverId}.mailosaur.net`
        : undefined;
    default:
      return undefined;
  }
}
