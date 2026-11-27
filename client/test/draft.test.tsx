import { receiptPath, receiptRoute, workingPath, workingRead, writeResponse, writeResult } from "./writeFixtures";
import type { WriteResult } from "../src/api/types";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import { Draft } from "../src/draft/Draft";
import { deferred, internalError, mockApi } from "./helpers";
import { b, c, d, chapterA, chapterPath, detailText, detailSent, reply, writtenC, verRow } from "./d06.fixtures";
import type { CaptureRequest } from "../src/api/types";
import { capturePath, captureReply } from "./snapshotCaptureFixtures";
import { draftPath } from "./draftFixtures";

function chapterCalls(calls: import("./helpers").Call[]) {
  return calls.filter(({ method, path }) => method !== "GET" || path !== draftPath);
}

function mount() {
  const onLockChange = vi.fn(); const onWritten = vi.fn(); const onEditorReady = vi.fn<(view: EditorView) => void>();
  const result = render(<Draft chapterId={chapterA.id} onLockChange={onLockChange} onWritten={onWritten} onEditorReady={onEditorReady} />);
  const root = result.container.querySelector('[data-surface="draft"]')!;
  return { ...result, root, onLockChange, onWritten, onEditorReady, part: (name: string) => root.querySelector(`[data-part="${name}"]`)!,
    view: () => onEditorReady.mock.calls[0][0] };
}
async function ready(m: ReturnType<typeof mount>) {
  await waitFor(() => expect(m.root).toHaveAttribute("data-state", "clean"));
}
function edit(m: ReturnType<typeof mount>, text = "!") {
  const v = m.view(); act(() => v.dispatch(v.state.tr.insertText(text, v.state.doc.content.size - 1)));
}
function chord(keys: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...keys }); fireEvent(window, event); return event;
}
function unload() { const event = new Event("beforeunload", { cancelable: true }); fireEvent(window, event); return event.defaultPrevented; }
const text = detailText.version!.content;

test("AXB-0040 AC1 opens, handles read failure and retry, sent and null version", async () => {
  const initial = deferred<typeof internalError>();
  const { calls: allCalls } = mockApi([ workingRead(chapterPath, (_, n) => n === 0 ? initial.promise : reply(detailText))]);
  const calls = () => chapterCalls(allCalls);
  let m = mount();
  expect(m.root).toHaveAttribute("data-state", "loading");
  expect(m.part("reading")).toHaveTextContent("Opening the chapter");
  await act(async () => initial.resolve(internalError));
  expect(m.root).toHaveAttribute("data-state", "failed");
  expect(screen.getByRole("alert")).toHaveAttribute("data-part", "read-failure");
  fireEvent.click(m.part("try-again"));
  await ready(m);
  expect(calls().map(({ method, path }) => [method, path])).toEqual([["GET", workingPath(chapterPath)], ["GET", workingPath(chapterPath)]]);
  expect(m.part("editor")).toHaveAttribute("contenteditable", "true");
  expect([...m.part("editor").querySelectorAll("[data-block]")].map(el => [el.getAttribute("data-block"), el.textContent])).toEqual([
    ["heading", "Title"], ["paragraph", "One"], ["scene_break", ""], ["paragraph", "Two"],
  ]);
  expect(m.part("editor")).toHaveFocus();
  expect(m.part("version-chip")).toHaveTextContent("Draft only");
  expect(m.part("save")).toHaveAttribute("aria-disabled", "true");
  expect(m.part("send")).toHaveAttribute("aria-disabled", "false");
  expect(m.onLockChange).not.toHaveBeenCalled();
  cleanup();
  mockApi([ workingRead(chapterPath, reply(detailSent))]); m = mount(); await ready(m);
  expect(m.part("version-chip")).toBeNull(); expect(m.part("send")).toHaveAttribute("aria-disabled", "true"); cleanup();
  mockApi([ workingRead(chapterPath, reply({ ...detailText, version: null }))]); m = mount();
  await waitFor(() => expect(m.root).toHaveAttribute("data-state", "failed")); expect(m.part("editor")).toBeNull();
});

