import { act, fireEvent, render, screen } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";
import { afterEach, expect, test, vi } from "vitest";
import { Shell } from "../src/shell/Shell";
import { chapterList, chapterPath, detailText, fourRows, reply } from "./d06.fixtures";
import { draftNone, draftPath, edit, fakeClock } from "./draftFixtures";
import { chaptersPath, deferred, mockApi, treeA } from "./helpers";
import { historyPath, versionPath, versionTextB } from "./historyFixtures";
import { historyAfterRestore, historyH3, restorePath, restoreReply, rowB } from "./restoreFixtures";

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

const pathB = "/api/chapters/ch_00000000000b";
const chapterB = { ...detailText.chapter, id: "ch_00000000000b", order_key: "0000002000" };
const detailB = { ...detailText, chapter: chapterB, version: { ...detailText.version!, chapter_id: chapterB.id } };
const restoredDetail = {
  ...detailText,
  version: { ...restoreReply.body.version, content: detailText.version!.content },
  active_version_id: restoreReply.body.active_version_id,
};

async function mount({ pending, secondChapter = false }: {
  pending?: Promise<typeof restoreReply>; secondChapter?: boolean;
} = {}) {
  editor.view = null;
  const { calls } = mockApi([
    { method: "GET", path: chaptersPath, reply: chapterList(fourRows.slice(0, secondChapter ? 2 : 1)) },
    { method: "GET", path: chapterPath, reply: (_, n) => reply(n === 0 ? detailText : restoredDetail) },
    { method: "GET", path: draftPath, reply: reply(draftNone) },
    { method: "GET", path: historyPath, reply: (_, n) => reply(n === 0 ? historyH3 : historyAfterRestore) },
    { method: "GET", path: versionPath(rowB.id), reply: reply(versionTextB) },
    { method: "POST", path: restorePath, reply: () => pending ?? restoreReply },
    { method: "GET", path: pathB, reply: reply(detailB) },
    { method: "GET", path: `${pathB}/draft`, reply: reply({ chapter: chapterB, draft: null }) },
    { method: "GET", path: `${pathB}/history`, reply: reply({ chapter: chapterB, versions: [], active_version_id: null }) },
  ]);
  const ui = render(<Shell tree={treeA} />);
  const part = (name: string) => ui.container.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  const draft = () => ui.container.querySelector('[data-surface="draft"]');
  const open = async (name: string) => {
    const button = await screen.findByRole("button", { name });
    await act(async () => { fireEvent.click(button); });
    expect(draft()).toHaveAttribute("data-state", "clean");
  };

  await open("Open Chapter 1: Title");
  const preview = async () => {
    await act(async () => { fireEvent.click(part("history-door")); });
    const [, row] = ui.container.querySelectorAll('[data-part="version-open"]');
    await act(async () => { fireEvent.click(row); });
    expect(part("version-detail")).toHaveAttribute("data-state", "ready");
  };
  return {
    ...ui, calls, part, draft, open, preview,
    posts: () => calls.filter(({ method }) => method === "POST"),
    readsAfter: (n: number) => calls.slice(n).map(({ method, path }) => `${method} ${path}`).sort(),
  };
}

test("AC2 prevents a restore while the Draft has an unsaved edit", async () => {
  const ui = await mount();
  fakeClock();
  edit(editor.view!);
  expect(ui.draft()).toHaveAttribute("data-state", "unsaved");
  await ui.preview();

  const button = ui.part("version-restore");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(ui.part("restore-blocked").textContent).toBe("Finish saving this chapter before restoring a version.");
  fireEvent.click(button);
  expect(ui.posts()).toHaveLength(0);
  expect(ui.calls.every(({ method }) => method === "GET")).toBe(true);
});

test("AC3 keeps the same Draft, its edits and its lock when it becomes unsaved after the press", async () => {
  const post = deferred<typeof restoreReply>();
  const ui = await mount({ pending: post.promise });
  await ui.preview();
  const draft = ui.draft();
  const oldEditor = ui.part("editor");

  fakeClock();
  fireEvent.click(ui.part("version-restore"));
  expect(ui.posts()).toHaveLength(1);
  edit(editor.view!);
  const start = ui.calls.length;
  await act(async () => { post.resolve(restoreReply); });

  expect(ui.draft()).toBe(draft);
  expect(draft).toHaveAttribute("data-state", "unsaved");
  expect(ui.part("editor")).toBe(oldEditor);
  expect(oldEditor).toHaveTextContent("Two!");
  expect(ui.part("restore-status").textContent).toBe(
    "Restored as a new version. The text in your draft was not replaced.",
  );
  expect(ui.readsAfter(start)).toEqual([`GET ${chaptersPath}`, `GET ${historyPath}`].sort());
  expect(ui.calls.filter(({ method }) => method === "PUT")).toHaveLength(0);
});

test("AC4 handles a late success after the Drawer closes or a different chapter opens", async () => {
  const post = deferred<typeof restoreReply>();
  const ui = await mount({ pending: post.promise });
  await ui.preview();
  const draft = ui.draft();
  fireEvent.click(ui.part("version-restore"));
  fireEvent.click(ui.part("drawer-close"));
  expect(ui.part("drawer-body")).toBeNull();
  const closed = ui.calls.length;
  await act(async () => { post.resolve(restoreReply); });
  expect(ui.draft()).toBe(draft);
  expect(ui.draft()).toHaveAttribute("data-state", "clean");
  expect(ui.readsAfter(closed)).toEqual([`GET ${chapterPath}`, `GET ${draftPath}`, `GET ${chaptersPath}`].sort());
  ui.unmount();

  const later = deferred<typeof restoreReply>();
  const switched = await mount({ pending: later.promise, secondChapter: true });
  await switched.preview();
  fireEvent.click(switched.part("version-restore"));
  await switched.open("Open Chapter 2");
  expect(switched.part("empty")).toHaveTextContent("No versions yet.");
  const otherDraft = switched.draft();
  const otherEditor = switched.part("editor");
  const changed = switched.calls.length;
  await act(async () => { later.resolve(restoreReply); });
  expect(switched.draft()).toBe(otherDraft);
  expect(switched.part("editor")).toBe(otherEditor);
  expect(switched.part("restore-status")).toBeNull();
  expect(switched.readsAfter(changed)).toEqual([`GET ${chaptersPath}`]);
});
