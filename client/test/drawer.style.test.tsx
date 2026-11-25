import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import css from "../src/shell/drawer.css?raw";
import { Shell } from "../src/shell/Shell";
import { chapterList, chapterPath, detailText, fourRows, reply } from "./d06.fixtures";
import { contrast, noDraftRead } from "./draftFixtures";
import { chaptersPath, mockApi, treeA } from "./helpers";
import { historyColors, historyPath, historyTwo, permittedHistoryTokens } from "./historyFixtures";

test("AC1 draws the drawer, quiet Close button, History door and open-only underline", async () => {
  mockApi([
    { method: "GET", path: chaptersPath, reply: chapterList([fourRows[0]]) },
    { method: "GET", path: chapterPath, reply: reply(detailText) },
    noDraftRead,
    { method: "GET", path: historyPath, reply: reply(historyTwo) },
  ]);
  const { container } = render(<Shell tree={treeA} />);
  const part = (name: string) => container.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  expect(part("history-door")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Open Chapter 1: Title" }));
  await waitFor(() => expect(part("editor")).toBeInTheDocument());
  const door = part("history-door");
  expect(door).toHaveClass("ax-history-door");
  expect(door.textContent).toBe("History");
  expect(door).toHaveAttribute("aria-expanded", "false");
  expect(part("history-door-underline")).toBeNull();
  await act(async () => { fireEvent.click(door); });

  expect(door).toHaveAttribute("aria-expanded", "true");
  const underlines = door.querySelectorAll('span.ax-history-door__underline[data-part="history-door-underline"][aria-hidden="true"]');
  expect(underlines).toHaveLength(1);
  expect(door.lastElementChild).toBe(underlines[0]);
  const drawer = container.querySelector('aside[data-region="drawer"]');
  expect(drawer).toHaveClass("ax-drawer");
  expect(part("drawer-header")).toHaveClass("ax-drawer__header");
  expect(part("drawer-title").tagName).toBe("H2");
  expect(part("drawer-title")).toHaveClass("ax-drawer__title");
  expect(part("drawer-close")).toHaveClass("ax-button", "ax-button--quiet", "ax-drawer__close");
  expect(part("drawer-body")).toHaveClass("ax-drawer__body");
  fireEvent.keyDown(part("drawer-close"), { key: "Escape" });
  expect(door).toHaveAttribute("aria-expanded", "false");
  expect(part("history-door-underline")).toBeNull();
  expect(drawer).not.toBeInTheDocument();
});

test("AC2 declares the exact responsive drawer and door rules and passes contrast in all themes", () => {
  const expected = `
:root {
  --ax-size-drawer: 380px;
  --ax-size-drawer-header: 48px;
}

.ax-drawer {
  position: fixed;
  inset-block-start: var(--ax-size-strip);
  inset-block-end: 0;
  inset-inline-end: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  inline-size: var(--ax-size-drawer);
  max-inline-size: 100%;
  background-color: var(--ax-color-surface-shell);
  color: var(--ax-color-text-primary);
  border: 1px solid var(--ax-color-border-hair);
}

.ax-drawer__header {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  flex: none;
  gap: var(--ax-space-3);
  block-size: var(--ax-size-drawer-header);
  padding-inline: var(--ax-space-5);
  border-block-end: 1px solid var(--ax-color-border-hair);
}

.ax-drawer__title {
  flex: 1 1 auto;
  min-inline-size: 0;
  margin: 0;
  font-size: var(--ax-type-title-s-size);
  line-height: var(--ax-type-title-s-lh);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.ax-drawer__body {
  flex: 1 1 auto;
  min-block-size: 0;
  overflow-y: auto;
  padding: var(--ax-space-5);
}

@media (min-width: 1262px) {
  [data-region="text"]:has(+ [data-region="drawer"]) {
    margin-inline-end: var(--ax-size-drawer);
  }
}

@media (max-width: 1261.98px) {
  .ax-drawer {
    inset-block-start: auto;
    inset-inline-start: 0;
    inline-size: auto;
    block-size: 50dvh;
    border-start-start-radius: 14px;
    border-start-end-radius: 14px;
    z-index: var(--ax-z-overlay);
    box-shadow: var(--ax-shadow-overlay);
  }

  [data-region="text"]:has(+ [data-region="drawer"]) {
    margin-block-end: 50dvh;
  }
}

.ax-history-door {
  position: relative;
  align-self: stretch;
  margin-inline-start: auto;
  box-sizing: border-box;
  min-block-size: 32px;
  padding-inline: var(--ax-space-3);
  background-color: transparent;
  border: 0;
  border-radius: var(--ax-radius-2);
  color: var(--ax-color-text-primary);
  font-family: inherit;
  font-size: var(--ax-type-body-size);
  line-height: var(--ax-type-body-lh);
  font-weight: 400;
  cursor: pointer;
}

.ax-history-door:hover {
  background-color: color-mix(in srgb, var(--ax-color-text-primary) 6%, transparent);
}

.ax-history-door:active {
  background-color: color-mix(in srgb, var(--ax-color-text-primary) 14%, transparent);
}

.ax-history-door[aria-expanded="true"] {
  font-weight: 500;
}

.ax-history-door__underline {
  position: absolute;
  inset-inline: var(--ax-space-3);
  inset-block-end: 0;
  block-size: 2px;
  background-color: var(--ax-color-text-primary);
}

@media (pointer: coarse) {
  .ax-history-door {
    min-block-size: 44px;
  }
}
`;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  expect(normalize(css)).toBe(normalize(expected));
  expect(Array.from(css.matchAll(/@media ([^{]+)\{/g), ([, query]) => query.trim())).toEqual([
    "(min-width: 1262px)", "(max-width: 1261.98px)", "(pointer: coarse)",
  ]);
  expect(css).not.toMatch(/transition|animation|@keyframes|border-left|border-right|severity-break|outline/);
  expect(css.match(/box-shadow/g)).toHaveLength(1);
  expect(css).toMatch(/@media \(max-width: 1261\.98px\)\s*\{\s*\.ax-drawer\s*\{[^}]*box-shadow:\s*var\(--ax-shadow-overlay\);/);
  for (const [, name] of css.matchAll(/var\(--ax-([\w-]+)/g)) expect(permittedHistoryTokens.has(name), name).toBe(true);
  for (const { theme, room, primary } of historyColors()) {
    expect(contrast(primary, room), theme).toBeGreaterThanOrEqual(7);
  }
});
