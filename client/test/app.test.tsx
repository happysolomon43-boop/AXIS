import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { App } from "../src/App";
import shellCss from "../src/shell/shell.css?raw";
import {
  bookA, chaptersPath, deferred, internalError, mockApi, seriesA, seriesB, seriesPath, treeA,
} from "./helpers";

const deviceKey = "axis.lastSeriesId";
const pathA = `${seriesPath}/${seriesA.id}`;
const pathB = `${seriesPath}/${seriesB.id}`;
const treeB = { series: seriesB, books: [] };
const emptySeries = { status: 200, body: { series: [] } };
const owned = { status: 200, body: { series: [seriesA, seriesB] } };
const detailA = { status: 200, body: treeA };
const emptyChapters = { status: 200, body: { chapters: [] } };
const chaptersHandler = { method: "GET", path: chaptersPath, reply: emptyChapters };

function binderDoor() {
  return screen.findByRole("button", { name: "Binder" });
}

test("AXB-0033 AC1 opens Onboarding and shows the first Book after its creation", async () => {
  const list = deferred<typeof emptySeries>();
  const { calls } = mockApi([
    { method: "GET", path: seriesPath, reply: () => list.promise },
    { method: "POST", path: seriesPath, reply: { status: 201, body: treeA } },
    chaptersHandler,
  ]);
  const { container } = render(<App />);
  const opening = screen.getByRole("status");
  expect(opening.parentElement).toHaveAttribute("data-surface", "opening");
  expect(opening).toHaveClass("ax-opening__status");

  await act(async () => list.resolve(emptySeries));
  const form = screen.getByRole("form");
  expect(form).toHaveAttribute("data-surface", "onboarding");
  expect(calls.map(({ method, path }) => [method, path])).toEqual([["GET", seriesPath]]);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ashfall" } });
  fireEvent.submit(form);

  await binderDoor();
  await screen.findByRole("button", { name: "Add the first scene" });
  expect(container.querySelector('[data-part="series-title"]')).toHaveTextContent("Ashfall");
  expect(screen.getByRole("button", { name: bookA.title })).toBeInTheDocument();
  expect(localStorage.getItem(deviceKey)).toBe(seriesA.id);
  expect(calls.map(({ method, path }) => [method, path])).toEqual([
    ["GET", seriesPath], ["POST", seriesPath], ["GET", chaptersPath],
  ]);
});

test("AXB-0033 AC2 chooses the remembered or first Series and works when storage fails", async () => {
  for (const stored of [seriesB.id, "ser_00000000000z", null, "storage throws"]) {
    function unavailable(): never { throw new Error("storage"); }
    const blocked = stored === "storage throws" ? {
      read: vi.spyOn(Storage.prototype, "getItem").mockImplementation(unavailable),
      write: vi.spyOn(Storage.prototype, "setItem").mockImplementation(unavailable),
    } : null;
    if (!blocked && stored !== null) {
      localStorage.setItem(deviceKey, stored);
    }
    try {
      const { calls } = mockApi([
        { method: "GET", path: seriesPath, reply: owned },
        { method: "GET", path: pathA, reply: detailA },
        { method: "GET", path: pathB, reply: { status: 200, body: treeB } },
        chaptersHandler,
      ]);
      const { container } = render(<App />);
      await binderDoor();
      const expected = stored === seriesB.id ? seriesB : seriesA;
      expect(container.querySelector('[data-part="series-title"]')).toHaveTextContent(expected.title);
      expect(calls.filter(({ path }) => path.startsWith(`${seriesPath}/`)).map(({ path }) => path))
        .toEqual([`${seriesPath}/${expected.id}`]);
      if (blocked) {
        expect(blocked.read).toHaveBeenCalledWith(deviceKey);
        expect(blocked.write).toHaveBeenCalledWith(deviceKey, seriesA.id);
        await screen.findByRole("button", { name: "Add the first scene" });
      } else {
        expect(localStorage.getItem(deviceKey)).toBe(expected.id);
        if (expected === seriesA) await screen.findByRole("button", { name: "Add the first scene" });
      }
    } finally {
      cleanup();
      blocked?.read.mockRestore();
      blocked?.write.mockRestore();
      localStorage.clear();
    }
  }

  const storedSeries: typeof seriesA[] = [];
  const recovered = mockApi([
    { method: "GET", path: seriesPath, reply: () => ({ status: 200, body: { series: storedSeries } }) },
    { method: "POST", path: seriesPath, reply: () => { storedSeries.push(seriesA); return "network"; } },
    { method: "GET", path: pathA, reply: detailA },
    chaptersHandler,
  ]);
  render(<App />);
  const form = await screen.findByRole("form");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ashfall" } });
  fireEvent.submit(form);
  await binderDoor();
  await screen.findByRole("button", { name: "Add the first scene" });
  expect(recovered.calls.map(({ method, path }) => [method, path])).toEqual([
    ["GET", seriesPath], ["POST", seriesPath], ["GET", seriesPath], ["GET", pathA], ["GET", chaptersPath],
  ]);
  expect(localStorage.getItem(deviceKey)).toBe(seriesA.id);
});

