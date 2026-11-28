import { receiptRoute, workingPath, writeResponse, writeResult } from "./writeFixtures";
import type { EditorDocument, WriteResult } from "../src/api/types";
import { act, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { b, c, chapterPath, detailText, reply, writtenC } from "./d06.fixtures";
import {
  advance, conflictEnvelope, draftHeadB, draftHeadOther, draftNone, draftPath, edit, fakeClock, mountDraft, putOk,
} from "./draftFixtures";
import { deferred, internalError } from "./helpers";

afterEach(() => vi.useRealTimers());

function unloadPrevented() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const expectedBlocks = [["heading", "Title"], ["paragraph", "One"], ["scene_break", ""], ["paragraph", "Two!"]];
const edited = "# Title\n\nOne\n\n---\n\nTwo!";

test("AC2 opens on a persisted head, fails on a mismatched or unreadable head, and retries the working-state read", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  let ui = mountDraft({ draft: () => pending.promise });
  await act(async () => {});
  expect(ui.calls.map(({ method, path }) => [method, path])).toEqual([["GET", workingPath(chapterPath)]]);
  expect(ui.root).toHaveAttribute("data-state", "loading");
  await act(async () => { pending.resolve(reply(draftHeadB)); });
  expect(ui.root).toHaveAttribute("data-state", "unsaved");
  expect(ui.blocks()).toEqual(expectedBlocks);
  expect(ui.root).toHaveAttribute("data-autosave", "saved");
  expect(ui.part("status")).toBeEmptyDOMElement();
  expect(ui.part("save")).toHaveAttribute("aria-disabled", "false");
  expect(ui.part("send")).toHaveAttribute("aria-disabled", "false");
  expect(ui.onLockChange).not.toHaveBeenCalled();
  expect(ui.onWritten).not.toHaveBeenCalled();
  expect(ui.calls).toHaveLength(1);
  expect(ui.part("editor")).toHaveFocus();
  ui.unmount();

  ui = mountDraft({ draft: reply({ ...draftHeadB, draft: { ...draftHeadB.draft, base_version: c } }) });
  await ui.loaded("failed");
  expect(ui.part("editor")).toBeNull();
  ui.unmount();

  ui = mountDraft({ chapter: reply({ ...detailText, version: null }) });
  await ui.loaded("failed");
  expect(ui.calls.map(({ path }) => path)).toEqual([workingPath(chapterPath)]);
  ui.unmount();

  ui = mountDraft({ draft: (_, n) => n === 0 ? internalError : reply(draftNone) });
  await ui.loaded("failed");
  fireEvent.click(ui.part("try-again"));
  await ui.loaded();
  expect(ui.calls.map(({ method, path }) => [method, path])).toEqual([
    ["GET", workingPath(chapterPath)], ["GET", workingPath(chapterPath)],
  ]);
  expect(ui.root).toHaveAttribute("data-autosave", "idle");
});

