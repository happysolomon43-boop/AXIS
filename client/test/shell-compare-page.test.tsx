import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { redoDepth, undo, undoDepth } from "prosemirror-history";
import { TextSelection } from "prosemirror-state";
import { expect, test, vi } from "vitest";
import { Shell } from "../src/shell/Shell";
import { binderChapter, chapter, chapterPath, head, ok, proofRoutes, text, textPath, v1, v3, working } from "./d20Fixtures";
import { compareEntry, liveView, openDraft, recordEditor, part } from "./d20Ui";
import { chaptersPath, deferred, mockApi, treeA } from "./helpers";

vi.mock("../src/editor/Editor", async (original) => {
  const { Editor } = await original<typeof import("../src/editor/Editor")>();
  return { Editor: (props: Parameters<typeof Editor>[0]) => <Editor {...props} onReady={view => {
    recordEditor(view);
    props.onReady?.(view);
  }} /> };
});

const pairReads = [
  { method: "GET", path: textPath(v1), reply: ok(text(v1)) },
  { method: "GET", path: textPath(v3), reply: ok(text(v3)) },
];
const page = () => document.querySelector<HTMLElement>('[data-region="page"]');
const drawer = () => document.querySelector<HTMLElement>('[data-region="drawer"]');
const heading = () => screen.getByRole("heading", { name: "Compare versions" });

test("AC1 keeps the same Draft, backwards selection, document, undo history and scroll position", async () => {
  const second = "Second paragraph.";
  const two = { ...working, draft: { ...working.draft!, content: `${head}\n\n${second}`, blocks: [
    ...working.draft!.blocks, { ordinal: 2, kind: "paragraph", text: second, block_uid: null },
  ] } };
  const { calls } = mockApi([{ method: "GET", path: chapterPath + "/working-state?view=editor-lineage", reply: ok(two) }, ...proofRoutes, ...pairReads]);
  const { container } = render(<Shell tree={treeA} />);
  const view = await openDraft(container);
  act(() => {
    view.dispatch(view.state.tr.insertText("x", 2));
    undo(view.state, view.dispatch);
    const pos = view.state.doc.firstChild!.nodeSize;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 8, pos + 2)));
    view.focus();
  });
  const { doc, selection } = view.state;
  const history = [undoDepth(view.state), redoDepth(view.state)];
  expect(history[1]).toBeGreaterThan(0);
  const draftHost = part(container, "draft-host");
  const main = draftHost.parentElement!;
  main.scrollTop = 73;
  const compare = await compareEntry(container);
  fireEvent.click(compare);
  expect(heading()).toHaveFocus();
  expect(drawer()).toBeNull();
  expect(main.firstElementChild).toBe(draftHost);
  expect(draftHost.nextElementSibling).toBe(page());
  expect(draftHost).toHaveAttribute("hidden");
  expect(draftHost).not.toHaveAttribute("inert");
  expect(draftHost).not.toHaveAttribute("aria-hidden");
  expect(draftHost).not.toHaveAttribute("style");
  expect(page()).toHaveClass("ax-compare-host");
  expect(page()?.firstElementChild).toHaveClass("ax-compare-host__header");
  expect(page()?.lastElementChild).toHaveAttribute("data-surface", "compare");
  const back = screen.getByRole("button", { name: `Back to text · Chapter ${chapter.id} · block 2` });
  expect(back).toHaveClass("ax-compare-host__back");
  expect(back).toHaveAttribute("data-part", "compare-back");
  expect(back.firstElementChild).toHaveAttribute("aria-hidden", "true");
  expect(back.firstElementChild).toHaveAttribute("width", "16");
  expect(main.scrollTop).toBe(0);
  await screen.findByRole("region", { name: "Text A" });
  main.scrollTop = 19;
  fireEvent.click(back);
  expect(page()).toBeNull();
  expect(main.firstElementChild).toBe(draftHost);
  expect(draftHost).not.toHaveAttribute("hidden");
  expect(main.scrollTop).toBe(73);
  expect(liveView(container)).toBe(view);
  expect(view.state.doc).toBe(doc);
  expect([view.state.selection.anchor, view.state.selection.head]).toEqual([selection.anchor, selection.head]);
  expect([undoDepth(view.state), redoDepth(view.state)]).toEqual(history);
  expect(view.dom).toHaveFocus();
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

