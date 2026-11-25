import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ChapterListItem, SeriesTree } from "../src/api/types";
import { Binder } from "../src/binder/Binder";
import binderCss from "../src/binder/binder.css?raw";
import baseCss from "../src/styles/base.css?raw";
import { bookA, bookC, chapterA, chaptersPath, createdChapter, deferred, internalError, mockApi, treeA } from "./helpers";

const chapters = (items: ChapterListItem[]) => ({ status: 200, body: { chapters: items } });
const fixtures: ChapterListItem[] = [
  { ...chapterA, order_key: "0000003000", title: "Chapter One", word_count: 10 },
  {
    ...chapterA, id: "ch_00000000000b", order_key: "0000002000", word_count: 1,
    version_id: "ver_00000000000b", active_version_id: "ver_00000000000b",
  },
  {
    ...chapterA, id: "ch_00000000000c", word_count: 3404,
    version_id: "ver_00000000000d", active_version_id: "ver_00000000000c",
  },
  { ...chapterA, id: "ch_00000000000d", order_key: "0000004000", version_id: null },
];
const secondPath = `/api/books/${bookC.id}/chapters`;
const created = { status: 201, body: createdChapter };

function mountBinder(tree: SeriesTree = treeA) {
  const view = render(<Binder tree={tree} />);
  const binder = view.container.querySelector('[data-surface="binder"]')!;
  const firstGroup = binder.querySelector(`[data-book-id="${bookA.id}"]`)!;
  const firstToggle = within(firstGroup as HTMLElement).getByRole("button");
  const list = firstGroup.querySelector('[data-part="chapters"]')!;
  return { ...view, binder, list, firstToggle };
}

function addButton() {
  return screen.findByRole("button", { name: "Add the first scene" });
}

function chapterRows(root: ParentNode) {
  return [...root.querySelectorAll('[data-part="chapter"]')];
}

test("AXB-0032 AC1 draws titles, numerals, counts and chips in served order", async () => {
  const { calls } = mockApi([{ method: "GET", path: chaptersPath, reply: chapters(fixtures) }]);
  const { binder, list, firstToggle } = mountBinder();
  expect(binder.querySelector('[data-part="series-title"]')).toHaveTextContent("Ashfall");
  expect(firstToggle).toHaveAccessibleName("Ashfall");
  expect(firstToggle).toHaveAttribute("aria-expanded", "true");
  await waitFor(() => expect(list).toHaveAttribute("data-state", "ready"));

  const rows = chapterRows(list);
  expect(rows).toHaveLength(4);
  const names = ["Chapter 1: Chapter One", "Chapter 2", "Chapter 3", "Chapter 4"];
  const counts = ["10", "1", "3,404", "0"];
  const chips = ["Draft only", null, "In Book, edited since upload", "Draft only"];
  rows.forEach((row, index) => {
    expect(row).toHaveAccessibleName(names[index]);
    expect(row.querySelector('[data-part="numeral"]')?.textContent).toBe(String(index + 1));
    expect(row.querySelector('[data-part="count"]')?.textContent).toBe(counts[index]);
    expect(row.querySelector('[data-part="chip"]')?.textContent ?? null).toBe(chips[index]);
    const title = row.querySelector('[data-part="title"]');
    if (index === 0) {
      expect(title).toHaveTextContent("Chapter One");
      expect(title).toHaveAttribute("title", "Chapter One");
    } else {
      expect(title).toBeNull();
    }
  });
  expect(binder).not.toHaveTextContent(/ch_|ver_|bk_|ser_|000000[1-4]000/);
  expect(calls.map(({ method, path }) => [method, path])).toEqual([["GET", chaptersPath]]);
});

