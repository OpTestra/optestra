// A custom browser size (TGT-3): `--viewport 1280x720` or `{ width, height }`.

export const VIEWPORT_LIMITS = { min: 200, max: 7680 } as const;

export type ViewportCheck =
  | { ok: true; viewport: { width: number; height: number } }
  | { ok: false; message: string };

/** Parses "1280x720" (also "1280×720", "1280,720") or checks an object: whole pixels, 200–7680 each. */
export function parseViewport(value: string | { width: number; height: number }): ViewportCheck {
  let width: number;
  let height: number;
  if (typeof value === "string") {
    const match = /^\s*(\d+)\s*[x×,]\s*(\d+)\s*$/i.exec(value);
    if (!match)
      return {
        ok: false,
        message: `The viewport "${value}" isn't a size like 1280x720 (width x height, in pixels).`,
      };
    width = Number(match[1]);
    height = Number(match[2]);
  } else {
    width = value.width;
    height = value.height;
  }
  const { min, max } = VIEWPORT_LIMITS;
  for (const [name, n] of [
    ["width", width],
    ["height", height],
  ] as const)
    if (!Number.isInteger(n) || n < min || n > max)
      return {
        ok: false,
        message: `The viewport ${name} must be a whole number of pixels from ${min} to ${max}, not ${n}.`,
      };
  return { ok: true, viewport: { width, height } };
}
