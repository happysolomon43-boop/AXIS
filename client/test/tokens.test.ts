import { expect, test } from "vitest";
import tokenCss from "../src/styles/tokens.css?raw";
import baseCss from "../src/styles/base.css?raw";
import entry from "../src/main.tsx?raw";

const themes = [':root, :root[data-theme="light"]', ':root[data-theme="dark"]', ':root[data-theme="sepia"]'];
const themeTokens = [
  ["ax-color-surface-shell", "#ECEBE6", "#0B0C0E", "#D8CAAD"],
  ["ax-color-surface-raised", "#FCFCFA", "#0E1012", "#F6EEDD"],
  ["ax-color-border-hair", "#D3D1CA", "#26292D", "#BFAF8F"],
  ["ax-color-border-leaf", "#A3A29C", "#45494E", "#968A6E"],
  ["ax-color-border-control", "#7E8186", "#72757A", "#7A6D55"],
  ["ax-color-text-primary", "#1B1C1E", "#D9D6CD", "#2B2418"],
  ["ax-color-text-secondary", "#4A4D52", "#A9A79F", "#4F4636"],
  ["ax-color-text-tertiary", "#62656A", "#94938E", "#594F3D"],
  ["ax-color-presence", "#B26F06", "#F0B24A", "#9A5C00"],
  ["ax-color-presence-tint", "#F4DFB0", "#5A4520", "#E8C77A"],
  ["ax-color-pencil", "#2D5F8B", "#7FB0DE", "#1F4F7A"],
  ["ax-color-pencil-tint", "#DCE7F2", "#1B2733", "#C8D0D2"],
  ["ax-color-severity-break", "#B42318", "#F2766B", "#A31F14"],
  ["ax-color-scrim-light", "rgba(27,28,30,.08)", "rgba(0,0,0,.10)", "rgba(43,36,24,.08)"],
  ["ax-color-scrim-firm", "rgba(27,28,30,.32)", "rgba(0,0,0,.55)", "rgba(43,36,24,.38)"],
  ["ax-opacity-dim-focus", "0.72", "0.6", "0.72"],
  ["ax-shadow-overlay", "0 8px 24px -8px rgba(0,0,0,.24)", "0 8px 24px -8px rgba(0,0,0,.55)", "0 8px 24px -8px rgba(0,0,0,.24)"],
  ["ax-shadow-popover", "0 6px 20px -6px rgba(0,0,0,.22)", "0 6px 20px -6px rgba(0,0,0,.55)", "0 6px 20px -6px rgba(0,0,0,.22)"],
  ["ax-shadow-dialog", "0 16px 40px -12px rgba(0,0,0,.30)", "0 16px 40px -12px rgba(0,0,0,.55)", "0 16px 40px -12px rgba(0,0,0,.30)"],
  ["ax-button-primary-bg", "var(--ax-color-text-primary)", "var(--ax-color-surface-raised)", "var(--ax-color-text-primary)"],
  ["ax-button-primary-fg", "var(--ax-color-surface-raised)", "var(--ax-color-text-primary)", "var(--ax-color-surface-raised)"],
  ["ax-button-primary-border-width", "0px", "2px", "0px"],
];
const defaultTokens = `
  --ax-color-focus: var(--ax-color-text-primary);
  --ax-color-progress: var(--ax-color-border-control);
  --ax-focus-gap: var(--ax-color-surface-shell);
  --ax-tint-hover: color-mix(in srgb, var(--ax-color-text-primary) 6%, transparent);
  --ax-tint-pressed: color-mix(in srgb, var(--ax-color-text-primary) 14%, transparent);
  --ax-type-family-chrome: "Atkinson Hyperlegible Next", system-ui, sans-serif;
  --ax-type-family-mono: "Atkinson Hyperlegible Mono", ui-monospace, monospace;
  --ax-type-tag-size: 12px;
  --ax-type-tag-lh: 16px;
  --ax-type-tag-weight: 600;
  --ax-type-tag-tracking: 0.08em;
  --ax-type-mono-size: 12px;
  --ax-type-mono-lh: 16px;
  --ax-type-mono-weight: 400;
  --ax-type-mono-tracking: 0.01em;
  --ax-type-caption-size: 12px;
  --ax-type-caption-lh: 16px;
  --ax-type-caption-weight: 400;
  --ax-type-caption-tracking: 0.01em;
  --ax-type-small-size: 13px;
  --ax-type-small-lh: 18px;
  --ax-type-small-weight: 400;
  --ax-type-small-tracking: 0;
  --ax-type-body-size: 14px;
  --ax-type-body-lh: 20px;
  --ax-type-body-weight: 400;
  --ax-type-body-tracking: 0;
  --ax-type-label-size: 14px;
  --ax-type-label-lh: 20px;
  --ax-type-label-weight: 600;
  --ax-type-label-tracking: 0;
  --ax-type-lead-size: 16px;
  --ax-type-lead-lh: 24px;
  --ax-type-lead-weight: 400;
  --ax-type-lead-tracking: 0;
  --ax-type-title-s-size: 16px;
  --ax-type-title-s-lh: 22px;
  --ax-type-title-s-weight: 600;
  --ax-type-title-s-tracking: 0;
  --ax-type-title-size: 20px;
  --ax-type-title-lh: 26px;
  --ax-type-title-weight: 600;
  --ax-type-title-tracking: -0.01em;
  --ax-type-title-l-size: 28px;
  --ax-type-title-l-lh: 34px;
  --ax-type-title-l-weight: 600;
  --ax-type-title-l-tracking: -0.01em;
  --ax-space-1: 2px;
  --ax-space-2: 4px;
  --ax-space-3: 8px;
  --ax-space-4: 12px;
  --ax-space-5: 16px;
  --ax-space-6: 24px;
  --ax-space-7: 32px;
  --ax-space-8: 48px;
  --ax-space-9: 64px;
  --ax-space-10: 96px;
  --ax-radius-0: 0px;
  --ax-radius-1: 3px;
  --ax-radius-2: 5px;
  --ax-radius-3: 8px;
  --ax-radius-4: 10px;
  --ax-radius-pill: 999px;
  --ax-z-base: 0;
  --ax-z-shell: 10;
  --ax-z-overlay: 30;
  --ax-z-popover: 40;
  --ax-z-dialog: 50;
  --ax-z-toast: 60;
  --ax-z-palette: 65;
  --ax-z-tooltip: 70;
  --ax-size-strip: 48px;
  --ax-size-binder: 264px;
  --ax-size-binder-min: 220px;
  --ax-size-binder-max: 360px;
  --ax-size-drawer: 380px;
  --ax-size-popover: 320px;
  --ax-size-dialog: 560px;
  --ax-size-search: 560px;
  --ax-size-page-header: 56px;
  --ax-size-page-body-max: 880px;
  --ax-size-gutter: 24px;
  --ax-size-status-line: 28px;
  --ax-size-row: 32px;
  --ax-size-row-touch: 44px;
  --ax-size-binder-rail: 56px;
  --ax-size-binder-numeral: 28px;
  --ax-size-hit-min: 24px;
  --ax-size-hit-touch: 44px;
  --ax-size-onboarding: 480px;
  --ax-size-button-wide: 160px;
  --ax-bp-wide: 1360px;
  --ax-bp-desktop: 1024px;
  --ax-bp-tablet: 768px;
  --ax-opacity-disabled: 0.4;
  --ax-opacity-wash: 0.14;
  --ax-opacity-current-line: 0.06;
  --ax-opacity-stale-card: 0.7;
  --ax-opacity-apocrypha: 0.6;
  --ax-opacity-primary-hover: 0.92;
  --ax-opacity-primary-pressed: 0.86;
  --ax-dur-press: 80ms;
  --ax-dur-hover: 120ms;
  --ax-dur-chip: 180ms;
  --ax-dur-exit: 160ms;
  --ax-dur-enter: 220ms;
  --ax-dur-page: 200ms;
  --ax-dur-drawer-in: 240ms;
  --ax-dur-drawer-out: 180ms;
  --ax-dur-slow: 600ms;
  --ax-dur-lamp: 420ms;
  --ax-dur-lamp-up: 240ms;
  --ax-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ax-ease-in: cubic-bezier(0.7, 0, 0.84, 1);
  --ax-ease-state: cubic-bezier(0.4, 0, 0.2, 1);
  --ax-dwell-tooltip: 500ms;
  --ax-dwell-note: 6000ms;
  --ax-dwell-title: 2000ms;
  --ax-dwell-name: 400ms;
`;
const expectedBase = `
*, *::before, *::after { box-sizing: border-box; }
html, body, #root { block-size: 100%; }
body {
  margin: 0;
  background-color: var(--ax-color-surface-shell);
  color: var(--ax-color-text-primary);
  font-family: var(--ax-type-family-chrome);
  font-size: var(--ax-type-body-size);
  line-height: var(--ax-type-body-lh);
  font-weight: var(--ax-type-body-weight);
}
[hidden] { display: none !important; }
:focus-visible, .ax-input:focus {
  outline: 2px solid var(--ax-color-focus);
  outline-offset: 2px;
  box-shadow: 0 0 0 2px var(--ax-focus-gap);
}
[aria-disabled="true"] { opacity: var(--ax-opacity-disabled); cursor: default; }
.ax-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--ax-space-3);
  block-size: 32px;
  padding-inline: var(--ax-space-4);
  border: 1px solid transparent;
  border-radius: var(--ax-radius-2);
  background-color: transparent;
  color: var(--ax-color-text-primary);
  font-family: inherit;
  font-size: var(--ax-type-label-size);
  line-height: var(--ax-type-label-lh);
  font-weight: var(--ax-type-label-weight);
  cursor: pointer;
  transition: background-color var(--ax-dur-hover) var(--ax-ease-state);
}
.ax-button--wide { min-inline-size: var(--ax-size-button-wide); }
.ax-button--primary {
  background-color: var(--ax-button-primary-bg);
  color: var(--ax-button-primary-fg);
  border: var(--ax-button-primary-border-width) solid var(--ax-color-text-primary);
}
.ax-button--primary:hover:not([aria-disabled="true"]) { opacity: var(--ax-opacity-primary-hover); }
.ax-button--primary:active:not([aria-disabled="true"]) { opacity: var(--ax-opacity-primary-pressed); }
.ax-button--secondary { border: 1px solid var(--ax-color-border-control); }
.ax-button--secondary:hover:not([aria-disabled="true"]) { background-color: var(--ax-tint-hover); }
.ax-button--secondary:active:not([aria-disabled="true"]) { background-color: var(--ax-tint-pressed); }
.ax-button--quiet:hover:not([aria-disabled="true"]) { background-color: var(--ax-tint-hover); }
.ax-button--quiet:active:not([aria-disabled="true"]) { background-color: var(--ax-tint-pressed); }
.ax-input {
  inline-size: 100%;
  block-size: 32px;
  padding-inline: var(--ax-space-3);
  border: 1px solid var(--ax-color-border-control);
  border-radius: var(--ax-radius-2);
  background-color: var(--ax-color-surface-raised);
  color: var(--ax-color-text-primary);
  caret-color: var(--ax-color-text-primary);
  font-family: inherit;
  font-size: var(--ax-type-body-size);
  line-height: var(--ax-type-body-lh);
}
.ax-field { display: flex; flex-direction: column; gap: var(--ax-space-2); }
.ax-field-label {
  font-size: var(--ax-type-caption-size);
  line-height: var(--ax-type-caption-lh);
  color: var(--ax-color-text-secondary);
}
.ax-field-message {
  display: flex;
  align-items: center;
  gap: var(--ax-space-3);
  margin: var(--ax-space-2) 0 0;
  font-size: var(--ax-type-caption-size);
  line-height: var(--ax-type-caption-lh);
  color: var(--ax-color-text-primary);
}
.ax-glyph-square {
  display: inline-block;
  flex: none;
  inline-size: 8px;
  block-size: 8px;
  background-color: var(--ax-color-text-primary);
}
.ax-status {
  margin: 0;
  font-size: var(--ax-type-body-size);
  line-height: var(--ax-type-body-lh);
  color: var(--ax-color-text-primary);
}
.ax-reading-rule {
  display: block;
  block-size: 1px;
  margin-block-start: var(--ax-space-2);
  background-image: repeating-linear-gradient(90deg, var(--ax-color-progress) 0, var(--ax-color-progress) 4px, transparent 4px, transparent 7px);
}
.ax-axis-motif { display: block; color: var(--ax-color-text-tertiary); }
.ax-glyph, .ax-chevron, .ax-mark { flex: none; }
@media (pointer: coarse) { .ax-button, .ax-input { block-size: var(--ax-size-hit-touch); } }
@media (max-width: 767px) { .ax-input { font-size: 16px; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}

/* The opening retry blends its colours, not its focus ring, and grows with text. */
.ax-button.ax-opening__retry { block-size: auto; }
.ax-button.ax-opening__retry[aria-disabled="true"] { opacity: 1; }
.ax-button.ax-opening__retry:active:not([aria-disabled="true"]) { transition-duration: var(--ax-dur-press); }

/* The D18 menu and strip blend ink without dimming the focus outline. */
.ax-binder__menu-item[aria-disabled="true"],
.ax-button.ax-binder__pullback-check[aria-disabled="true"] { opacity: 1; }
.ax-button.ax-binder__menu-trigger,
.ax-button.ax-binder__pullback-check { transition: none; }
.ax-button.ax-binder__pullback-check { justify-content: flex-start; }
.ax-binder__menu-item:focus,
.ax-button.ax-binder__pullback-check:focus { box-shadow: none; }
`;

