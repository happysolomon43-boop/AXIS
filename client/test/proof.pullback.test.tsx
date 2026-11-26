import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";
import { afterEach, expect, test, vi } from "vitest";
import { Shell } from "../src/shell/Shell";
import { chapterPath, detailText, reply } from "./d06.fixtures";
import { draftPath, edit, fakeClock, noDraftRead } from "./draftFixtures";
import { chaptersPath, deferred, mockApi } from "./helpers";
import { pbList, pbListAfterB, pbTree } from "./pullbackFixtures";

const editor = vi.hoisted(() => ({ view: null as EditorView | null }));
vi.mock("../src/editor/Editor", async (importOriginal) => {
  const { Editor } = await importOriginal<typeof import("../src/editor/Editor")>();
  return { Editor: (props: Parameters<typeof Editor>[0]) => (
    <Editor {...props} onReady={(view) => {
      editor.view = view;
      props.onReady?.(view);
    }} />
  ) };
});

afterEach(() => vi.useRealTimers());

test("AXB-0073 AC2 recognizes a lost Pull back reply and keeps the writer's unsaved Draft", async () => {
  const post = deferred<"network">();
  const b = pbList.chapters[1];
  const path = `/api/chapters/${b.id}/pull-back`;
  const { calls } = mockApi([
    { method: "GET", path: chaptersPath, reply: (_, n) => reply(n === 0 ? pbList : pbListAfterB) },
    { method: "GET", path: chapterPath, reply: reply(detailText) },
    noDraftRead,
    { method: "POST", path, reply: () => post.promise },
  ]);
  const { container } = render(<Shell tree={pbTree} />);
  const currentDraft = () => container.querySelector('[data-surface="draft"]');
  const openA = await screen.findByRole("button", { name: "Open Chapter 1" });
  fireEvent.click(openA);
  await waitFor(() => expect(currentDraft()).toHaveAttribute("data-state", "clean"));
  const draft = currentDraft();
  const editorNode = draft?.querySelector('[data-part="editor"]');
  const buttonB = screen.getByRole("button", { name: "Pull back Chapter 2" });
  const rowB = buttonB.parentElement!;

  fakeClock();
  fireEvent.click(buttonB);
  expect(buttonB).toHaveTextContent(/^Pulling back\.\.\.$/);
  edit(editor.view!);
  expect(editorNode).toHaveTextContent("Two!");
  expect(draft).toHaveAttribute("data-state", "unsaved");
  expect(draft).toHaveAttribute("data-autosave", "pending");
  const autosave = draft?.getAttribute("data-autosave");
  await act(async () => { post.resolve("network"); });

  expect(rowB.querySelector('[data-part="chip"]')).toHaveTextContent("Being revised, no changes yet");
  expect(rowB.querySelector('[data-part="chapter-pull-back"]')).toBeNull();
  expect(container.querySelector('[data-part="pull-back-failure"]')).toBeNull();
  expect(currentDraft()).toBe(draft);
  expect(draft?.querySelector('[data-part="editor"]')).toBe(editorNode);
  expect(editorNode).toHaveTextContent("Two!");
  expect(draft).toHaveAttribute("data-state", "unsaved");
  expect(draft).toHaveAttribute("data-autosave", autosave);
  expect(container.querySelectorAll('[data-surface="draft"]')).toHaveLength(1);
  expect(openA).toHaveAttribute("aria-disabled", "true");
  const remaining = screen.getAllByRole("button", { name: /^Pull back Chapter/ });
  expect(remaining).toHaveLength(1);
  for (const button of remaining) expect(button).toHaveAttribute("aria-disabled", "true");
  expect(calls.map(({ method, path }) => [method, path])).toEqual([
    ["GET", chaptersPath], ["GET", chapterPath], ["GET", draftPath], ["POST", path], ["GET", chaptersPath],
  ]);
  expect(calls[3].body).toBeUndefined();
});