test("AC3 autosaves on idle, unlocks after success, observes the minimum gap, and retries failures", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  let ui = mountDraft({ put: (_, n) => n === 0 ? pending.promise : reply(putOk(2)) });
  await ui.loaded();
  fakeClock();
  edit(ui.view());
  expect(ui.root).toHaveAttribute("data-autosave", "pending");
  expect(ui.root).toHaveAttribute("data-state", "unsaved");
  expect(ui.onLockChange.mock.calls).toEqual([[true]]);
  expect(unloadPrevented()).toBe(true);
  expect(ui.part("status")).toHaveTextContent("Unsaved changes. Save or send before opening another chapter.");
  await advance(1999);
  expect(ui.puts()).toHaveLength(0);
  await advance(1);
  expect(ui.puts()).toHaveLength(1);
  expect(ui.puts()[0].body).toEqual({ content: edited, base_version: b, base_revision: 0 , editor_document: expect.any(Array)});
  expect(ui.root).toHaveAttribute("data-autosave", "saving");
  expect(ui.part("editor")).toHaveAttribute("contenteditable", "true");
  await act(async () => { pending.resolve(reply(putOk(1))); });
  expect(ui.root).toHaveAttribute("data-autosave", "saved");
  expect(ui.onLockChange.mock.calls).toEqual([[true], [false]]);
  expect(unloadPrevented()).toBe(false);
  expect(ui.part("status")).toBeEmptyDOMElement();
  expect(ui.part("autosave")).toBeEmptyDOMElement();
  expect(ui.calls.some(({ method }) => method === "POST")).toBe(false);
  expect(ui.onWritten).not.toHaveBeenCalled();

  await advance(100);
  edit(ui.view(), "?");
  await advance(4899);
  expect(ui.puts()).toHaveLength(1);
  await advance(1);
  expect(ui.puts()[1].body).toEqual({ content: edited + "?", base_version: b, base_revision: 1 , editor_document: expect.any(Array)});
  ui.unmount();
  vi.useRealTimers();

  ui = mountDraft({ put: (_, n) => n === 0 ? internalError : reply(putOk(n)) });
  await ui.loaded();
  fakeClock();
  edit(ui.view());
  await advance(2000);
  expect(ui.root).toHaveAttribute("data-autosave", "failed");
  expect(ui.part("autosave")).toHaveTextContent("The draft could not be saved.");
  expect(ui.onLockChange.mock.calls).toEqual([[true]]);
  await advance(29999);
  expect(ui.puts()).toHaveLength(1);
  await advance(1);
  expect(ui.puts()).toHaveLength(2);
  expect(ui.puts()[1].body).toEqual(ui.puts()[0].body);
  expect(ui.root).toHaveAttribute("data-autosave", "saved");
  expect(ui.part("autosave")).toBeEmptyDOMElement();

  const view = ui.view();
  const end = view.state.doc.content.size - 1;
  act(() => view.dispatch(view.state.tr.delete(end - 1, end)));
  expect(ui.root).toHaveAttribute("data-state", "clean");
  expect(ui.root).toHaveAttribute("data-autosave", "pending");
  await advance(5000);
  expect(ui.puts()[2].body).toEqual({ content: detailText.version!.content, base_version: b, base_revision: 1 , editor_document: expect.any(Array)});
  expect(ui.root).toHaveAttribute("data-autosave", "idle");

  edit(view);
  ui.unmount();
  await advance(60000);
  expect(ui.puts()).toHaveLength(3);
});