function readDeclarations(css: string) {
  return Object.fromEntries(
    [...css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
  );
}

function readTheme(selector: string) {
  const start = tokenCss.indexOf(selector + " {");
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const end = tokenCss.indexOf("\n}", start);
  return tokenCss.slice(start, end);
}

test("AXB-0035 AC1 declares the exact design tokens for all three themes", () => {
  themes.forEach((selector, index) => {
    const theme = readTheme(selector);
    const expected = Object.fromEntries(themeTokens.map(([name, ...values]) => [`--${name}`, values[index]]));
    if (index === 0) Object.assign(expected, readDeclarations(defaultTokens));
    const actual = readDeclarations(theme);
    for (const [name, value] of Object.entries(actual)) {
      if (value.startsWith("#")) actual[name] = value.toLowerCase();
    }
    for (const [name, value] of Object.entries(expected)) {
      if (value.startsWith("#")) expected[name] = value.toLowerCase();
    }
    expect(actual).toEqual(expected);
    expect(theme).toMatch(new RegExp(`color-scheme:\\s*${index === 1 ? "dark" : "light"};`));
  });
  const phone = tokenCss.slice(tokenCss.indexOf("@media (max-width: 767px)"));
  expect(readDeclarations(phone)).toEqual({
    "--ax-type-body-size": "15px",
    "--ax-type-body-lh": "22px",
  });
  expect(tokenCss).not.toMatch(/--ax-(page|mark|tick)-/);
});

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("AXB-0035 AC2 meets every contrast floor and applies the exact base styles", () => {
  for (const selector of themes) {
    const tokens = readDeclarations(readTheme(selector));
    const pairs = [
      ["color-text-primary", "color-surface-shell", 7],
      ["color-text-secondary", "color-surface-shell", 4.5],
      ["color-text-tertiary", "color-surface-shell", 4.5],
      ["color-text-tertiary", "color-surface-raised", 4.5],
      ["color-border-control", "color-surface-shell", 3],
      ["color-border-control", "color-surface-raised", 3],
      ["button-primary-fg", "button-primary-bg", 7],
    ] as const;
    function color(name: string) {
      const value = tokens[`--ax-${name}`];
      return value.startsWith("var(") ? tokens[value.slice(4, -1)] : value;
    }
    for (const [foreground, background, minimum] of pairs) {
      expect(contrast(color(foreground), color(background)), `${selector}: ${foreground} on ${background}`)
        .toBeGreaterThanOrEqual(minimum);
    }
  }
  expect(baseCss.replace(/\s+/g, "")).toBe(expectedBase.replace(/\s+/g, ""));
  expect(baseCss).not.toMatch(/outline:\s*(none|0)\s*;/);
  expect(entry).toMatch(/^import ["']\.\/styles\/tokens\.css["'];\s*import ["']\.\/styles\/base\.css["'];/);
});
