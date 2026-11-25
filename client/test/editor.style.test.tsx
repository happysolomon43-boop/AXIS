import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Editor } from "../src/editor/Editor";
import { blocksFromServed } from "../src/editor/model";
import css from "../src/editor/editor.css?raw";
import { detailText } from "./d06.fixtures";

test("AXB-0039 AC4 matches leaf structure and BC-9 editor style declarations", () => {
  const { container } = render(<Editor blocks={blocksFromServed(detailText.blocks)} editable onDocChange={vi.fn()} />);
  const leaf = container.querySelector('[data-part="leaf"]')!;
  expect(leaf).toHaveAttribute("data-profile", "literary"); expect(leaf).toHaveAttribute("data-theme", "light");
  expect([...leaf.children].map(el => el.getAttribute("data-part"))).toEqual(["leaf-edge", "editor-host", "leaf-edge"]);
  expect(leaf.children[0]).toHaveClass("ax-leaf-edge--start"); expect(leaf.children[0]).toHaveAttribute("aria-hidden", "true");
  expect(leaf.children[1]).toHaveClass("ax-column"); expect(leaf.children[2]).toHaveClass("ax-leaf-edge--end"); expect(leaf.children[2]).toHaveAttribute("aria-hidden", "true");
  expect(leaf.querySelector('[data-part="editor"]')).toHaveClass("ax-page");
  expect(css.replace(/\s+/g, "")).toBe(expectedCss.replace(/\s+/g, ""));
  expect(css).not.toMatch(/transition|animation|border-left|border-right|border-inline-start|border-inline-end/);
  expect([...css.matchAll(/box-shadow:\s*([^;]+);/g)].map(m => m[1])).toEqual(["none"]);
});

const expectedCss = `
.ax-leaf {
  position: relative;
  box-sizing: border-box;
  flex: none;
  inline-size: calc(var(--ax-page-measure) + 2 * var(--ax-size-leaf-pad));
  padding-block-start: var(--ax-space-10);
  padding-block-end: 40vh;
  padding-inline: var(--ax-size-leaf-pad);
  background-color: var(--ax-page-paper);
  color: var(--ax-page-ink);
  font-family: var(--ax-page-family);
  font-size: var(--ax-page-size);
  line-height: var(--ax-page-lh);
  font-weight: var(--ax-page-weight);
  letter-spacing: var(--ax-page-tracking);
  border-radius: var(--ax-radius-0);
}
.ax-leaf-edge { position: absolute; inset-block: 0; inline-size: 1px; background-color: var(--ax-color-border-leaf); }
.ax-leaf-edge--start { inset-inline-start: 0; }
.ax-leaf-edge--end { inset-inline-end: 0; }
.ax-column { inline-size: 100%; }
.ax-page { outline: none; caret-color: var(--ax-color-presence); font-variant-numeric: lining-nums proportional-nums; hyphens: none; overflow-wrap: break-word; text-wrap: pretty; hanging-punctuation: first; }
.ax-page [data-block="paragraph"] { margin: 0; white-space: pre-wrap; }
.ax-page [data-block="paragraph"] + [data-block="paragraph"] { text-indent: var(--ax-page-indent); margin-block-start: var(--ax-page-gap); }
.ax-page [data-block="heading"] { font-size: 1.75em; font-weight: 500; letter-spacing: -0.01em; line-height: 1.25; text-wrap: balance; margin-block: calc(2.25em / 1.75); }
.ax-page [data-block="scene_break"] {
  border: 0; padding: 0; margin-inline: auto; margin-block: var(--ax-page-break-space); inline-size: 14px; block-size: 14px; background-color: var(--ax-page-ink); opacity: 0.55;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cg id='s'%3E%3Cpolygon points='7,0.4 7.75,2.56 10.04,2.61 8.22,4 8.88,6.19 7,4.88 5.12,6.19 5.78,4 3.96,2.61 6.25,2.56'/%3E%3C/g%3E%3Cuse href='%23s' x='-3.4' y='6.4'/%3E%3Cuse href='%23s' x='3.4' y='6.4'/%3E%3C/svg%3E") center / 14px 14px no-repeat;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cg id='s'%3E%3Cpolygon points='7,0.4 7.75,2.56 10.04,2.61 8.22,4 8.88,6.19 7,4.88 5.12,6.19 5.78,4 3.96,2.61 6.25,2.56'/%3E%3C/g%3E%3Cuse href='%23s' x='-3.4' y='6.4'/%3E%3Cuse href='%23s' x='3.4' y='6.4'/%3E%3C/svg%3E") center / 14px 14px no-repeat;
}
.ax-leaf[data-profile="modern"] .ax-page [data-block="scene_break"] { inline-size: 28px; block-size: 1px; mask: none; -webkit-mask: none; }
.ax-page > :first-child { margin-block-start: 0; }
.ax-page:focus-visible { outline: none; box-shadow: none; }
.ax-page ::selection { background-color: var(--ax-color-presence-tint); color: inherit; }
.ax-page .ProseMirror-selectednode { outline: 2px solid var(--ax-color-focus); outline-offset: 2px; }
.ax-page[contenteditable="false"] { caret-color: transparent; }
@media (max-width: 767px) {
  .ax-leaf { flex: 1 1 auto; inline-size: 100%; padding-inline: var(--ax-space-6); }
  .ax-leaf-edge { display: none; }
}
`;
