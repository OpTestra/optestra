// The report's whole look: colours, type and spacing. The brand redesign
// replaces this file (or passes its own tokens); nothing else holds a colour.

export interface ColorTokens {
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  code: string;
  passed: string;
  passedBg: string;
  healed: string;
  healedBg: string;
  failed: string;
  failedBg: string;
  flaky: string;
  flakyBg: string;
  blocked: string;
  blockedBg: string;
  warn: string;
  warnBg: string;
}

export interface ReportTokens {
  color: { light: ColorTokens; dark: ColorTokens };
  font: { body: string; mono: string; size: string; small: string; lineHeight: string };
  space: { xs: string; sm: string; md: string; lg: string; xl: string };
  radius: string;
  maxWidth: string;
}

export const defaultTokens: ReportTokens = {
  color: {
    light: {
      background: "#ffffff",
      surface: "#f6f8fa",
      text: "#1f2328",
      muted: "#57606a",
      border: "#d0d7de",
      accent: "#0550ae",
      code: "#eff2f5",
      passed: "#116329",
      passedBg: "#dafbe1",
      healed: "#0550ae",
      healedBg: "#ddf4ff",
      failed: "#a40e26",
      failedBg: "#ffebe9",
      flaky: "#7d4e00",
      flakyBg: "#fff8c5",
      blocked: "#424a53",
      blockedBg: "#eaeef2",
      warn: "#7d4e00",
      warnBg: "#fff8c5",
    },
    dark: {
      background: "#0d1117",
      surface: "#161b22",
      text: "#e6edf3",
      muted: "#9da7b3",
      border: "#30363d",
      accent: "#6cb6ff",
      code: "#1c2128",
      passed: "#7ee2a8",
      passedBg: "#0f2d1c",
      healed: "#9ccbff",
      healedBg: "#0c2d4a",
      failed: "#ffa198",
      failedBg: "#3d1214",
      flaky: "#f2cc60",
      flakyBg: "#332600",
      blocked: "#c9d1d9",
      blockedBg: "#262c34",
      warn: "#f2cc60",
      warnBg: "#332600",
    },
  },
  font: {
    body: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    size: "15px",
    small: "13px",
    lineHeight: "1.5",
  },
  space: { xs: "4px", sm: "8px", md: "12px", lg: "20px", xl: "32px" },
  radius: "6px",
  maxWidth: "1100px",
};

const kebab = (name: string) => name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

function colorVars(colors: ColorTokens): string {
  return Object.entries(colors)
    .map(([name, value]) => `--c-${kebab(name)}:${value};`)
    .join("");
}

/** The tokens as CSS custom properties; the stylesheet only ever reads these. */
export function tokensToCss(tokens: ReportTokens): string {
  const other = [
    `--font-body:${tokens.font.body};`,
    `--font-mono:${tokens.font.mono};`,
    `--font-size:${tokens.font.size};`,
    `--font-small:${tokens.font.small};`,
    `--line-height:${tokens.font.lineHeight};`,
    ...Object.entries(tokens.space).map(([name, value]) => `--s-${name}:${value};`),
    `--radius:${tokens.radius};`,
    `--max-width:${tokens.maxWidth};`,
  ].join("");
  return (
    `:root{color-scheme:light dark;${colorVars(tokens.color.light)}${other}}` +
    `@media (prefers-color-scheme:dark){:root{${colorVars(tokens.color.dark)}}}`
  );
}