test("AXB-0040 AC2 saves only changes, locks during writes, updates parents and guards unload and chords", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  const { calls: allCalls } = mockApi([
    workingRead(chapterPath, reply(detailText)),
    { method: "POST", path: `${chapterPath}/versions`, reply: async call => writeResponse(call, await pending.promise) },
    { method: "POST", path: capturePath, reply: call => captureReply(call.body as CaptureRequest,true,true,verRow(d,4,c)) },
  ]);
  const calls = () => chapterCalls(allCalls);
  const m = mount(); await ready(m);
  fireEvent.click(m.part("save")); expect(calls()).toHaveLength(1);
  edit(m); expect(m.root).toHaveAttribute("data-state", "unsaved"); expect(m.onLockChange.mock.calls).toEqual([[true]]);
  expect(m.part("save")).toHaveAttribute("aria-disabled", "false"); expect(unload()).toBe(true);
  fireEvent.click(m.part("save"));
  expect(calls()[1]).toMatchObject({ method: "POST", path: `${chapterPath}/versions`, body: { content: `${text}!`, parent_version: b } });
  expect(m.root).toHaveAttribute("data-state", "saving"); expect(m.part("editor")).toHaveAttribute("contenteditable", "false");
  expect(m.part("save")).toHaveAttribute("aria-disabled", "true"); expect(m.part("send")).toHaveAttribute("aria-disabled", "true");
  const doc = m.view().state.doc; edit(m, "ignored"); expect(m.view().state.doc.eq(doc)).toBe(true);
  fireEvent.click(m.part("save")); fireEvent.click(m.part("send")); expect(chord({ code: "KeyS", ctrlKey: true }).defaultPrevented).toBe(true); expect(calls()).toHaveLength(2);
  await act(async () => pending.resolve(reply(writtenC(null), 201))); await ready(m);
  expect(m.part("editor")).toHaveAttribute("contenteditable", "true"); expect(m.part("editor")).toHaveFocus();
  expect(m.onWritten).toHaveBeenCalledTimes(1); expect(m.onLockChange.mock.calls).toEqual([[true], [false]]);
  expect(m.part("version-chip")).toHaveTextContent("Draft only"); expect(m.part("status")).toHaveAttribute("data-outcome", "saved");
  expect(calls()).toHaveLength(2); expect(unload()).toBe(false);
  fireEvent.click(m.part("save")); expect(calls()).toHaveLength(2);
  edit(m, "?"); expect(m.part("status")).not.toHaveAttribute("data-outcome");
  expect(chord({ code: "KeyS", ctrlKey: true }).defaultPrevented).toBe(true);
  expect(calls()[2]).toMatchObject({path:capturePath,body:{content:`${text}!?`,base_version:c,base_revision:0}}); await waitFor(()=>expect(m.part("snapshot-status")).toHaveTextContent("Snapshot saved."));
});

