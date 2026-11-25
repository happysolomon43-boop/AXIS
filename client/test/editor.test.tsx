import { act, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Editor } from "../src/editor/Editor";
import { blocksFromServed } from "../src/editor/model";
import { detailText } from "./d06.fixtures";

test("AXB-0039 AC1 draws blocks, dispatches changes, undoes and splits using base keymap", () => {
  const blocks = blocksFromServed(detailText.blocks);
  const changed = vi.fn();
  const ready = vi.fn<(view: EditorView) => void>();
  const { container } = render(<Editor blocks={blocks} editable onDocChange={changed} onReady={ready} />);
  const editor = screen.getByRole("textbox", { name: "Chapter text" });
  expect(container.querySelector('[data-part="editor-host"]')).toContainElement(editor);
  expect(editor).toHaveAttribute("data-part", "editor");
  expect(editor).toHaveAttribute("aria-multiline", "true");
  expect(editor).toHaveAttribute("contenteditable", "true");
  expect([...editor.querySelectorAll("[data-block]")].map((el) => [el.tagName, el.getAttribute("data-block"), el.textContent])).toEqual([
    ["H2", "heading", "Title"], ["P", "paragraph", "One"], ["HR", "scene_break", ""], ["P", "paragraph", "Two"],
  ]);
  expect(editor.querySelector("hr")).toHaveAttribute("aria-label", "Scene break");
  expect(ready).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
  const view = ready.mock.calls[0][0];
  const initial = view.state.doc;
  expect(initial.childCount).toBe(4);
  act(() => view.dispatch(view.state.tr.insertText("!", view.state.doc.content.size - 1)));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(view.state.doc.lastChild?.textContent).toBe("Two!");
  act(() => { view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "z", ctrlKey: true }))); });
  expect(view.state.doc.eq(initial)).toBe(true);
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc))));
  act(() => { view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "Enter" }))); });
  expect(view.state.doc.childCount).toBe(5);
  expect(view.state.doc.lastChild?.type.name).toBe("paragraph");
  expect(view.state.doc.lastChild?.textContent).toBe("");
});

test("AXB-0039 AC2 guards read-only changes, ignores new blocks, and destroys the editor", () => {
  const changed = vi.fn(); const ready = vi.fn<(view: EditorView) => void>();
  const { rerender, unmount } = render(<Editor blocks={[]} editable={false} onDocChange={changed} onReady={ready} />);
  const editor = screen.getByRole("textbox");
  expect(editor).toHaveAttribute("contenteditable", "false");
  expect(editor.querySelectorAll('p[data-block="paragraph"]')).toHaveLength(1);
  const view = ready.mock.calls[0][0];
  const initial = view.state.doc;
  act(() => view.dispatch(view.state.tr.insertText("Hi", 1)));
  expect(view.state.doc.eq(initial)).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  rerender(<Editor blocks={[]} editable onDocChange={changed} onReady={ready} />);
  expect(editor).toHaveAttribute("contenteditable", "true");
  act(() => view.dispatch(view.state.tr.insertText("Hi", 1)));
  expect(changed).toHaveBeenCalledTimes(1);
  rerender(<Editor blocks={blocksFromServed(detailText.blocks)} editable onDocChange={changed} onReady={ready} />);
  expect(view.state.doc.textContent).toBe("Hi");
  expect(ready).toHaveBeenCalledTimes(1);
  unmount();
  expect(editor).not.toBeInTheDocument();
});
