import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { History } from "../src/history/History";
import css from "../src/history/history.css?raw";
import pageCss from "../src/styles/page.css?raw";
import { reply } from "./d06.fixtures";
import { contrast } from "./draftFixtures";
import { deferred, mockApi } from "./helpers";
import {
  chapterA, histA, histB, historyColors, historyNone, historyPath, historyThree, internalEnvelope,
  permittedHistoryTokens, versionPath, versionTextA, versionTextB,
} from "./historyFixtures";

type Handler = Parameters<typeof mockApi>[0][number];
const part = (root: Element, name: string) => root.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
const children = (element: Element) => [...element.children].map((child) => child.getAttribute("data-part"));
const retryClasses = ["ax-button", "ax-button--secondary", "ax-history__retry"];

function mount(history: Handler["reply"], ...versions: Handler[]) {
  mockApi([{ method: "GET", path: historyPath, reply: history }, ...versions]);
  const view = (token = 0) => <History chapterId={chapterA.id} timeZone="UTC" refreshToken={token} />;
  const ui = render(view());
  const root = ui.container.querySelector<HTMLElement>('[data-surface="history"]')!;
  return {
    ...ui,
    root,
    part: (name: string) => part(root, name),
    update: () => ui.rerender(view(1)),
    ready: () => waitFor(() => expect(root).toHaveAttribute("data-state", "ready")),
  };
}

function checkReading(reading: HTMLElement, text: string) {
  expect(reading).toHaveClass("ax-history__reading");
  expect(reading).toHaveTextContent(text);
  expect(children(reading)).toEqual(["reading-rule"]);
  expect(reading.firstElementChild?.tagName).toBe("SPAN");
  expect(reading.firstElementChild).toHaveClass("ax-reading-rule");
  expect(reading.firstElementChild).toHaveAttribute("aria-hidden", "true");
}

test("AC1 draws the specified list, selection, preview, and feedback in each History state", async () => {
  const first = deferred<ReturnType<typeof reply>>();
  const selected = deferred<ReturnType<typeof reply>>();
  let ui = mount(() => first.promise, { method: "GET", path: versionPath(histB.id), reply: () => selected.promise });
  expect(ui.root).toHaveClass("ax-history");
  checkReading(ui.part("reading"), "Reading the history.");
  await act(async () => { first.resolve(reply(historyThree)); });
  expect(ui.part("version-list")).toHaveClass("ax-history__list");
  const rows = [...ui.root.querySelectorAll('[data-part="version"]')];
  expect(rows).toHaveLength(3);
  for (const [index, row] of rows.entries()) {
    expect(row).toHaveClass("ax-history__version");
    expect(children(row)).toEqual(["version-open"]);
    const button = part(row, "version-open");
    expect(button).toHaveClass("ax-history__open");
    expect(children(button)).toEqual(["version-date", "version-source", "version-words", ...(index === 0 ? ["in-book"] : [])]);
    expect(part(button, "version-date")).toHaveClass("ax-history__date");
    expect(part(button, "version-source")).toHaveClass("ax-history__source");
    expect(part(button, "version-words")).toHaveClass("ax-history__words");
  }
  expect(part(rows[0], "in-book")).toHaveClass("ax-history__in-book");
  expect(ui.part("version-underline")).toBeNull();

  const rowButton = part(rows[1], "version-open");
  fireEvent.click(rowButton);
  expect(rowButton).toHaveAttribute("aria-expanded", "true");
  expect(rowButton.lastElementChild).toHaveClass("ax-history__underline");
  expect(rowButton.lastElementChild).toHaveAttribute("aria-hidden", "true");
  expect(rowButton.lastElementChild).toHaveAttribute("data-part", "version-underline");
  checkReading(ui.part("version-reading"), "Reading this version.");
  await act(async () => { selected.resolve(reply(versionTextB)); });
  expect(ui.part("version-detail")).toHaveClass("ax-history__detail");
  const lines = ui.root.querySelectorAll('[data-part="preview-line"]');
  expect(lines).toHaveLength(3);
  for (const line of lines) expect(line).toHaveClass("ax-history__line");
  fireEvent.click(rowButton);
  expect(ui.part("version-underline")).toBeNull();
  ui.unmount();

  ui = mount(internalEnvelope);
  await waitFor(() => expect(ui.part("read-failure")).toHaveClass("ax-history__note"));
  expect(ui.part("try-again")).toHaveClass(...retryClasses);
  ui.unmount();

  ui = mount(reply(historyNone));
  await ui.ready();
  expect(ui.part("empty")).toHaveClass("ax-history__empty");
  ui.unmount();

  ui = mount((_, n) => n === 0 ? reply(historyThree) : internalEnvelope,
    { method: "GET", path: versionPath(histA.id), reply: reply({ ...versionTextA, blocks: [] }) },
    { method: "GET", path: versionPath(histB.id), reply: internalEnvelope });
  await ui.ready();
  const buttons = ui.root.querySelectorAll('[data-part="version-open"]');
  await act(async () => { fireEvent.click(buttons[2]); });
  expect(ui.part("no-text")).toHaveClass("ax-history__note");
  await act(async () => { fireEvent.click(buttons[1]); });
  expect(ui.part("version-failure")).toHaveClass("ax-history__note");
  expect(ui.part("version-try-again")).toHaveClass(...retryClasses);
  await act(async () => { ui.update(); });
  expect(ui.part("refresh-failure")).toHaveClass("ax-history__note");
  expect(ui.part("refresh-again")).toHaveClass(...retryClasses);
});

