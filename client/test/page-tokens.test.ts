import { expect, test } from "vitest";
import page from "../src/styles/page.css?raw";
import tokens from "../src/styles/tokens.css?raw";

const pairs = [
  ["literary", "light", "#F8F8F6", "#1E1F21", 15.5], ["literary", "dark", "#17181A", "#D4D0C6", 11.5], ["literary", "sepia", "#EDE3CE", "#382F24", 10.3],
  ["modern", "light", "#FCFCFD", "#17191C", 17.2], ["modern", "dark", "#0F1113", "#DDE0E3", 14.3], ["modern", "sepia", "#F0E6D6", "#33291F", 11.5],
  ["warm", "light", "#FBF8F2", "#2A2622", 14.2], ["warm", "dark", "#1C1916", "#E0D6C6", 12.2], ["warm", "sepia", "#E9DCC1", "#2F261B", 10.9],
] as const;
const profiles = {
  literary: ["19px", "1.55", "400", "0", "30em", "1.4em", "0", "1.55em", '"Newsreader", Georgia, serif'],
  modern: ["17px", "1.75", "400", "0", "28em", "0", "0.7em", "1.75em", '"Atkinson Hyperlegible", system-ui, sans-serif'],
  warm: ["19px", "1.62", "400", "0", "34em", "0", "1em", "2.4em", '"Literata", Georgia, serif'],
};
const dark = { literary: { lh: "1.60", weight: "380", tracking: "0.01em" }, modern: { lh: "1.80", tracking: "0.01em" }, warm: { lh: "1.67", weight: "380" } };
const colors = {
  "surface-shell": ["#ECEBE6", "#0B0C0E", "#D8CAAD"], "surface-raised": ["#FCFCFA", "#0E1012", "#F6EEDD"],
  "border-hair": ["#D3D1CA", "#26292D", "#BFAF8F"], "border-leaf": ["#A3A29C", "#45494E", "#968A6E"],
  "text-primary": ["#1B1C1E", "#D9D6CD", "#2B2418"], "text-secondary": ["#4A4D52", "#A9A79F", "#4F4636"],
  presence: ["#B26F06", "#F0B24A", "#9A5C00"], "presence-tint": ["#F4DFB0", "#5A4520", "#E8C77A"],
  "pencil-tint": ["#DCE7F2", "#1B2733", "#C8D0D2"], "severity-break": ["#B42318", "#F2766B", "#A31F14"],
};
function declarations(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const block = css.slice(start + selector.length + 2, css.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
}
function luminance(hex: string) {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
}
function ratio(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }

test("AXB-0039 AC3 checks exact page and existing tokens and published rounded contrast requirements", () => {
  const names = ["size", "lh", "weight", "tracking", "measure", "indent", "gap", "break-space", "family"];
  for (const [name, values] of Object.entries(profiles)) {
    expect(declarations(page, `.ax-leaf[data-profile="${name}"]`)).toEqual(Object.fromEntries(names.map((n, i) => [`--ax-page-${n}`, values[i]])));
  }
  for (const [name, theme, paper, ink, floor] of pairs) {
    const actual = declarations(page, `.ax-leaf[data-profile="${name}"][data-theme="${theme}"]`);
    const overrides = theme === "dark" ? Object.fromEntries(Object.entries(dark[name]).map(([k, v]) => [`--ax-page-${k}`, v])) : {};
    expect(actual).toEqual({ "--ax-page-paper": paper, "--ax-page-ink": ink, ...overrides });
    // BC-9's published values are rounded to the nearest tenth, not truncated.
    const actualRatio = ratio(paper, ink);
    expect.soft(actualRatio, `${name} ${theme} absolute contrast`).toBeGreaterThanOrEqual(4.5);
    expect.soft(Math.round(actualRatio * 10) / 10, `${name} ${theme}`).toBeGreaterThanOrEqual(floor);
  }
  for (const [i, theme] of ["light", "dark", "sepia"].entries()) {
    const actual = declarations(tokens, theme === "light" ? ':root, :root[data-theme="light"]' : `:root[data-theme="${theme}"]`);
    for (const [name, values] of Object.entries(colors)) expect(actual[`--ax-color-${name}`]).toBe(values[i]);
  }
  const base = declarations(tokens, ':root, :root[data-theme="light"]');
  for (const [key, value] of Object.entries({ "size-strip": "48px", "size-status-line": "28px", "space-2": "4px", "space-3": "8px", "space-6": "24px", "space-8": "48px", "space-10": "96px", "radius-0": "0px", "radius-1": "3px", "z-shell": "10", "dur-chip": "180ms", "dur-hover": "120ms", "ease-state": "cubic-bezier(0.4, 0, 0.2, 1)", "opacity-disabled": "0.4", "color-focus": "var(--ax-color-text-primary)", "tint-hover": "color-mix(in srgb, var(--ax-color-text-primary) 6%, transparent)", "tint-pressed": "color-mix(in srgb, var(--ax-color-text-primary) 14%, transparent)", "bp-tablet": "768px" })) expect(base[`--ax-${key}`]).toBe(value);
  for (const step of ["caption", "small", "body"]) for (const property of ["size", "lh", "tracking"]) expect(base[`--ax-type-${step}-${property}`]).toBeDefined();
  expect(declarations(page, ":root")).toEqual({ "--ax-size-leaf-pad": "48px", "--ax-size-banner": "40px" });
  for (const [, key] of page.matchAll(/(--[\w-]+):/g)) expect(tokens).not.toContain(`${key}:`);
  expect(page).not.toContain("@font-face");
});
