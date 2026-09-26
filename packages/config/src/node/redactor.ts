function utf8Base64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The forms a secret commonly takes in logs, URLs, headers and JSON. */
export function secretVariants(value: string): string[] {
  const base64 = utf8Base64(value);
  const variants = [
    value,
    encodeURIComponent(value),
    encodeURIComponent(value).replace(/%20/g, "+"),
    JSON.stringify(value).slice(1, -1),
    base64,
    base64.replace(/=+$/, ""),
    base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  ];
  return [...new Set(variants)].filter((variant) => variant.length > 0);
}

/**
 * Scrubs registered secret values (raw, URL-encoded, form-encoded, JSON-escaped
 * and base64/base64url) from strings. Longest matches win.
 */
export class Redactor {
  readonly #labels = new Map<string, string>();
  #pattern: RegExp | undefined;

  /** Registers a secret value; every later `redact` replaces it with `label`. */
  register(value: string, label = "[redacted]"): void {
    if (value === "") return;
    for (const variant of secretVariants(value)) {
      if (!this.#labels.has(variant)) this.#labels.set(variant, label);
    }
    this.#pattern = undefined;
  }

  get size(): number {
    return this.#labels.size;
  }

  redact(text: string): string {
    if (this.#labels.size === 0 || text === "") return text;
    if (!this.#pattern) {
      const needles = [...this.#labels.keys()]
        .sort((a, b) => b.length - a.length)
        .map((needle) => needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      this.#pattern = new RegExp(needles.join("|"), "g");
    }
    return text.replace(this.#pattern, (match) => this.#labels.get(match) ?? "[redacted]");
  }
}

/** Process-wide redactor. Every loaded secret is registered here; the engine logger uses it. */
export const defaultRedactor: Redactor = new Redactor();
