import { render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { Binder } from "../src/binder/Binder";
import css from "../src/binder/open.css?raw";
import { chaptersPath, mockApi, treeA } from "./helpers";
import { chapterList, fourRows } from "./d06.fixtures";

test("AXB-0043 AC1 draws the current mark only on the current chapter and preserves action order", async () => {
  mockApi([{ method: "GET", path: chaptersPath, reply: chapterList(fourRows) }]);
  const { container } = render(<Binder tree={treeA} openChapterId={fourRows[1].id} />);
  await waitFor(() => expect(container.querySelectorAll('[data-part="chapter-open"]')).toHaveLength(4));
  const buttons = [...container.querySelectorAll('[data-part="chapter-open"]')];
  buttons.forEach((button, i) => {
    expect(button).toBe(button.parentElement?.lastElementChild); expect(button).toHaveAccessibleName(`Open Chapter ${i+1}${i === 0 ? ": Title" : ""}`);
    expect(button.children).toHaveLength(i === 1 ? 1 : 0);
    if (i === 1) { expect(button.firstElementChild).toHaveAttribute("data-part", "current-mark"); expect(button.firstElementChild).toHaveAttribute("aria-hidden", "true"); }
  });
  expect(container.querySelector('[data-part="add-chapter"]')).toHaveClass("ax-button", "ax-button--secondary");
});

test("AXB-0043 AC2 declares the exact Binder action drawing without prohibited motion or shadows", () => {
  expect(css.replace(/\s+/g, "")).toBe(expectedCss.replace(/\s+/g, ""));
  expect(css).not.toMatch(/transition|animation|border-left|border-right/);
  expect([...css.matchAll(/box-shadow:\s*([^;]+);/g)].map(m => m[1])).toEqual(["none"]);
});

const expectedCss = `
.ax-binder-chapter { position: relative; }
.ax-binder-chapter > span { position: relative; z-index: 1; pointer-events: none; }
[data-part="chapter-open"] { position: absolute; inset: 0; margin: 0; padding: 0; border: 0; border-radius: 0; background-color: transparent; color: inherit; font: inherit; cursor: pointer; appearance: none; }
[data-part="chapter-open"]:hover:not([aria-disabled="true"]):not([aria-current="true"]) { background-color: var(--ax-tint-hover); }
[data-part="chapter-open"]:active:not([aria-disabled="true"]):not([aria-current="true"]) { background-color: var(--ax-tint-pressed); }
[data-part="chapter-open"]:focus-visible { outline: 2px solid var(--ax-color-focus); outline-offset: -2px; box-shadow: none; }
[data-part="chapter-open"][aria-current="true"] { background-color: var(--ax-color-pencil-tint); opacity: 1; }
[data-part="chapter-open"][aria-disabled="true"] { opacity: 1; }
[data-part="current-mark"] { position: absolute; inset-inline: 0; inset-block-end: 0; block-size: 2px; background-color: var(--ax-color-text-primary); }
.ax-binder-chapter:has([data-part="chapter-open"][aria-current="true"]) .ax-binder-chapter-title { font-weight: 600; }
.ax-binder-chapter:has([data-part="chapter-open"][aria-disabled="true"]:not([aria-current="true"])) { opacity: var(--ax-opacity-disabled); }
[data-part="add-chapter"] { margin: var(--ax-space-3); min-inline-size: var(--ax-size-button-wide); }
[data-state="ready"] > [data-part="add-failure"] { margin: var(--ax-space-3); font-size: var(--ax-type-small-size); line-height: var(--ax-type-small-lh); color: var(--ax-color-text-primary); }
`;