test("AC4 adopts matching conflicts, stops unresolved ones, and settles the head around explicit writes", async () => {
  const adopted = { ...draftHeadB, draft: { ...draftHeadB.draft, revision: 3 } };
  let attempted: EditorDocument;
  let ui = mountDraft({
    draft: (_, n) => reply(n === 0 ? draftNone : {...adopted,editor_document:attempted}),
    put: (call, n) => { if(n===0){attempted=(call.body as {editor_document:EditorDocument}).editor_document;return conflictEnvelope;}return reply(putOk(4)); },
  });
  await ui.loaded();
  fakeClock();
  edit(ui.view());
  await advance(2000);
  expect(ui.calls.map(({ method, path }) => [method, path])).toEqual([
    ["GET", workingPath(chapterPath)], ["PUT", draftPath], ["GET", workingPath(chapterPath)],
  ]);
  expect(ui.root).toHaveAttribute("data-autosave", "saved");
  edit(ui.view(), "?");
  await advance(5000);
  expect(ui.puts()[1].body).toEqual({ content: edited + "?", base_version: b, base_revision: 3 , editor_document: expect.any(Array)});
  ui.unmount();
  vi.useRealTimers();

  for (const read of [reply(draftHeadOther), internalError]) {
    ui = mountDraft({ draft: (_, n) => n === 0 ? reply(draftNone) : read, put: conflictEnvelope });
    await ui.loaded();
    fakeClock();
    edit(ui.view());
    await advance(2000);
    expect(ui.root).toHaveAttribute("data-autosave", "stopped");
    await advance(60000);
    expect(ui.puts()).toHaveLength(1);
    expect(ui.onLockChange).toHaveBeenLastCalledWith(true);
    ui.unmount();
    vi.useRealTimers();
  }

  for (const action of ["save", "send"] as const) {
    const putResponse = deferred<ReturnType<typeof reply>>();
    const adoption = deferred<ReturnType<typeof reply>>();
    const path = `${chapterPath}/${action === "save" ? "versions" : "send"}`;
    ui = mountDraft({
      draft: (_, n) => n === 0 ? reply(draftNone) : adoption.promise,
      put: (_, n) => n === 0 ? putResponse.promise : reply(putOk(1)),
      writes: [{ method: "POST", path, reply: call => writeResponse(call, reply(writtenC(action === "save" ? null : c), 201)) }],
    });
    await ui.loaded();
    fakeClock();
    edit(ui.view());
    await advance(2000);
    fireEvent.click(ui.part(action));
    expect(ui.calls.some(({ method }) => method === "POST")).toBe(false);
    await act(async () => { putResponse.resolve(action === "save" ? reply(putOk(1)) : conflictEnvelope); });
    if (action === "send") {
      expect(ui.calls.at(-1)).toMatchObject({ method: "GET", path: workingPath(chapterPath) });
      expect(ui.calls.some(({ method }) => method === "POST")).toBe(false);
      await act(async () => { adoption.resolve(reply(draftHeadOther)); });
      expect(ui.root).toHaveAttribute("data-state", "conflict");
      expect(ui.calls.filter(({ method }) => method === "POST")).toHaveLength(0);
      expect(ui.part("editor")).toHaveTextContent("Two!");
      ui.unmount();
      vi.useRealTimers();
      continue;
    }
    expect(ui.calls.filter(({ method }) => method === "POST")).toEqual([
      expect.objectContaining({ path, body: expect.objectContaining({ content: edited, parent_version: b, base_version: b, base_revision: 1 }) }),
    ]);
    expect(ui.root).toHaveAttribute("data-state", "clean");
    expect(ui.root).toHaveAttribute("data-autosave", "idle");
    edit(ui.view(), "?");
    await advance(2000);
    expect(ui.puts()[1].body).toEqual({ content: edited + "?", base_version: c, base_revision: 0 , editor_document: expect.any(Array)});
    ui.unmount();
    vi.useRealTimers();
  }

  for (const put of [reply(putOk(1)), internalError]) {
    ui = mountDraft({ put, writes: [{ method: "POST", path: `${chapterPath}/versions`, reply: internalError }] });
    await ui.loaded();
    fakeClock();
    edit(ui.view());
    await advance(2000);
    await act(async () => { fireEvent.click(ui.part("save")); });
    expect(ui.root).toHaveAttribute("data-state", "check-failed");
    if (put.status === 200) expect(ui.part("only-here")).toBeNull();
    else expect(ui.part("only-here")).toHaveTextContent("This text exists only in this window. Copy it out now");
    ui.unmount();
    vi.useRealTimers();
  }

  const oldPut = deferred<ReturnType<typeof reply>>();
  let receipt: WriteResult;
  ui = mountDraft({
    put: (_, n) => n === 0 ? oldPut.promise : reply(putOk(1)),
    writes: [
      { method: "POST", path: `${chapterPath}/versions`, reply: call => { receipt = writeResult(call, writtenC(null)); return internalError; } },
      { method: "GET", path: receiptRoute, reply: (_, n) => n === 0 ? internalError : reply({ receipt }) },
    ],
  });
  await ui.loaded();
  fakeClock();
  edit(ui.view());
  await act(async () => { fireEvent.click(ui.part("save")); });
  expect(ui.root).toHaveAttribute("data-state", "check-failed");
  await advance(2000);
  expect(ui.root).toHaveAttribute("data-autosave", "saving");
  await act(async () => { fireEvent.click(ui.part("check-again")); });
  expect(ui.root).toHaveAttribute("data-state", "clean");
  expect(ui.onWritten).toHaveBeenCalledTimes(1);
  await act(async () => { oldPut.resolve(conflictEnvelope); });
  expect(ui.root).toHaveAttribute("data-autosave", "idle");
  edit(ui.view(), "?");
  await advance(2000);
  expect(ui.puts()[1].body).toEqual({ content: edited + "?", base_version: c, base_revision: 0 , editor_document: expect.any(Array)});
});

test.each(["save", "send"])("%s waits for a failing autosave and leaves the intended text in the editor", async action => {
  const pending = deferred<ReturnType<typeof reply>>();
  const ui = mountDraft({ put: () => pending.promise });
  await ui.loaded();
  fakeClock();
  edit(ui.view());
  await advance(2000);
  const view = ui.view();
  const doc = view.state.doc;
  fireEvent.click(ui.part(action));
  expect(ui.calls.filter(({ method }) => method === "POST")).toHaveLength(0);
  await act(async () => { pending.resolve(internalError); });
  expect(ui.root).toHaveAttribute("data-state", "write-failed");
  expect(ui.calls.filter(({ method }) => method === "POST")).toHaveLength(0);
  expect(ui.onWritten).not.toHaveBeenCalled();
  expect(ui.onEditorReady).toHaveBeenCalledTimes(1);
  expect(view.state.doc).toBe(doc);
});