test("AXB-0032 AC2 blocks the first read, handles failure and silently refreshes retained rows", async () => {
  const pending = deferred<typeof internalError>();
  mockApi([
    { method: "GET", path: chaptersPath, reply: (_, n) => n === 0 ? pending.promise : chapters([]) },
  ]);
  let view = mountBinder();
  expect(view.list).toHaveAttribute("data-state", "loading");
  expect(screen.getByRole("status")).toHaveAttribute("data-part", "reading");
  await act(async () => pending.resolve(internalError));
  expect(view.list).toHaveAttribute("data-state", "failed");
  expect(screen.getByRole("alert")).toHaveAttribute("data-part", "read-failure");
  fireEvent.click(view.list.querySelector('[data-part="try-again"]')!);
  await addButton();
  expect(view.list).toHaveAttribute("data-state", "empty");
  cleanup();

  const refresh = deferred<ReturnType<typeof chapters>>();
  const { calls } = mockApi([
    { method: "GET", path: chaptersPath, reply: (_, n) => n === 0 ? chapters(fixtures) : refresh.promise },
    { method: "GET", path: secondPath, reply: chapters([]) },
  ]);
  view = mountBinder({ ...treeA, books: [bookA, bookC] });
  await waitFor(() => expect(chapterRows(view.list)).toHaveLength(4));
  const second = screen.getByRole("button", { name: bookC.title });
  expect(view.firstToggle).toHaveAttribute("aria-expanded", "true");
  expect(second).toHaveAttribute("aria-expanded", "false");
  expect(calls.map(({ path }) => path)).toEqual([chaptersPath]);
  fireEvent.click(second);
  expect(second).toHaveAttribute("aria-expanded", "true");
  expect(calls.map(({ path }) => path)).toEqual([chaptersPath, secondPath]);
  await addButton();

  fireEvent.click(view.firstToggle);
  expect(view.list).toHaveAttribute("hidden");
  expect(chapterRows(view.list)).toHaveLength(4);
  fireEvent.click(view.firstToggle);
  expect(view.list).not.toHaveAttribute("hidden");
  expect(view.list).toHaveAttribute("data-state", "ready");
  expect(chapterRows(view.list)).toHaveLength(4);
  expect(screen.queryByRole("status")).toBeNull();
  expect(calls.map(({ path }) => path)).toEqual([chaptersPath, secondPath, chaptersPath]);
  await act(async () => refresh.resolve(chapters([chapterA])));
  expect(chapterRows(view.list)).toHaveLength(1);
});

test("AXB-0032 AC3 adds one empty chapter and draws the subsequent GET result", async () => {
  const pending = deferred<typeof created>();
  const { calls } = mockApi([
    { method: "GET", path: chaptersPath, reply: (_, n) => chapters(n === 0 ? [] : [chapterA]) },
    { method: "POST", path: chaptersPath, reply: () => pending.promise },
  ]);
  const { list } = mountBinder();
  const button = await addButton();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toHaveTextContent("Adding...");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).not.toBeDisabled();
  expect(calls.map(({ method, body }) => [method, body])).toEqual([["GET", undefined], ["POST", { content: "" }]]);

  await act(async () => pending.resolve(created));
  const row = screen.getByRole("listitem", { name: "Chapter 1" });
  expect(chapterRows(list)).toEqual([row]);
  expect(row.querySelector('[data-part="numeral"]')).toHaveTextContent("1");
  expect(row.querySelector('[data-part="count"]')).toHaveTextContent("0");
  expect(row.querySelector('[data-part="chip"]')).toHaveTextContent("Draft only");
  expect(screen.queryByRole("button", { name: "Add the first scene" })).toBeNull();
  expect(calls.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
});