test("AXB-0033 AC3 restarts from the list after a failed open and stops on unmount", async () => {
  const notFound = { status: 404, body: { error: { code: "not_found", message: "Series not found", details: null } } };
  for (const failure of ["list", "404", "network"] as const) {
    const { calls } = mockApi([
      { method: "GET", path: seriesPath, reply: (_, n) => n === 0 && failure === "list" ? internalError : owned },
      {
        method: "GET", path: pathA, reply: (_, n) => {
          if (n > 0 || failure === "list") return detailA;
          return failure === "404" ? notFound : "network";
        },
      },
      chaptersHandler,
    ]);
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.parentElement).toHaveAttribute("data-surface", "opening-failed");
    expect(alert.parentElement).toHaveClass("ax-opening");
    const retry = alert.parentElement!.querySelector('[data-part="try-again"]')!;
    expect(retry).toHaveClass("ax-button", "ax-button--secondary");
    expect(localStorage.getItem(deviceKey)).toBeNull();
    const nextCall = calls.length;
    fireEvent.click(retry);
    await binderDoor();
    await screen.findByRole("button", { name: "Add the first scene" });
    expect(calls.slice(nextCall).map(({ method, path }) => [method, path])).toEqual([
      ["GET", seriesPath], ["GET", pathA], ["GET", chaptersPath],
    ]);
    cleanup();
    localStorage.clear();
  }

  const pendingList = deferred<typeof owned>();
  const listApi = mockApi([{ method: "GET", path: seriesPath, reply: () => pendingList.promise }]);
  const first = render(<App />);
  first.unmount();
  await act(async () => pendingList.resolve(owned));
  expect(listApi.calls.map(({ path }) => path)).toEqual([seriesPath]);

  const pendingDetail = deferred<typeof detailA>();
  const detailApi = mockApi([
    { method: "GET", path: seriesPath, reply: owned },
    { method: "GET", path: pathA, reply: () => pendingDetail.promise },
  ]);
  const second = render(<App />);
  await waitFor(() => expect(detailApi.calls.map(({ path }) => path)).toEqual([seriesPath, pathA]));
  second.unmount();
  await act(async () => pendingDetail.resolve(detailA));
  expect(detailApi.calls).toHaveLength(2);
  expect(localStorage.getItem(deviceKey)).toBeNull();
});

