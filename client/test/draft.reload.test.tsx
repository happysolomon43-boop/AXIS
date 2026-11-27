import { workingPath, workingRead } from "./writeFixtures";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";
import { afterEach, expect, test, vi } from "vitest";
import { Draft } from "../src/draft/Draft";
import { chapterA, chapterPath, detailText, reply } from "./d06.fixtures";
import { advance, draftNone, draftPath, edit, fakeClock, putOk } from "./draftFixtures";
import { chaptersPath, deferred, mockApi, type Call } from "./helpers";
import { historyPath, internalEnvelope } from "./historyFixtures";
import { restorePath, restoreReply, rowB } from "./restoreFixtures";
import { detailAfterRestore, mountRestore, restoredText, syncInBook, withSync } from "./syncDraftFixtures";

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

const draftReads = (calls: Call[]) => calls.filter(({ method, path }) => method === "GET" && (path === workingPath(chapterPath) || path === draftPath))
  .map(({ path }) => path);
const readHead = () => withSync({ status: 200, body: draftNone }, syncInBook);
afterEach(() => vi.useRealTimers());

test("AXB-0079 AC1 reloads with the old Draft and Editor visible until both reads complete", async () => {
  const chapter = deferred<ReturnType<typeof reply>>();
  const head = deferred<ReturnType<typeof readHead>>();
  const ui = await mountRestore({ chapter: () => chapter.promise, head: () => head.promise });
  const root = ui.root();
  const previousEditor = ui.part("editor", root);
  const start = ui.calls.length;
  await act(async () => { fireEvent.click(ui.part("version-restore")); });

  const stillReading = () => {
    expect(ui.root()).toBe(root);
    expect(root).toHaveAttribute("data-state", "reloading");
    expect(ui.part("editor", root)).toBe(previousEditor);
    expect(previousEditor).toHaveTextContent("Two");
    expect(ui.part("reading", root)).toBeNull();
  };
  stillReading();
  expect(draftReads(ui.calls)).toEqual([workingPath(chapterPath), workingPath(chapterPath)]);
  await act(async () => { chapter.resolve(reply(detailAfterRestore)); });
  stillReading();
  expect(draftReads(ui.calls)).toEqual([workingPath(chapterPath), workingPath(chapterPath)]);
  await act(async () => { head.resolve(readHead()); });
  expect(ui.root()).toBe(root);
  expect(root).toHaveAttribute("data-state", "clean");
  expect(ui.part("editor", root)).not.toBe(previousEditor);
  expect(ui.part("editor", root)).toHaveTextContent(restoredText);
  expect(ui.part("reading", root)).toBeNull();
  expect(ui.part("restore-status")).toHaveTextContent("Restored into your draft. The Book is unchanged until you send.");
  expect(ui.calls.slice(start).map(({ method, path }) => method + " " + path).sort()).toEqual([
    "GET " + workingPath(chapterPath), "GET " + chaptersPath, "GET " + historyPath, "POST " + restorePath,
  ].sort());
  expect(ui.calls.find(({ method }) => method === "POST")?.body).toMatchObject({ version_id: rowB.id, request_id: expect.any(String) });
});

test("AXB-0079 AC2 either failing reload read keeps the text and retries via Reload latest", async () => {
  for (const failing of ["chapter", "head"]) {
    const ui = await mountRestore(failing === "chapter"
      ? { chapter: (_, n) => n === 0 ? internalEnvelope : reply(detailAfterRestore) }
      : { head: (_, n) => n === 0 ? internalEnvelope : readHead() });
    const root = ui.root();
    const previousEditor = ui.part("editor", root);
    await act(async () => { fireEvent.click(ui.part("version-restore")); });
    expect(ui.root()).toBe(root);
    expect(root).toHaveAttribute("data-state", "conflict");
    expect(root).toHaveAttribute("data-autosave", "stopped");
    expect(ui.part("reload-failure", root)).toBeInTheDocument();
    expect(ui.part("editor", root)).toBe(previousEditor);
    expect(previousEditor).toHaveTextContent("Two");
    expect(ui.part("reading", root)).toBeNull();
    await act(async () => { fireEvent.click(ui.part("reload-latest", root)); });
    expect(root).toHaveAttribute("data-state", "clean");
    expect(ui.part("editor", root)).toHaveTextContent(restoredText);
    ui.unmount();
  }
});

