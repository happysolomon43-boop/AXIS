import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Binder } from "../src/binder/Binder";
import { bookA, bookC, chaptersPath, createdChapter, deferred, internalError, mockApi, treeA } from "./helpers";
import { chapterA, chapterList, createdB, fourRows, reply } from "./d06.fixtures";
const first = fourRows[0]; const second = fourRows[1];
const list = (root: ParentNode) => root.querySelector('[data-part="chapters"]')!;
const rows = (root: ParentNode) => [...root.querySelectorAll('[data-part="chapter"]')];
const buttons = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('[data-part="chapter-open"]')];
const add = (root: ParentNode) => root.querySelector<HTMLButtonElement>('[data-part="add-chapter"]')!;

test("AXB-0041 AC1 opens only noncurrent unlocked rows and preserves existing parts", async () => {
  const onOpenChapter = vi.fn(); mockApi([{ method: "GET", path: chaptersPath, reply: chapterList(fourRows) }]);
  const { container, rerender } = render(<Binder tree={treeA} openChapterId={second.id} onOpenChapter={onOpenChapter} />);
  await waitFor(() => expect(rows(container)).toHaveLength(4));
  const names = ["Open Chapter 1: Title", "Open Chapter 2", "Open Chapter 3", "Open Chapter 4"];
  const parts = [["numeral", "title", "count", "chip"], ["numeral", "count"], ["numeral", "count", "chip"], ["numeral", "count", "chip"]];
  buttons(container).forEach((button, i) => {
    expect(button).toHaveAccessibleName(names[i]); expect(button).toBe(rows(container)[i].lastElementChild);
    expect([...rows(container)[i].children].map(el => el.getAttribute("data-part"))).toEqual([...parts[i], "chapter-open"]);
    if (i === 1) expect(button).toHaveAttribute("aria-current", "true"); else expect(button).not.toHaveAttribute("aria-current");
  });
  fireEvent.click(buttons(container)[0]); expect(onOpenChapter.mock.calls).toEqual([[chapterA.id]]);
  fireEvent.click(buttons(container)[1]); expect(onOpenChapter).toHaveBeenCalledTimes(1);
  rerender(<Binder tree={treeA} openChapterId={second.id} onOpenChapter={onOpenChapter} locked />);
  for (const button of buttons(container)) {
    expect(button).toHaveAttribute("aria-disabled", "true"); act(() => button.focus()); fireEvent.click(button); expect(button).toHaveFocus();
  }
  expect(onOpenChapter).toHaveBeenCalledTimes(1);
});

test("AXB-0041 AC2 adds first and later chapters, reconciles failures and keeps the add button inert until re-read", async () => {
  let onOpenChapter = vi.fn(); let api = mockApi([
    { method: "GET", path: chaptersPath, reply: (_, n) => chapterList(n === 0 ? [] : [first]) },
    { method: "POST", path: chaptersPath, reply: reply(createdChapter, 201) },
  ]);
  let m = render(<Binder tree={treeA} onOpenChapter={onOpenChapter} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add the first scene" }));
  await waitFor(() => expect(rows(m.container)).toHaveLength(1));
  expect(onOpenChapter.mock.calls).toEqual([[chapterA.id]]); expect(api.calls.map(c => c.method)).toEqual(["GET", "POST", "GET"]); cleanup();
  const posted = deferred<ReturnType<typeof reply>>(); const reread = deferred<ReturnType<typeof chapterList>>();
  onOpenChapter = vi.fn(); api = mockApi([
    { method: "GET", path: chaptersPath, reply: (_, n) => n === 0 ? chapterList([first]) : reread.promise },
    { method: "POST", path: chaptersPath, reply: () => posted.promise },
  ]);
  m = render(<Binder tree={treeA} onOpenChapter={onOpenChapter} />);
  await waitFor(() => expect(add(m.container)).toBeInTheDocument());
  expect(add(m.container).previousElementSibling).toHaveAttribute("data-part", "chapter-list");
  fireEvent.click(add(m.container)); fireEvent.click(add(m.container)); expect(api.calls[1]).toMatchObject({ method: "POST", path: chaptersPath, body: { content: "" } });
  expect(add(m.container)).toHaveTextContent("Adding..."); expect(add(m.container)).toHaveAttribute("aria-disabled", "true");
  await act(async () => posted.resolve(reply(createdB, 201))); expect(onOpenChapter.mock.calls).toEqual([[second.id]]);
  expect(rows(m.container)).toHaveLength(1); expect(add(m.container)).toHaveAttribute("aria-disabled", "true"); expect(api.calls).toHaveLength(3);
  await act(async () => reread.resolve(chapterList([first, second]))); expect(rows(m.container)).toHaveLength(2); expect(add(m.container)).toHaveAttribute("aria-disabled", "false"); cleanup();
  for (const [result, readResult, expected] of [["network", chapterList([first, second]), "ready"], [internalError, chapterList([first]), "ready"], [reply(createdB, 201), internalError, "failed"]] as const) {
    onOpenChapter = vi.fn(); api = mockApi([
      { method: "GET", path: chaptersPath, reply: (_, n) => n === 0 ? chapterList([first]) : readResult },
      { method: "POST", path: chaptersPath, reply: result },
    ]);
    m = render(<Binder tree={treeA} onOpenChapter={onOpenChapter} />); await waitFor(() => expect(add(m.container)).toBeInTheDocument());
    fireEvent.click(add(m.container)); await waitFor(() => expect(list(m.container)).toHaveAttribute("data-state", expected));
    if (expected === "ready") await waitFor(() => expect(add(m.container)).toHaveAttribute("aria-disabled", "false"));
    if (result === internalError) expect(screen.getByRole("alert")).toHaveAttribute("data-part", "add-failure");
    else expect(m.container.querySelector('[data-part="add-failure"]')).toBeNull();
    expect(onOpenChapter.mock.calls).toEqual(expected === "failed" ? [[second.id]] : []);
    expect(api.calls.map(c => c.method)).toEqual(["GET", "POST", "GET"]); cleanup();
  }
  api = mockApi([{ method: "GET", path: chaptersPath, reply: chapterList([first]) }]);
  m = render(<Binder tree={treeA} locked />); await waitFor(() => expect(add(m.container)).toBeInTheDocument());
  expect(add(m.container)).toHaveAttribute("aria-disabled", "true"); fireEvent.click(add(m.container)); expect(api.calls).toHaveLength(1);
});

test("AXB-0041 AC3 refreshes each expanded ready Book silently, never a collapsed Book or unchanged token", async () => {
  const pending = deferred<ReturnType<typeof chapterList>>();
  const { calls } = mockApi([{ method: "GET", path: chaptersPath, reply: (_, n) => n === 0 ? chapterList([first]) : pending.promise }]);
  const tree = { ...treeA, books: [bookA, bookC] };
  const m = render(<Binder tree={tree} refreshToken={0} />); await waitFor(() => expect(rows(m.container)).toHaveLength(1));
  m.rerender(<Binder tree={tree} refreshToken={1} />); expect(calls.map(c => c.path)).toEqual([chaptersPath, chaptersPath]);
  expect(list(m.container)).toHaveAttribute("data-state", "ready"); expect(rows(m.container)).toHaveLength(1);
  await act(async () => pending.resolve(chapterList([first, second]))); expect(rows(m.container)).toHaveLength(2);
  m.rerender(<Binder tree={tree} refreshToken={1} />); expect(calls).toHaveLength(2);
});