test("AXB-0033 AC4 provides the shell regions, visual parts, Binder toggle and chord", async () => {
  const { calls } = mockApi([
    { method: "GET", path: seriesPath, reply: owned },
    { method: "GET", path: pathA, reply: detailA },
    chaptersHandler,
  ]);
  const user = userEvent.setup();
  const view = render(<App />);
  const door = await binderDoor();
  const add = await screen.findByRole("button", { name: "Add the first scene" });
  const book = screen.getByRole("button", { name: bookA.title });
  const shell = view.container.querySelector('[data-surface="shell"]')!;
  const strip = shell.querySelector('header[data-region="top-strip"]')!;
  const binder = screen.getByRole("complementary", { name: "Binder" });
  const text = screen.getByRole("main", { name: "Text" });

  expect(shell).toHaveClass("ax-shell");
  expect(strip).toHaveClass("ax-strip");
  expect(strip.children).toHaveLength(2);
  const wordmark = strip.firstElementChild!;
  expect(wordmark.tagName).toBe("SPAN");
  expect(wordmark).toHaveClass("ax-wordmark");
  expect(wordmark).toHaveAttribute("data-part", "wordmark");
  expect(wordmark).toHaveTextContent("Axis");
  expect(wordmark.querySelector("svg.ax-mark")).toHaveAttribute("aria-hidden", "true");
  expect(strip.lastElementChild).toBe(door);
  expect(door).toHaveClass("ax-door");
  expect(door).toHaveAttribute("aria-label", "Binder");
  expect(door).toHaveAttribute("title", "Binder: Cmd/Ctrl + Shift + \\");
  expect(door.querySelector("svg.ax-glyph")).toHaveAttribute("aria-hidden", "true");
  expect(door).toHaveAttribute("aria-controls", binder.id);
  expect(door).toHaveAttribute("aria-pressed", "true");
  const underline = '[data-part="door-underline"]';
  expect(door.querySelector(underline)).toHaveClass("ax-door-underline");
  expect(door.querySelector(underline)).toHaveAttribute("aria-hidden", "true");
  expect(binder.tagName).toBe("ASIDE");
  expect(binder).toHaveAttribute("data-region", "binder");
  expect(binder).toHaveClass("ax-binder-region");
  expect(text.tagName).toBe("MAIN");
  expect(text).toHaveAttribute("data-region", "text");
  expect(text).toHaveClass("ax-text-region");
  expect(text).toBeEmptyDOMElement();

  await user.tab();
  expect(door).toHaveFocus();
  await user.tab();
  expect(book).toHaveFocus();
  await user.tab();
  expect(add).toHaveFocus();
  await user.tab();
  expect(document.body).toHaveFocus();

  await user.click(door);
  expect(binder).toHaveAttribute("hidden");
  expect(door).toHaveAttribute("aria-pressed", "false");
  expect(door.querySelector(underline)).toBeNull();
  expect(binder).toContainElement(add);
  await user.click(door);
  expect(binder).not.toHaveAttribute("hidden");
  expect(door).toHaveAttribute("aria-pressed", "true");
  expect(door.querySelector(underline)).toBeInTheDocument();
  expect(calls.filter(({ path }) => path === chaptersPath)).toHaveLength(1);

  function chord(options: KeyboardEventInit) {
    const event = new KeyboardEvent("keydown", { code: "Backslash", cancelable: true, ...options });
    fireEvent(window, event);
    return event;
  }

  act(() => book.focus());
  expect(chord({ ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  expect(binder).toHaveAttribute("hidden");
  expect(door).toHaveFocus();
  expect(chord({ metaKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  expect(binder).not.toHaveAttribute("hidden");
  expect(chord({ metaKey: true, ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  expect(binder).toHaveAttribute("hidden");
  chord({ ctrlKey: true, shiftKey: true });
  expect(binder).not.toHaveAttribute("hidden");
  for (const keys of [
    { ctrlKey: true },
    { ctrlKey: true, shiftKey: true, altKey: true },
    { shiftKey: true },
    { code: "Slash", ctrlKey: true, shiftKey: true },
  ]) {
    expect(chord(keys).defaultPrevented).toBe(false);
    expect(binder).not.toHaveAttribute("hidden");
  }
  view.unmount();
  expect(chord({ ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  expect(shellCss).not.toMatch(/#[\da-f]{3,8}\b|severity-break|border-left|border-right/i);
  expect(shellCss.replace(/\s+/g, "")).toBe(expectedCss.replace(/\s+/g, ""));
});

const expectedCss = `
.ax-shell {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: var(--ax-size-strip) minmax(0, 1fr);
  block-size: 100%;
}
.ax-strip {
  grid-column: 1 / -1;
  position: relative;
  z-index: var(--ax-z-shell);
  display: flex;
  align-items: center;
  gap: var(--ax-space-3);
  block-size: var(--ax-size-strip);
  padding-inline: var(--ax-space-5);
  border-block-end: 1px solid var(--ax-color-border-hair);
  background-color: var(--ax-color-surface-shell);
}
.ax-wordmark {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--ax-type-title-size);
  line-height: var(--ax-type-title-lh);
  font-weight: var(--ax-type-title-weight);
  letter-spacing: var(--ax-type-title-tracking);
}
.ax-door {
  position: relative;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  inline-size: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--ax-radius-2);
  background-color: transparent;
  color: var(--ax-color-text-primary);
  cursor: pointer;
  transition: background-color var(--ax-dur-hover) var(--ax-ease-state);
}
.ax-door:hover { background-color: var(--ax-tint-hover); }
.ax-door:active { background-color: var(--ax-tint-pressed); }
.ax-door-underline {
  position: absolute;
  inset-inline-start: calc(50% - 10px);
  inset-block-end: -1px;
  inline-size: 20px;
  block-size: 2px;
  background-color: var(--ax-color-text-primary);
}
.ax-binder-region {
  grid-column: 1;
  grid-row: 2;
  inline-size: var(--ax-size-binder);
  overflow-y: auto;
  border-inline-end: 1px solid var(--ax-color-border-hair);
  background-color: var(--ax-color-surface-shell);
}
.ax-text-region {
  grid-column: 2;
  grid-row: 2;
  min-inline-size: 0;
  overflow-y: auto;
  background-color: var(--ax-color-surface-shell);
}
@media (max-width: 1023px) {
  .ax-binder-region {
    position: fixed;
    inset-block: var(--ax-size-strip) 0;
    inset-inline-start: 0;
    z-index: var(--ax-z-overlay);
    background-color: var(--ax-color-surface-raised);
    border-inline-end: 1px solid var(--ax-color-border-control);
    box-shadow: var(--ax-shadow-overlay);
  }
}
@media (pointer: coarse) { .ax-door { inline-size: var(--ax-size-hit-touch); } }
`;