test("AXB-0032 AC4 reconciles failed writes and applies only the latest visibility refresh", async () => {
  const stored: ChapterListItem[] = [];
  let api = mockApi([
    { method: "GET", path: chaptersPath, reply: () => chapters(stored) },
    { method: "POST", path: chaptersPath, reply: () => { stored.push(chapterA); return "network"; } },
  ]);
  mountBinder();
  fireEvent.click(await addButton());
  expect(await screen.findByRole("listitem", { name: "Chapter 1" })).toBeInTheDocument();
  expect(api.calls.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add the first scene" })).toBeNull();
  cleanup();

  const recheck = deferred<ReturnType<typeof chapters>>();
  api = mockApi([
    { method: "GET", path: chaptersPath, reply: (_, n) => n === 0 ? chapters([]) : recheck.promise },
    { method: "POST", path: chaptersPath, reply: internalError },
  ]);
  let view = mountBinder();
  fireEvent.click(await addButton());
  await waitFor(() => expect(view.list).toHaveAttribute("data-state", "loading"));
  expect(screen.queryByRole("button", { name: "Add the first scene" })).toBeNull();
  await act(async () => recheck.resolve(chapters([])));
  expect(view.list).toHaveAttribute("data-state", "empty");
  expect(screen.getByRole("alert")).toHaveAttribute("data-part", "add-failure");
  await addButton();
  expect(api.calls.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
  cleanup();

  mockApi([
    { method: "GET", path: chaptersPath, reply: (_, n) => n === 0 ? chapters([]) : internalError },
    { method: "POST", path: chaptersPath, reply: created },
  ]);
  view = mountBinder();
  fireEvent.click(await addButton());
  expect(await screen.findByRole("alert")).toHaveAttribute("data-part", "read-failure");
  expect(view.list).toHaveAttribute("data-state", "failed");
  expect(view.list.querySelector('[data-part="try-again"]')).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add the first scene" })).toBeNull();
  cleanup();

  const older = deferred<ReturnType<typeof chapters>>();
  const latest = deferred<ReturnType<typeof chapters>>();
  api = mockApi([{
    method: "GET", path: chaptersPath, reply: (_, n) => {
      if (n === 0) return chapters(fixtures);
      if (n === 1) return older.promise;
      if (n === 2) return latest.promise;
      return internalError;
    },
  }]);
  view = mountBinder();
  await waitFor(() => expect(chapterRows(view.list)).toHaveLength(4));
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  function dispatchVisibility(value: DocumentVisibilityState) {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  }
  try {
    dispatchVisibility("hidden");
    expect(api.calls).toHaveLength(1);
    dispatchVisibility("visible");
    expect(api.calls).toHaveLength(2);
    expect(chapterRows(view.list)).toHaveLength(4);
    dispatchVisibility("visible");
    expect(api.calls).toHaveLength(3);
    await act(async () => latest.resolve(chapters([chapterA])));
    await act(async () => older.resolve(chapters(fixtures)));
    expect(chapterRows(view.list)).toHaveLength(1);

    dispatchVisibility("visible");
    expect(await screen.findByRole("alert")).toHaveAttribute("data-part", "read-failure");
    expect(view.list).toHaveAttribute("data-state", "failed");
    expect(chapterRows(view.list)).toHaveLength(0);
    expect(api.calls).toHaveLength(4);
    view.unmount();
    dispatchVisibility("visible");
    expect(api.calls).toHaveLength(4);
  } finally {
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("AXB-0032 AC5 applies the exact Binder design across the named parts and states", async () => {
  const initial = deferred<ReturnType<typeof chapters>>();
  mockApi([
    { method: "GET", path: chaptersPath, reply: () => initial.promise },
    { method: "GET", path: secondPath, reply: (_, n) => n === 0 ? internalError : chapters([]) },
  ]);
  const { binder, firstToggle, list } = mountBinder({ ...treeA, books: [bookA, bookC] });
  expect(binder).toHaveClass("ax-binder");
  expect(binder.querySelector('[data-part="series-title"]')).toHaveClass("ax-binder-title");
  expect(binder.querySelector('[data-part="books"]')).toHaveClass("ax-binder-books");
  const secondToggle = screen.getByRole("button", { name: bookC.title });
  for (const [toggle, path] of [
    [firstToggle, "M2.5 4.5L6 8L9.5 4.5"],
    [secondToggle, "M4.5 2.5L8 6L4.5 9.5"],
  ] as const) {
    expect(toggle).toHaveClass("ax-binder-toggle");
    const glyph = toggle.querySelector("svg.ax-chevron");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph?.querySelector("path")).toHaveAttribute("d", path);
  }

  const loading = screen.getByRole("status");
  expect(loading).toHaveClass("ax-status", "ax-binder-status");
  expect(loading.querySelector("span.ax-reading-rule")).toHaveAttribute("aria-hidden", "true");
  await act(async () => initial.resolve(chapters(fixtures)));
  const classes = {
    numeral: "ax-binder-numeral", title: "ax-binder-chapter-title", count: "ax-binder-count", chip: "ax-binder-chip",
  };
  const parts = [["numeral", "title", "count", "chip"], ["numeral", "count"], ["numeral", "count", "chip"], ["numeral", "count", "chip"]] as const;
  chapterRows(list).forEach((row, index) => {
    expect(row).toHaveClass("ax-binder-chapter");
    expect([...row.children].map((child) => child.getAttribute("data-part"))).toEqual([...parts[index], "chapter-open"]);
    for (const part of parts[index]) expect(row.querySelector(`[data-part="${part}"]`)).toHaveClass(classes[part]);
  });

  fireEvent.click(secondToggle);
  const failure = await screen.findByRole("alert");
  expect(failure).toHaveClass("ax-status", "ax-binder-status");
  const retry = failure.querySelector('[data-part="try-again"]')!;
  expect(retry).toHaveClass("ax-button", "ax-button--secondary");
  fireEvent.click(retry);
  const button = await addButton();
  const empty = binder.querySelector('[data-part="empty"]')!;
  expect(empty).toHaveClass("ax-binder-empty");
  expect(empty.children[0]).toBe(empty.querySelector('svg[data-part="axis"]'));
  expect(empty.children[1]).toBe(button);
  expect(button).toHaveClass("ax-button", "ax-button--secondary", "ax-button--wide");
  expect(baseCss + binderCss).not.toMatch(/#[\da-f]{3,8}\b|severity-break|border-left|border-right/i);
  expect(binderCss.replace(/\s+/g, "")).toBe(expectedCss.replace(/\s+/g, ""));
});

const expectedCss = `
.ax-binder { display: flex; flex-direction: column; block-size: 100%; }
.ax-binder-title {
  flex: none;
  margin: 0;
  padding: var(--ax-space-5);
  border-block-end: 1px solid var(--ax-color-border-hair);
  font-size: var(--ax-type-title-s-size);
  line-height: var(--ax-type-title-s-lh);
  font-weight: var(--ax-type-title-s-weight);
  overflow-wrap: anywhere;
}
.ax-binder-books { flex: 1; overflow-y: auto; margin: 0; padding: var(--ax-space-3) 0; list-style: none; }
.ax-binder-book { margin: 0 0 var(--ax-space-3); }
.ax-binder-toggle {
  display: flex;
  align-items: center;
  gap: var(--ax-space-2);
  inline-size: 100%;
  min-block-size: var(--ax-size-row);
  padding-inline: var(--ax-space-2) var(--ax-space-4);
  border: 0;
  background-color: transparent;
  color: var(--ax-color-text-primary);
  font-family: inherit;
  font-size: var(--ax-type-body-size);
  line-height: var(--ax-type-body-lh);
  font-weight: var(--ax-type-body-weight);
  text-align: start;
  overflow-wrap: anywhere;
  cursor: pointer;
  transition: background-color var(--ax-dur-hover) var(--ax-ease-state);
}
.ax-binder-toggle:hover { background-color: var(--ax-tint-hover); }
.ax-binder-toggle:active { background-color: var(--ax-tint-pressed); }
.ax-binder-toggle:focus-visible { outline: 2px solid var(--ax-color-focus); outline-offset: -2px; box-shadow: none; }
.ax-binder-chapter-list { margin: 0; padding: 0; list-style: none; }
.ax-binder-chapter {
  display: grid;
  grid-template-columns: var(--ax-size-binder-numeral) minmax(0, 1fr) auto auto;
  column-gap: var(--ax-space-3);
  align-items: center;
  min-block-size: var(--ax-size-row);
  padding-inline: 20px var(--ax-space-4);
}
.ax-binder-numeral {
  grid-column: 1;
  text-align: end;
  font-size: var(--ax-type-small-size);
  line-height: var(--ax-type-small-lh);
  color: var(--ax-color-text-tertiary);
  font-variant-numeric: tabular-nums lining-nums;
}
.ax-binder-chapter-title {
  grid-column: 2;
  min-inline-size: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--ax-type-body-size);
  line-height: var(--ax-type-body-lh);
  color: var(--ax-color-text-primary);
}
.ax-binder-count {
  grid-column: 3;
  text-align: end;
  font-size: var(--ax-type-small-size);
  line-height: var(--ax-type-small-lh);
  color: var(--ax-color-text-secondary);
  font-variant-numeric: tabular-nums lining-nums;
}
.ax-binder-chip {
  grid-column: 4;
  display: inline-flex;
  align-items: center;
  min-block-size: 20px;
  max-inline-size: 104px;
  padding: 1px var(--ax-space-2);
  border: 1px solid var(--ax-color-border-hair);
  border-radius: var(--ax-radius-1);
  font-size: var(--ax-type-caption-size);
  line-height: var(--ax-type-caption-lh);
  color: var(--ax-color-text-secondary);
  overflow-wrap: break-word;
}
.ax-binder-status { padding: var(--ax-space-3) var(--ax-space-4) var(--ax-space-3) 20px; }
.ax-binder-status .ax-button { margin-block-start: var(--ax-space-3); }
.ax-binder-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ax-space-5);
  padding: var(--ax-space-8) var(--ax-space-6);
}
@media (pointer: coarse) {
  .ax-binder-toggle, .ax-binder-chapter { min-block-size: var(--ax-size-row-touch); }
}
`;