test("AXB-0079 AC3 keeps a locked Draft and ignores tokens while loading, failed or saving a head", async () => {
  const held = deferred<typeof restoreReply>();
  const shell = await mountRestore({ restore: () => held.promise });
  const root = shell.root();
  fakeClock();
  fireEvent.click(shell.part("version-restore"));
  edit(editor.view!);
  await act(async () => { held.resolve(restoreReply); });
  expect(shell.root()).toBe(root);
  expect(root).toHaveAttribute("data-state", "unsaved");
  expect(shell.part("editor", root)).toHaveTextContent("Two!");
  expect(shell.part("restore-status")).toHaveTextContent("Restored as a new version. The text in your draft was not replaced.");
  expect(draftReads(shell.calls)).toEqual([workingPath(chapterPath)]);
  expect(shell.calls.filter(({ method }) => method === "PUT")).toHaveLength(0);
  shell.unmount();
  vi.useRealTimers();

  const renderDraft = (token: number) => <Draft chapterId={chapterA.id} reloadToken={token}
    onLockChange={vi.fn()} onWritten={vi.fn()} />;
  const open = deferred<ReturnType<typeof reply>>();
  const initial = mockApi([workingRead(chapterPath, () => open.promise)]);
  const pending = render(renderDraft(0));
  const pendingRoot = pending.container.querySelector('[data-surface="draft"]');
  expect(pendingRoot).toHaveAttribute("data-state", "loading");
  pending.rerender(renderDraft(1));
  expect(initial.calls).toHaveLength(1);
  await act(async () => { open.resolve(internalEnvelope); });
  expect(pendingRoot).toHaveAttribute("data-state", "failed");
  pending.rerender(renderDraft(2));
  expect(initial.calls).toHaveLength(1);
  pending.unmount();

  const put = deferred<ReturnType<typeof reply>>();
  const busy = mockApi([
    workingRead(chapterPath, reply(detailText), readHead()),
    { method: "PUT", path: draftPath, reply: () => put.promise },
  ]);
  const ui = render(renderDraft(0));
  const busyRoot = ui.container.querySelector('[data-surface="draft"]');
  await waitFor(() => expect(busyRoot).toHaveAttribute("data-state", "clean"));
  fakeClock();
  edit(editor.view!);
  await advance(2000);
  // Return to the baseline during the PUT: the Draft is unlocked but still has an in-flight request.
  act(() => {
    const view = editor.view!;
    const end = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.delete(end - 1, end));
  });
  expect(busyRoot).toHaveAttribute("data-state", "clean");
  expect(busyRoot).toHaveAttribute("data-autosave", "saving");
  ui.rerender(renderDraft(1));
  expect(draftReads(busy.calls)).toEqual([workingPath(chapterPath)]);
  await act(async () => { put.resolve(reply(putOk(1))); });
  expect(draftReads(busy.calls)).toEqual([workingPath(chapterPath)]);
  ui.unmount();
});

test("AXB-0079 AC4 records the token when selecting a new chapter and ignores an unchanged token", async () => {
  const ui = await mountRestore();
  await act(async () => { fireEvent.click(ui.part("version-restore")); });
  expect(ui.part("editor", ui.root())).toHaveTextContent(restoredText);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open Chapter 2" })); });
  expect(ui.root()).toHaveAttribute("data-state", "clean");
  expect(ui.calls.filter(({ path }) => path === workingPath(ui.pathB)).map(({ method, path }) => [method, path]))
    .toEqual([["GET", workingPath(ui.pathB)]]);
  ui.unmount();

  const { calls } = mockApi([
    workingRead(chapterPath, reply(detailText), readHead()),
  ]);
  const props = { chapterId: chapterA.id, reloadToken: 1, onLockChange: vi.fn(), onWritten: vi.fn() };
  const draft = render(<Draft {...props} />);
  await waitFor(() => expect(draft.container.querySelector('[data-surface="draft"]')).toHaveAttribute("data-state", "clean"));
  draft.rerender(<Draft {...props} />);
  expect(draftReads(calls)).toEqual([workingPath(chapterPath)]);
});
