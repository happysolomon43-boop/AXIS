import { expect, test } from "vitest";
import styles from "../src/styles/compare.css?raw";
import action from "../src/history/compare-action.css?raw";
import tokens from "../src/styles/tokens.css?raw";
import page from "../src/styles/page.css?raw";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
function block(css: string, selector: string): string {
  css = strip(css);
  const start = css.indexOf(selector + " {");
  if (start < 0) throw new Error(`Missing rule ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 1;
  for (let end = open + 1; end < css.length; end++) {
    if (css[end] === "{") depth++;
    if (css[end] === "}" && --depth === 0) return css.slice(open + 1, end);
  }
  throw new Error(`Unclosed rule ${selector}`);
}
function declarations(css: string, selector: string) {
  return Object.fromEntries(block(css, selector).trim().split(";").filter(line => line.trim()).map(line => {
    const [property, ...value] = line.split(":");
    return [property.trim(), value.join(":").trim()];
  }));
}

const themes = {
  light: ["#ECEBE6", "#1B1C1E", "#4A4D52", "#7E8186"],
  dark: ["#0B0C0E", "#D9D6CD", "#A9A79F", "#72757A"],
  sepia: ["#D8CAAD", "#2B2418", "#4F4636", "#7A6D55"],
} as const;
const papers = {
  literary: [["#F8F8F6", "#1E1F21"], ["#17181A", "#D4D0C6"], ["#EDE3CE", "#382F23"]],
  modern: [["#FCFCFD", "#17191C"], ["#0F1113", "#DDE0E3"], ["#F0E6D6", "#33291F"]],
  warm: [["#FBF8F2", "#2A2622"], ["#1C1916", "#E0D6C6"], ["#E9DCC1", "#2F261B"]],
} as const;
function contrast(first: string, second: string): number {
  function luminance(color: string) {
    const [r, g, b] = color.slice(1).match(/../g)!.map(channel => {
      const c = parseInt(channel, 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("AC1 uses existing design tokens and adds no colours, motion or decorative edges", () => {
  const css = strip(styles + action);
  expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
  expect(css).not.toMatch(/\b(?:transition|animation|transform|scroll-behavior|box-shadow|filter|backdrop-filter|border-inline-start|border-inline-end|border-left|border-right)\s*:/);
  expect(css).not.toMatch(/--ax-color-(?:presence|pencil)|outline:\s*(?:none|0)\s*[;}]/);
  for (const [, variable] of css.matchAll(/var\(--ax-([\w-]+)/g)) {
    expect(variable).toMatch(/^(?:color-(?:text-primary|text-secondary|surface-page|focus|border-hair|border-control)|page-(?:paper|ink|family|size|lh|weight|tracking)|(?:space|size|radius)-[\w-]+|compare-(?:header|measure|text-min|text-max))$/);
  }
});

test("AC2 compares all nine inherited paper pairs and three chrome palettes without rounding", () => {
  for (const [index, [theme, [room, primary, secondary, border]]] of Object.entries(themes).entries()) {
    const actual = declarations(tokens, `:root[data-theme="${theme}"]`);
    expect(actual["--ax-color-surface-shell"]).toBe(room);
    expect(actual["--ax-color-text-primary"]).toBe(primary);
    expect(actual["--ax-color-text-secondary"]).toBe(secondary);
    expect(actual["--ax-color-border-control"]).toBe(border);
    expect(actual["--ax-color-focus"] ?? declarations(tokens, ':root[data-theme="light"]')["--ax-color-focus"])
      .toBe("var(--ax-color-text-primary)");
    expect(contrast(primary, room)).toBeGreaterThanOrEqual(7);
    expect(contrast(secondary, room)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(border, room)).toBeGreaterThanOrEqual(3);
    expect(contrast(primary, room)).toBeGreaterThanOrEqual(3);
    for (const [profile, combinations] of Object.entries(papers)) {
      const [paper, ink] = combinations[index];
      const actual = declarations(page, `.ax-leaf[data-profile="${profile}"][data-theme="${theme}"]`);
      expect(actual["--ax-page-paper"]).toBe(paper);
      expect(actual["--ax-page-ink"]).toBe(ink);
      expect(contrast(primary, paper)).toBeGreaterThanOrEqual(7);
      expect(contrast(ink, paper)).toBeGreaterThanOrEqual(10.3);
      expect(contrast(border, paper)).toBeGreaterThanOrEqual(3);
      expect(contrast(primary, paper)).toBeGreaterThanOrEqual(3);
    }
  }
  expect(declarations(styles, ".ax-compare__select")).toMatchObject({
    color: "var(--ax-color-text-primary)", "background-color": "var(--ax-color-surface-page, var(--ax-page-paper))",
  });
  expect(declarations(styles, ".ax-compare__text")).toMatchObject({
    color: "var(--ax-page-ink)", "background-color": "var(--ax-page-paper)",
  });
});

test("AC3 binds the host, Back and panel geometry and supplies every drawing class", () => {
  expect(declarations(styles, ".ax-compare-host")).toMatchObject({
    "--ax-compare-header": "56px", "--ax-compare-measure": "880px",
    "--ax-compare-text-min": "4rem", "--ax-compare-text-max": "70dvh",
    "container-type": "inline-size", "container-name": "compare",
  });
  expect(declarations(styles, ".ax-compare__panels")).toMatchObject({
    "grid-template-columns": "repeat(2, minmax(0, 1fr))", gap: "var(--ax-space-6)",
  });
  const narrow = block(styles, "@container compare (max-width: 759px)");
  expect(declarations(narrow, ".ax-compare__panels")["grid-template-columns"]).toBe("minmax(0, 1fr)");
  expect(declarations(narrow, ".ax-compare-host__back")["max-inline-size"]).toBe("100%");
  expect(declarations(styles, ".ax-compare-host__back")).toMatchObject({
    "max-inline-size": "40%", "text-decoration-thickness": "1px", "text-underline-offset": "3px",
  });
  expect(declarations(styles, ".ax-compare-host__back:hover")["text-decoration-thickness"]).toBe("2px");
  expect(declarations(styles, ".ax-compare__text")).toMatchObject({
    "min-block-size": "var(--ax-compare-text-min)", "max-block-size": "var(--ax-compare-text-max)",
    padding: "var(--ax-space-5)", border: "1px solid var(--ax-color-border-hair)", "border-radius": "var(--ax-radius-0)",
  });
  expect(declarations(styles, ".ax-compare__source")).toMatchObject({ "white-space": "pre-wrap", "overflow-wrap": "anywhere" });
  expect(declarations(action, ".ax-history__compare")["min-inline-size"]).toBe("22ch");
  for (const part of ["column", "heading", "controls", "field", "label", "select", "swap", "retry",
    "reading", "failure", "one", "panels", "panel", "chip", "key", "chip-label", "text", "source", "empty"]) {
    expect(styles).toContain(".ax-compare__" + part);
  }
  expect(styles).toContain(".ax-compare-host__header");
  expect(action).toContain(".ax-history__compare-reason");
});

test("AC4 binds touch, phone, forced colours and the full contrast inert focus ring", () => {
  expect(declarations(block(styles, "@media (forced-colors: active)"), ".ax-compare__text")).toMatchObject({
    border: "1px solid CanvasText", "background-color": "Canvas",
  });
  const coarse = block(styles, "@media (pointer: coarse)");
  expect(coarse).toMatch(/\.ax-compare-host__back,\s*\.ax-compare__select,\s*\.ax-compare__swap,\s*\.ax-compare__retry\s*{\s*min-block-size:\s*var\(--ax-size-hit-touch\)/);
  expect(declarations(block(action, "@media (pointer: coarse)"), ".ax-history__compare")["min-block-size"]).toBe("var(--ax-size-hit-touch)");
  expect(declarations(block(styles, "@media (max-width: 767px)"), ".ax-compare__select")).toEqual({
    "font-size": "16px", "line-height": "24px",
  });
  expect(declarations(action, '.ax-history__compare[aria-disabled="true"]')).toMatchObject({
    color: "color-mix(in srgb, var(--ax-color-text-primary) 40%, transparent)", opacity: "1", cursor: "default",
  });
  expect(action).not.toMatch(/:hover|:active/);
  expect(styles + action).not.toContain("prefers-reduced-motion");
});