test("AC2 declares the History rules, uses allowed tokens and passes the six contrast floors in each theme", () => {
  const expected = String.raw`
.ax-history {
  display: flex;
  flex-direction: column;
  gap: var(--ax-space-4);
  margin: 0;
  color: var(--ax-color-text-primary);
  font-size: var(--ax-type-body-size);
  line-height: var(--ax-type-body-lh);
}

.ax-history__reading {
  margin: 0;
  color: var(--ax-color-text-secondary);
  font-size: var(--ax-type-small-size);
  line-height: var(--ax-type-small-lh);
}

.ax-history__reading .ax-reading-rule {
  display: block;
  inline-size: 100%;
  margin-block-start: var(--ax-space-3);
}

.ax-history__note {
  margin: 0;
  color: var(--ax-color-text-primary);
  font-size: var(--ax-type-small-size);
  line-height: var(--ax-type-small-lh);
  overflow-wrap: anywhere;
}

.ax-history__empty {
  margin: var(--ax-space-8) 0 0;
  padding-inline: var(--ax-space-3);
  color: var(--ax-color-text-secondary);
  font-size: var(--ax-type-body-size);
  line-height: var(--ax-type-body-lh);
}

.ax-history__retry {
  align-self: flex-start;
}

.ax-history__list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-block: 1px solid var(--ax-color-border-hair);
}

.ax-history__version {
  margin: 0;
  padding: 0;
}

.ax-history__open {
  position: relative;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--ax-space-2) var(--ax-space-4);
  inline-size: 100%;
  min-block-size: 32px;
  padding: var(--ax-space-2) var(--ax-space-3);
  background-color: transparent;
  border: 0;
  border-radius: var(--ax-radius-2);
  color: var(--ax-color-text-primary);
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.ax-history__open:hover {
  background-color: color-mix(in srgb, var(--ax-color-text-primary) 6%, transparent);
}

.ax-history__open:active {
  background-color: color-mix(in srgb, var(--ax-color-text-primary) 14%, transparent);
}

.ax-history__open[aria-expanded="true"] {
  background-color: var(--ax-color-pencil-tint);
}

.ax-history__open[aria-expanded="true"] .ax-history__source {
  font-weight: 500;
}

.ax-history__date {
  font-family: var(--ax-type-family-mono);
  font-size: var(--ax-type-mono-size);
  line-height: var(--ax-type-mono-lh);
  font-variant-numeric: tabular-nums lining-nums;
  white-space: nowrap;
  color: var(--ax-color-text-tertiary);
}

.ax-history__source {
  min-inline-size: 0;
  overflow-wrap: anywhere;
  font-size: var(--ax-type-body-size);
  line-height: var(--ax-type-body-lh);
  font-weight: 400;
}

.ax-history__words {
  white-space: nowrap;
  text-align: end;
  font-size: var(--ax-type-small-size);
  line-height: var(--ax-type-small-lh);
  font-variant-numeric: tabular-nums lining-nums;
  color: var(--ax-color-text-secondary);
}

.ax-history__in-book {
  grid-column: 1 / -1;
  justify-self: start;
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  min-block-size: 20px;
  padding-inline: var(--ax-space-2);
  border: 1px solid var(--ax-color-border-hair);
  border-radius: var(--ax-radius-1);
  color: var(--ax-color-text-secondary);
  font-size: var(--ax-type-caption-size);
  line-height: var(--ax-type-caption-lh);
}

.ax-history__underline {
  position: absolute;
  inset-inline: 0;
  inset-block-end: 0;
  block-size: 2px;
  background-color: var(--ax-color-text-primary);
}

.ax-history__detail {
  display: flex;
  flex-direction: column;
  gap: var(--ax-space-3);
  padding: var(--ax-space-3) var(--ax-space-3) var(--ax-space-4);
}

.ax-history__line {
  position: relative;
  margin: 0;
  padding-inline-start: 32px;
  font-family: var(--ax-type-family-page-literary);
  font-size: var(--ax-type-lead-size);
  line-height: var(--ax-type-lead-lh);
  color: var(--ax-color-text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ax-history__line::before {
  content: "\201C" / "";
  position: absolute;
  inset-inline-start: 16px;
}

@media (pointer: coarse) {
  .ax-history__open {
    min-block-size: 44px;
  }
}
`;
  const literaryStack = pageCss.match(/\.ax-leaf\[data-profile="literary"\]\s*\{[^}]*--ax-page-family:\s*([^;]+);/)?.[1];
  expect(literaryStack).toBe('"Newsreader", Georgia, serif');
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  expect(normalize(css)).toBe(normalize(expected.replace(
    "var(--ax-type-family-page-literary)", `var(--ax-type-family-page-literary, ${literaryStack})`,
  )));
  expect(css).not.toMatch(/transition|animation|@keyframes|box-shadow|border-left|border-right|severity-break|color-presence/);
  for (const [, name] of css.matchAll(/var\(--ax-([\w-]+)/g)) expect(permittedHistoryTokens.has(name), name).toBe(true);

  for (const { theme, room, primary, secondary, tertiary, pencil } of historyColors()) {
    for (const [color, floor] of [[primary, 7], [secondary, 4.5], [tertiary, 4.5]] as const) {
      expect(contrast(color, room), `${theme}: ${color} on the room`).toBeGreaterThanOrEqual(floor);
      expect(contrast(color, pencil), `${theme}: ${color} on pencil tint`).toBeGreaterThanOrEqual(floor);
    }
  }
});