test("AC2 live guards reject composition, absent view and locked Draft before any comparison read", async () => {
  const held = deferred<ReturnType<typeof ok>>();
  const { calls } = mockApi([{ method: "GET", path: chapterPath + "/working-state?view=editor-lineage", reply: () => held.promise }, ...proofRoutes]);
  const { container } = render(<Shell tree={treeA} />);
  fireEvent.click(await screen.findByRole("button", { name: /Open Chapter 1/ }));
  const compare = await compareEntry(container);
  compare.focus();
  fireEvent.click(compare);
  expect(compare).toHaveFocus();
  expect(compare).toHaveAttribute("aria-disabled", "true");
  expect(page()).toBeNull();

  await act(async () => held.resolve(ok(working)));
  const view = liveView(container);
  expect(compare).not.toHaveAttribute("aria-disabled");
  fireEvent.compositionStart(view.dom);
  compare.focus();
  fireEvent.click(compare);
  expect(compare).toHaveAttribute("aria-disabled", "true");
  expect(compare).toHaveFocus();
  expect(page()).toBeNull();
  fireEvent.compositionEnd(view.dom);
  expect(compare).not.toHaveAttribute("aria-disabled");
  act(() => view.dispatch(view.state.tr.insertText("x", 2)));
  fireEvent.click(compare);
  expect(compare).toHaveAttribute("aria-disabled", "true");
  expect(page()).toBeNull();
  expect(calls.filter(call => call.path.endsWith("/text") || call.method !== "GET")).toEqual([]);
  expect(view.state.doc.textContent).toBe("Kxeep my line.");
});

test("AC3 Page keys never run Draft commands and Escape and the History door return to the correct focus", async () => {
  const { calls } = mockApi([...proofRoutes, ...pairReads]);
  const { container } = render(<Shell tree={treeA} />);
  const view = await openDraft(container);
  fireEvent.click(await compareEntry(container));
  await screen.findByRole("region", { name: "Text A" });
  expect(fireEvent.keyDown(heading(), { code: "KeyS", ctrlKey: true })).toBe(true);
  expect(fireEvent.keyDown(heading(), { code: "Enter", ctrlKey: true, shiftKey: true })).toBe(true);
  const select = screen.getByRole("combobox", { name: "Version A" });
  select.addEventListener("keydown", event => event.preventDefault(), { once: true });
  fireEvent.keyDown(select, { key: "Escape" });
  expect(page()).not.toBeNull();
  fireEvent.keyDown(heading(), { key: "Escape" });
  expect(page()).toBeNull();
  expect(view.dom).toHaveFocus();
  expect(part(container, "draft-host")).not.toHaveAttribute("hidden");

  fireEvent.click(await compareEntry(container));
  fireEvent.click(part(container, "history-door"));
  expect(page()).toBeNull();
  expect(drawer()).toHaveFocus();
  expect(view.dom).not.toHaveFocus();
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

test("AC4 an accepted chapter switch discards the read and leaves the next chapter's editor in focus", async () => {
  const other = { ...chapter, id: "ch_000000000002", order_key: "0000002000" };
  const next = { ...working, chapter: other, version: { ...working.version!, chapter_id: other.id } };
  const pending = deferred<ReturnType<typeof ok>>();
  const { calls } = mockApi([
    { method: "GET", path: chaptersPath, reply: ok({ chapters: [binderChapter, { ...binderChapter, ...other, title: "Beyond the ash" }] }) },
    { method: "GET", path: `/api/chapters/${other.id}/working-state?view=editor-lineage`, reply: ok(next) },
    { method: "GET", path: textPath(v1), reply: () => pending.promise },
    ...proofRoutes, pairReads[1],
  ]);
  const { container } = render(<Shell tree={treeA} />);
  const old = await openDraft(container);
  fireEvent.click(await compareEntry(container));
  await screen.findByRole("status");
  await waitFor(() => expect(calls.some(call => call.path === textPath(v1))).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: /Open Chapter 2/ }));
  await screen.findByRole("textbox", { name: "Chapter text" });
  const current = liveView(container);
  expect(current).not.toBe(old);
  expect(old.isDestroyed).toBe(true);
  expect(current.dom).toHaveFocus();
  const selection = current.state.selection;
  await act(async () => pending.resolve(ok(text(v1))));
  expect(page()).toBeNull();
  expect(drawer()).toBeNull();
  expect(liveView(container)).toBe(current);
  expect(current.state.selection).toBe(selection);
  expect(current.dom).toHaveFocus();
  expect(screen.queryByRole("region", { name: "Text A" })).toBeNull();
});
