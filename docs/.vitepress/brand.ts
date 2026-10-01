import { brand } from "@optestra/brand";
import { ENV_PREFIX } from "@optestra/config";

/*
 * The docs never write the product's names: pages use these placeholders and the
 * build fills them in from the engine's brand.json, so a rename is one edit there.
 *
 *   %Name%     product name            %cli%      CLI command
 *   %scope%    npm scope               %config%   project file name
 *   %dataDir%  local data folder       %ENV%      environment variable prefix
 *   %Desktop%  desktop app name        %Web%      web app name
 *   %domain%   the product's domain    %repo%     the engine's GitHub repository
 */

/** The engine's GitHub repository (owner/name). Not a brand.json field: it only changes by moving the repo. */
export const REPO = "optestra/optestra";

export const BRAND_TOKENS: Readonly<Record<string, string>> = {
  "%Name%": brand.productName,
  "%cli%": brand.cliName,
  "%scope%": brand.npmScope,
  "%config%": brand.configFileName,
  "%dataDir%": brand.dataDirName,
  "%ENV%": ENV_PREFIX,
  "%Desktop%": brand.desktopAppName,
  "%Web%": brand.webAppName,
  "%domain%": brand.domain,
  "%repo%": REPO,
};

const TOKEN = /%(?:Name|cli|scope|config|dataDir|ENV|Desktop|Web|domain|repo)%/g;

/** Fills in every brand placeholder. */
export function brandText(text: string): string {
  return text.replace(TOKEN, (token) => BRAND_TOKENS[token] ?? token);
}

/** Writes brand values back as placeholders (for generated pages). Longest values first. */
export function toBrandTokens(text: string): string {
  const pairs = Object.entries(BRAND_TOKENS)
    .filter(([token]) => token !== "%repo%")
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [token, value] of pairs) {
    // Whole words only (a prefix like "X_" may run into the next word).
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const end = /\w$/.test(value) ? "(?![\\w])" : "";
    out = out.replace(new RegExp(`(?<![\\w-])${escaped}${end}`, "g"), token);
  }
  return out;
}