test("AXB-0040 AC3 sends a clean unsent version, then only valid dirty Send chords", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  const { calls: allCalls } = mockApi([
    workingRead(chapterPath, reply(detailText)),
    { method: "POST", path: `${chapterPath}/send`, reply: async (call, n) => writeResponse(call, n === 0 ? await pending.promise : reply({ ...writtenC(d), version: verRow(d, 4, c) }, 201)) },
  ]);
  const calls = () => chapterCalls(allCalls);
  const m = mount(); await ready(m);
  fireEvent.click(m.part("send")); expect(m.root).toHaveAttribute("data-state", "sending");
  expect(calls()[1]).toMatchObject({ method: "POST", path: `${chapterPath}/send`, body: { content: text, parent_version: b } });
  await act(async () => pending.resolve(reply(writtenC(c), 201))); await ready(m);
  expect(m.part("version-chip")).toBeNull(); expect(m.part("send")).toHaveAttribute("aria-disabled", "true");
  expect(m.part("status")).toHaveAttribute("data-outcome", "sent"); expect(m.onWritten).toHaveBeenCalledTimes(1);
  edit(m);
  for (const keys of [{ ctrlKey: true }, { ctrlKey: true, shiftKey: true, altKey: true }, { ctrlKey: true, metaKey: true, shiftKey: true }]) {
    expect(chord({ code: "Enter", ...keys }).defaultPrevented).toBe(false);
  }
  expect(calls()).toHaveLength(2);
  expect(chord({ code: "Enter", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  expect(calls()[2]).toMatchObject({ path: `${chapterPath}/send`, body: { content: `${text}!`, parent_version: c } }); await ready(m);
});

test("AXB-0040 AC4 settles by UUID, preserves clipboard recovery and ignores replies after unmount", async () => {
  for (const kind of ["save", "send"] as const) {
    let result: WriteResult;
    const path = `${chapterPath}/${kind === "save" ? "versions" : "send"}`;
    const { calls } = mockApi([
      workingRead(chapterPath, reply(detailText)),
      { method: "POST", path, reply: (call) => {
        result = writeResult(call, writtenC(kind === "send" ? c : null));
        return "network";
      } },
      { method: "GET", path: receiptRoute, reply: () => reply({ receipt: result }) },
    ]);
    const m = mount(); await ready(m); edit(m); fireEvent.click(m.part(kind)); await ready(m);
    expect(calls.map(({ method, path }) => [method, path])).toEqual([
      ["GET", workingPath(chapterPath)], ["POST", path], ["GET", receiptPath(chapterPath, result!.request_id)],
    ]);
    expect(m.part("write-failure")).toBeNull();
    expect(m.onWritten).toHaveBeenCalledTimes(1);
    expect(m.onEditorReady).toHaveBeenCalledTimes(1);
    cleanup();
  }
  let recorded: WriteResult;
  const api = mockApi([
    workingRead(chapterPath, reply(detailText)),
    { method: "POST", path: `${chapterPath}/versions`, reply: call => {
      recorded = writeResult(call, writtenC(null));
      return internalError;
    } },
    { method: "GET", path: receiptRoute, reply: (_, n) => n === 0 ? internalError
      : n === 1 ? reply({ receipt: null }) : reply({ receipt: recorded }) },
  ]);
  let m = mount(); await ready(m); edit(m); fireEvent.click(m.part("save"));
  await waitFor(() => expect(m.root).toHaveAttribute("data-state", "check-failed"));
  expect(m.part("save")).toHaveAttribute("aria-disabled", "true");
  expect(m.part("send")).toHaveAttribute("aria-disabled", "true");
  const writeText = vi.fn().mockResolvedValue(undefined); const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try { fireEvent.click(m.part("copy-chapter")); expect(writeText).toHaveBeenCalledWith(`${text}!`); }
  finally { if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard"); }
  await act(async () => { fireEvent.click(m.part("check-again")); });
  expect(m.root).toHaveAttribute("data-state", "check-failed");
  expect(m.onWritten).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(m.part("check-again")); });
  await ready(m);
  expect(api.calls.map(call => call.method)).toEqual(["GET", "POST", "GET", "GET", "GET"]);
  expect(new Set(api.calls.slice(2).map(call => call.path))).toEqual(new Set([receiptPath(chapterPath, recorded!.request_id)]));
  expect(m.onWritten).toHaveBeenCalledOnce();
  cleanup();

  const pending = deferred<ReturnType<typeof reply>>();
  mockApi([workingRead(chapterPath, reply(detailText)),
    { method: "POST", path: `${chapterPath}/versions`, reply: async call => writeResponse(call, await pending.promise) }]);
  m = mount(); await ready(m); edit(m); fireEvent.click(m.part("save"));
  m.onLockChange.mockClear(); m.onWritten.mockClear(); m.unmount();
  await act(async () => pending.resolve(reply(writtenC(null), 201)));
  expect(m.onWritten).not.toHaveBeenCalled();
  expect(m.onLockChange).not.toHaveBeenCalled();
});

test("a malformed Save reply resolves only its receipt and keeps local text when the Draft advanced", async () => {
  let written: WriteResult;
  const { calls } = mockApi([
    workingRead(chapterPath, reply(detailText)),
    { method: "POST", path: chapterPath + "/versions", reply: call => {
      written = writeResult(call, writtenC(null));
      return reply({ ...written, chapter: { ...written.chapter, id: "ch_00000000000f" } }, 201);
    } },
    { method: "GET", path: receiptRoute, reply: () => reply({ receipt: {
      ...written, current: { ...written.current, version_id: d, revision: 1 },
    } }) },
  ]);
  const m = mount();
  await ready(m);
  edit(m);
  const doc = m.view().state.doc;
  await act(async () => { fireEvent.click(m.part("save")); });
  expect(m.root).toHaveAttribute("data-state", "conflict");
  expect(m.part("status")).toHaveTextContent("Version saved.");
  expect(m.view().state.doc).toBe(doc);
  expect(m.onEditorReady).toHaveBeenCalledTimes(1);
  expect(m.onWritten).toHaveBeenCalledTimes(1);
  fireEvent.click(m.part("save"));
  fireEvent.click(m.part("send"));
  expect(calls.map(call => call.method)).toEqual(["GET", "POST", "GET"]);
});
