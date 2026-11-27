import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { Binder } from "../src/binder/Binder";
import css from "../src/binder/open.css?raw";
import binderSource from "../src/binder/Binder.tsx?raw";
import syncLayoutCss from "../src/binder/sync-layout.css?raw";
import syncCss from "../src/styles/binder-sync.css?raw";
import { chaptersPath, deferred, mockApi, treeA } from "./helpers";
import { chapterList, fourRows, reply } from "./d06.fixtures";
import { contrast } from "./draftFixtures";

import { internalEnvelope } from "./historyFixtures";
import { pbList, pbTree } from "./pullbackFixtures";

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
.ax-binder-chapter > span:not(.ax-binder__selected-rule) { position: relative; z-index: 1; pointer-events: none; }
[data-part="chapter-open"] { position: absolute; inset: 0; margin: 0; padding: 0; border: 0; border-radius: 0; background-color: transparent; color: inherit; font: inherit; cursor: pointer; appearance: none; }
 .ax-binder-chapter:not([data-selected="true"]) > [data-part="chapter-open"]:hover:not([aria-disabled="true"]):not([aria-current="true"]) { background-color: var(--ax-tint-hover); }
[data-part="chapter-open"]:active:not([aria-disabled="true"]):not([aria-current="true"]) { background-color: var(--ax-tint-pressed); }
[data-part="chapter-open"]:focus-visible { outline: 2px solid var(--ax-color-focus); outline-offset: -2px; box-shadow: none; }
[data-part="chapter-open"][aria-current="true"] { opacity: 1; }
[data-part="chapter-open"][aria-disabled="true"] { opacity: 1; }
[data-part="current-mark"] { display: none; }
.ax-binder-chapter:has([data-part="chapter-open"][aria-current="true"]) .ax-binder-chapter-title { font-weight: 600; }
.ax-binder-chapter:has([data-part="chapter-open"][aria-disabled="true"]:not([aria-current="true"])) > span:not(.ax-binder__selected-rule) { opacity: var(--ax-opacity-disabled); }
[data-part="add-chapter"] { margin: var(--ax-space-3); min-inline-size: var(--ax-size-button-wide); }
[data-state="ready"] > [data-part="add-failure"] { margin: var(--ax-space-3); font-size: var(--ax-type-small-size); line-height: var(--ax-type-small-lh); color: var(--ax-color-text-primary); }
`;

test("AXB-0074 AC1 draws the sync chips, quiet buttons and inline failure status", async () => {
  const post = deferred<typeof internalEnvelope>();
  mockApi([
    { method: "GET", path: chaptersPath, reply: reply(pbList) },
    { method: "POST", path: `/api/chapters/${pbList.chapters[1].id}/pull-back`, reply: () => post.promise },
  ]);
  const { container } = render(<Binder tree={pbTree} />);
  const b = await screen.findByRole("button", { name: "Pull back Chapter 2" });
  const c = screen.getByRole("button", { name: "Pull back Chapter 3: The Third Bell" });
  const rows = container.querySelectorAll('[data-part="chapter"]');
  expect(rows).toHaveLength(5);
  rows.forEach((row, index) => {
    const chip = row.querySelector('[data-part="chip"]');
    if (index === 1) expect(chip).toBeNull();
    else expect(chip).toHaveClass("ax-binder-chip", "ax-binder__sync");
  });
  for (const button of [b, c]) {
    expect(button).toHaveClass("ax-button", "ax-button--quiet", "ax-binder__pullback");
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toHaveAttribute("disabled");
    expect(button.nextElementSibling).toHaveAttribute("data-part", "chapter-open");
  }
  fireEvent.click(b);
  expect(b).toHaveTextContent(/^Pulling back\.\.\.$/);
  expect(c).toHaveTextContent(/^Pull back$/);
  for (const button of [b, c]) {
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("disabled");
  }

  await act(async () => { post.resolve(internalEnvelope); });
  const status = screen.getByRole("status");
  expect(status).toHaveClass("ax-binder__pullback-failure");
  expect(status.previousElementSibling).toBe(container.querySelector('[data-part="chapter-list"]'));
  expect(container.querySelector("[style]")).toBeNull();
});

const expectedSyncCss = `
.ax-binder__sync { box-sizing: border-box; max-inline-size: 100%; block-size: auto; min-block-size: 20px; white-space: normal; overflow-wrap: anywhere; text-align: start; color: var(--ax-color-text-secondary); }
.ax-binder__pullback { position: relative; z-index: 1; min-inline-size: 17ch; justify-content: center; text-align: center; }
.ax-binder__pullback[aria-disabled="true"] { opacity: 0.4; cursor: default; }
.ax-binder__pullback[aria-disabled="true"]:hover { background-color: transparent; }
.ax-binder__pullback[aria-disabled="true"]:active { background-color: transparent; }
.ax-binder__pullback-failure { position: sticky; inset-block-end: 0; z-index: 1; box-sizing: border-box; margin: 0; padding-block: var(--ax-space-3); padding-inline: 56px var(--ax-space-3); font-size: var(--ax-type-small-size); line-height: var(--ax-type-small-lh); color: var(--ax-color-text-primary); overflow-wrap: anywhere; background-color: var(--ax-color-surface-shell); border-block-start: 1px solid var(--ax-color-border-hair); }
`;

test("AXB-0074 AC2 uses the specified drawing rules and meets every contrast floor", () => {
  expect(syncCss.replace(/\s+/g, "")).toBe(expectedSyncCss.replace(/\s+/g, ""));
  expect(syncCss).not.toMatch(/transition|animation|@keyframes|box-shadow|border-left|border-right|severity-break|color-presence|outline/);
  const allowed = [
    "--ax-color-surface-shell", "--ax-color-text-primary", "--ax-color-text-secondary",
    "--ax-color-border-hair", "--ax-space-3", "--ax-type-small-size", "--ax-type-small-lh",
  ];
  for (const [, name] of syncCss.matchAll(/var\((--ax-[\w-]+)\)/g)) expect(allowed).toContain(name);
  expect(binderSource).toMatch(/import "\.\/binder\.css";\s*import "\.\.\/styles\/binder-sync\.css";/);
  expect(binderSource).toContain('import "./sync-layout.css";');
  expect(syncLayoutCss).toContain("fit-content(45%)");
  expect(syncLayoutCss).toContain("grid-row: 2;");
  expect(syncLayoutCss).toContain(".ax-binder__menu-trigger");
  expect(syncLayoutCss).toContain(".ax-binder__selected-rule");
  expect(syncLayoutCss).toContain("transition: none;");

  const themes = {
    light: { room: "#ECEBE6", primary: "#1B1C1E", secondary: "#4A4D52", pencil: "#DCE7F2" },
    dark: { room: "#0B0C0E", primary: "#D9D6CD", secondary: "#A9A79F", pencil: "#1B2733" },
    sepia: { room: "#D8CAAD", primary: "#2B2418", secondary: "#4F4636", pencil: "#C8D0D2" },
  };
  for (const [theme, { room, primary, secondary, pencil }] of Object.entries(themes)) {
    expect(contrast(primary, room), theme).toBeGreaterThanOrEqual(7);
    expect(contrast(secondary, room), theme).toBeGreaterThanOrEqual(4.5);
    expect(contrast(secondary, pencil), theme).toBeGreaterThanOrEqual(4.5);
    expect(contrast(primary, pencil), theme).toBeGreaterThanOrEqual(7);
  }
});
