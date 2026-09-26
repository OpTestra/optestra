import { registerSecretType, type SecretTypeDefinition } from "@testament/config/node";
import "./section.js";
import { freshTotp, parseTotpSeed } from "./totp.js";

/**
 * The `totp` secret type (SEC-4): `secrets: { ADMIN_TOTP: { domains: [...], type: totp } }`.
 * The stored value is the seed; typing `{{secret.ADMIN_TOTP}}` types the code of that
 * moment (the browser calls `prepareSecret` right before the fill). Every code is
 * registered with the redactor before it is typed.
 */
export const totpSecretType: SecretTypeDefinition = {
  type: "totp",
  check(stored) {
    const parsed = parseTotpSeed(stored);
    if (!parsed.ok) {
      return {
        ok: false,
        problem: parsed.problem,
        fix: "Set the value to the base32 seed (the text under the QR code) or the full otpauth://totp/… URI.",
      };
    }
    const { base32 } = parsed.seed;
    const compact = base32.replace(/[\s-]/g, "").replace(/=+$/, "");
    return { ok: true, sensitive: [base32, compact.toUpperCase(), compact.toLowerCase()] };
  },
  producer({ config }) {
    const minRemainingSeconds = config.auth?.totp?.minRemainingSeconds ?? 5;
    return async (stored) => {
      const parsed = parseTotpSeed(stored);
      // check() ran when the secret was resolved; this can't fail for the same value.
      if (!parsed.ok) throw new Error(`TOTP seed became invalid: ${parsed.problem}`);
      return freshTotp(parsed.seed, { minRemainingSeconds });
    };
  },
};

registerSecretType(totpSecretType);
