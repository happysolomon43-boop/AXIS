import { act, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { b, c, d, chapterPath, detailText, reply, writtenC } from "./d06.fixtures";
import { advance, detailD, draftHeadB, draftHeadD, draftNone, draftPath, edit, mountConflict } from "./draftFixtures";
import { deferred, internalError } from "./helpers";

afterEach(() => vi.useRealTimers());

const edited = "# Title\n\nOne\n\n---\n\nTwo!";
const failureCopy = "The latest version could not be read. Your text is still here.";
const versionPath = `${chapterPath}/versions`;

test("AC1 stops on a different head and keeps the text editable and copyable", async () => {
  const ui = await mountConflict();
  expect(ui.root).toHaveAttribute("data-state", "conflict");
  expect(ui.root).toHaveAttribute("data-autosave", "stopped");
  expect(ui.part("conflict")).toHaveAttribute("role", "alert");
  expect(ui.part("conflict")).toHaveTextContent("This chapter changed somewhere else. Your text is not saved as a draft.");
  expect(ui.part("reload-latest")).toHaveTextContent("Reload the latest version");
  expect(ui.part("keep-mine")).toHaveTextContent("Keep mine as a new version");
  expect(ui.part("conflict-copy")).toHaveTextContent("Copy chapter");
  for (const part of ["reload-latest", "keep-mine"]) expect(ui.part(part)).toHaveAttribute("aria-disabled", "false");
  await advance(60000);
  expect(ui.puts()).toHaveLength(1);
  expect(ui.part("editor")).toHaveAttribute("contenteditable", "true");
  expect(ui.onLockChange).toHaveBeenLastCalledWith(true);

  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    fireEvent.click(ui.part("conflict-copy"));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(edited);
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("AC2 keeps the local text through Save and retains the conflict after a failed write", async () => {
  const write = deferred<ReturnType<typeof reply>>();
  let ui = await mountConflict({ writes: [{ method: "POST", path: versionPath, reply: () => write.promise }] });
  fireEvent.click(ui.part("keep-mine"));
  expect(ui.root).toHaveAttribute("data-state", "saving");
  expect(ui.root).toHaveAttribute("data-autosave", "stopped");
  expect(ui.part("conflict")).toBeNull();
  expect(ui.calls.filter(({ method }) => method === "POST")).toEqual([expect.objectContaining({
    path: versionPath, body: { content: edited, parent_version: b },
  })]);
  await act(async () => { write.resolve(reply(writtenC(null), 201)); });
  expect(ui.root).toHaveAttribute("data-state", "clean");
  expect(ui.root).toHaveAttribute("data-autosave", "idle");
  expect(ui.part("conflict")).toBeNull();
  expect(ui.onWritten).toHaveBeenCalledTimes(1);
  expect(ui.onLockChange.mock.calls).toEqual([[true], [false]]);
  edit(ui.view(), "?");
  await advance(2000);
  expect(ui.puts()[1].body).toEqual({ content: edited + "?", base_version: c, base_revision: 0 });
  ui.unmount();
  vi.useRealTimers();

  ui = await mountConflict({ writes: [{ method: "POST", path: versionPath, reply: internalError }] });
  await act(async () => { fireEvent.click(ui.part("keep-mine")); });
  expect(ui.root).toHaveAttribute("data-state", "write-failed");
  expect(ui.part("conflict")).toBeInTheDocument();
  expect(ui.part("write-failure")).toBeInTheDocument();
  const view = ui.view();
  const end = view.state.doc.content.size - 1;
  act(() => view.dispatch(view.state.tr.delete(end - 1, end)));
  expect(ui.part("keep-mine")).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(ui.part("keep-mine"));
  expect(ui.calls.filter(({ method }) => method === "POST")).toHaveLength(1);
});

test("AC3 reloads the version followed by the head, then remounts and focuses the editor", async () => {
  for (const head of [draftNone, draftHeadD]) {
    const chapter = deferred<ReturnType<typeof reply>>();
    const draft = deferred<ReturnType<typeof reply>>();
    const ui = await mountConflict({
      chapter: (_, n) => n === 0 ? reply(detailText) : chapter.promise,
      reloadHead: () => draft.promise,
    });
    const oldEditor = ui.part("editor");
    ui.part("reload-latest").focus();
    fireEvent.click(ui.part("reload-latest"));
    expect(ui.root).toHaveAttribute("data-state", "reloading");
    expect(oldEditor).toHaveAttribute("contenteditable", "false");
    expect(oldEditor).toHaveTextContent("Two!");
    expect(ui.part("status")).toHaveTextContent("Reloading the chapter.");
    expect(ui.part("reload-latest")).toHaveFocus();
    for (const part of ["save", "send", "reload-latest", "keep-mine"]) {
      expect(ui.part(part)).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(ui.part(part));
    }
    expect(ui.calls.at(-1)).toMatchObject({ method: "GET", path: chapterPath });
    expect(ui.calls.filter(({ path }) => path === chapterPath)).toHaveLength(2);
    expect(ui.calls.filter(({ method, path }) => method === "GET" && path === draftPath)).toHaveLength(2);
    await act(async () => { chapter.resolve(reply(detailD)); });
    expect(ui.calls.at(-1)).toMatchObject({ method: "GET", path: draftPath });
    expect(ui.part("editor")).toBe(oldEditor);
    await act(async () => { draft.resolve(reply(head)); });
    expect(ui.part("editor")).not.toBe(oldEditor);
    expect(ui.part("editor")).toHaveFocus();
    expect(ui.part("editor")).toHaveAttribute("contenteditable", "true");
    expect(ui.blocks()).toEqual([
      ["heading", "Title"], ["paragraph", "One"], ["scene_break", ""],
      ["paragraph", head.draft === null ? "Two" : "Two?"],
    ]);
    expect(ui.root).toHaveAttribute("data-state", head.draft === null ? "clean" : "unsaved");
    expect(ui.root).toHaveAttribute("data-autosave", head.draft === null ? "idle" : "saved");
    expect(ui.part("conflict")).toBeNull();
    expect(ui.onLockChange).toHaveBeenLastCalledWith(false);
    expect(ui.onWritten).not.toHaveBeenCalled();

    edit(ui.view(), "!");
    await advance(2000);
    expect(ui.puts()[1].body).toEqual({
      content: head.draft === null ? edited : "# Title\n\nOne\n\n---\n\nTwo?!",
      base_version: d, base_revision: head.draft?.revision ?? 0,
    });
    ui.unmount();
    vi.useRealTimers();
  }
});

test("AC4 failed Reload keeps the undo history and text, allows retry, and ignores replies after unmount", async () => {
  for (const failure of ["chapter", "head", "mismatch", "null-version"] as const) {
    const ui = await mountConflict({
      chapter: (_, n) => {
        if (n === 0) return reply(detailText);
        if (n === 1 && failure === "chapter") return internalError;
        if (n === 1 && failure === "null-version") return reply({ ...detailD, version: null });
        return reply(detailD);
      },
      reloadHead: (_, n) => n === 0 && failure === "head" ? internalError
        : n === 0 && failure === "mismatch" ? reply(draftHeadB) : reply(draftNone),
    });
    const before = ui.view();
    await act(async () => { fireEvent.click(ui.part("reload-latest")); });
    expect(ui.root).toHaveAttribute("data-state", "conflict");
    expect(ui.part("reload-failure")).toHaveAttribute("role", "alert");
    expect(ui.part("reload-failure")).toHaveTextContent(failureCopy);
    expect(ui.part("editor")).toHaveTextContent("Two!");
    expect(ui.part("editor")).toHaveAttribute("contenteditable", "true");
    expect(ui.view()).toBe(before);
    fireEvent.click(ui.part("reload-latest"));
    expect(ui.part("reload-failure")).toBeNull();
    await act(async () => {});
    expect(ui.root).toHaveAttribute("data-state", "clean");
    expect(ui.calls.filter(({ path }) => path === chapterPath)).toHaveLength(3);
    expect(ui.onWritten).not.toHaveBeenCalled();
    ui.unmount();
    vi.useRealTimers();
  }

  const pending = deferred<ReturnType<typeof reply>>();
  const ui = await mountConflict({ chapter: (_, n) => n === 0 ? reply(detailText) : pending.promise });
  fireEvent.click(ui.part("reload-latest"));
  ui.unmount();
  const requestCount = ui.calls.length;
  const lockCount = ui.onLockChange.mock.calls.length;
  await act(async () => { pending.resolve(reply(detailD)); });
  expect(ui.calls).toHaveLength(requestCount);
  expect(ui.onLockChange).toHaveBeenCalledTimes(lockCount);
  expect(ui.onEditorReady).toHaveBeenCalledTimes(1);
  expect(ui.onWritten).not.toHaveBeenCalled();
});
