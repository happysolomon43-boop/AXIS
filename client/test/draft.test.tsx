import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import { Draft } from "../src/draft/Draft";
import { deferred, internalError, mockApi } from "./helpers";
import { b, c, d, chapterA, chapterPath, detailText, detailSent, reply, writtenC, verRow } from "./d06.fixtures";
import { noDraftRead, draftPath } from "./draftFixtures";

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
  const { calls: allCalls } = mockApi([noDraftRead, { method: "GET", path: chapterPath, reply: (_, n) => n === 0 ? initial.promise : reply(detailText) }]);
  const calls = () => chapterCalls(allCalls);
  let m = mount();
  expect(m.root).toHaveAttribute("data-state", "loading");
  expect(m.part("reading")).toHaveTextContent("Opening the chapter");
  await act(async () => initial.resolve(internalError));
  expect(m.root).toHaveAttribute("data-state", "failed");
  expect(screen.getByRole("alert")).toHaveAttribute("data-part", "read-failure");
  fireEvent.click(m.part("try-again"));
  await ready(m);
  expect(calls().map(({ method, path }) => [method, path])).toEqual([["GET", chapterPath], ["GET", chapterPath]]);
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
  mockApi([noDraftRead, { method: "GET", path: chapterPath, reply: reply(detailSent) }]); m = mount(); await ready(m);
  expect(m.part("version-chip")).toBeNull(); expect(m.part("send")).toHaveAttribute("aria-disabled", "true"); cleanup();
  mockApi([noDraftRead, { method: "GET", path: chapterPath, reply: reply({ ...detailText, version: null }) }]); m = mount();
  await waitFor(() => expect(m.root).toHaveAttribute("data-state", "failed")); expect(m.part("editor")).toBeNull();
});

test("AXB-0040 AC2 saves only changes, locks during writes, updates parents and guards unload and chords", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  const { calls: allCalls } = mockApi([
    noDraftRead,
    { method: "GET", path: chapterPath, reply: reply(detailText) },
    { method: "POST", path: `${chapterPath}/versions`, reply: (_, n) => n === 0 ? pending.promise : reply({ ...writtenC(null), version: verRow(d, 4, c) }, 201) },
  ]);
  const calls = () => chapterCalls(allCalls);
  const m = mount(); await ready(m);
  expect(chord({ code: "KeyS", ctrlKey: true }).defaultPrevented).toBe(true); expect(calls()).toHaveLength(1);
  edit(m); expect(m.root).toHaveAttribute("data-state", "unsaved"); expect(m.onLockChange.mock.calls).toEqual([[true]]);
  expect(m.part("save")).toHaveAttribute("aria-disabled", "false"); expect(unload()).toBe(true);
  fireEvent.click(m.part("save"));
  expect(calls()[1]).toMatchObject({ method: "POST", path: `${chapterPath}/versions`, body: { content: `${text}!`, parent_version: b } });
  expect(m.root).toHaveAttribute("data-state", "saving"); expect(m.part("editor")).toHaveAttribute("contenteditable", "false");
  expect(m.part("save")).toHaveAttribute("aria-disabled", "true"); expect(m.part("send")).toHaveAttribute("aria-disabled", "true");
  const doc = m.view().state.doc; edit(m, "ignored"); expect(m.view().state.doc.eq(doc)).toBe(true);
  fireEvent.click(m.part("save")); fireEvent.click(m.part("send")); expect(calls()).toHaveLength(2);
  await act(async () => pending.resolve(reply(writtenC(null), 201))); await ready(m);
  expect(m.part("editor")).toHaveAttribute("contenteditable", "true"); expect(m.part("editor")).toHaveFocus();
  expect(m.onWritten).toHaveBeenCalledTimes(1); expect(m.onLockChange.mock.calls).toEqual([[true], [false]]);
  expect(m.part("version-chip")).toHaveTextContent("Draft only"); expect(m.part("status")).toHaveAttribute("data-outcome", "saved");
  expect(calls()).toHaveLength(2); expect(unload()).toBe(false);
  expect(chord({ code: "KeyS", ctrlKey: true }).defaultPrevented).toBe(true); expect(calls()).toHaveLength(2);
  edit(m, "?"); expect(m.part("status")).not.toHaveAttribute("data-outcome");
  expect(chord({ code: "KeyS", ctrlKey: true }).defaultPrevented).toBe(true);
  expect(calls()[2].body).toEqual({ content: `${text}!?`, parent_version: c }); await ready(m);
});

test("AXB-0040 AC3 sends a clean unsent version, then only valid dirty Send chords", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  const { calls: allCalls } = mockApi([
    noDraftRead,
    { method: "GET", path: chapterPath, reply: reply(detailText) },
    { method: "POST", path: `${chapterPath}/send`, reply: (_, n) => n === 0 ? pending.promise : reply({ ...writtenC(d), version: verRow(d, 4, c) }, 201) },
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

test("AXB-0040 AC4 reconciles lost writes and failed checks without automatic retry, copies text and stops on unmount", async () => {
  for (const kind of ["save", "send"] as const) {
    let stored = detailText;
    const path = `${chapterPath}/${kind === "save" ? "versions" : "send"}`;
    const { calls: allCalls } = mockApi([
      noDraftRead,
      { method: "GET", path: chapterPath, reply: () => reply(stored) },
      { method: "POST", path, reply: (call, n) => { if (n > 0) return reply({ ...writtenC(null), version: verRow(d, 4, c) }, 201); stored = { ...detailText, version: { ...verRow(c, 3, b), content: (call.body as { content: string }).content }, active_version_id: kind === "send" ? c : null }; return "network"; } },
      ...(kind === "send" ? [{ method: "POST", path: `${chapterPath}/versions`, reply: reply({ ...writtenC(c), version: verRow(d, 4, c) }, 201) }] : []),
    ]);
    const calls = () => chapterCalls(allCalls);
    const m = mount(); await ready(m); edit(m); fireEvent.click(m.part(kind)); await ready(m);
    expect(calls().map(({ method, path }) => [method, path])).toEqual([["GET", chapterPath], ["POST", path], ["GET", chapterPath]]);
    expect(m.part("write-failure")).toBeNull(); expect(m.onWritten).toHaveBeenCalledTimes(1);
    if (kind === "send") expect(m.part("version-chip")).toBeNull();
    edit(m, "?"); fireEvent.click(m.part("save")); expect(calls()[3].body).toEqual({ content: `${text}!?`, parent_version: c });
    await ready(m); cleanup();
  }
  let api = mockApi([
    noDraftRead,
    { method: "GET", path: chapterPath, reply: reply(detailText) },
    { method: "POST", path: `${chapterPath}/versions`, reply: (_, n) => n === 0 ? internalError : reply(writtenC(null), 201) },
  ]);
  let m = mount(); await ready(m); edit(m); fireEvent.click(m.part("save"));
  await waitFor(() => expect(m.root).toHaveAttribute("data-state", "write-failed"));
  expect(m.part("write-failure")).toHaveTextContent("The chapter could not be saved.");
  expect(m.part("only-here")).toHaveTextContent("This text exists only in this window. Copy it out now");
  expect(m.part("copy-chapter")).toHaveTextContent("Copy chapter"); expect(m.part("save")).toHaveAttribute("aria-disabled", "false");
  expect(m.onLockChange).toHaveBeenLastCalledWith(true); expect(m.view().state.doc.lastChild?.textContent).toBe("Two!");
  fireEvent.click(m.part("save")); await ready(m); expect(api.calls.filter(call => call.method === "POST")).toHaveLength(2); cleanup();
  api = mockApi([
    noDraftRead,
    { method: "GET", path: chapterPath, reply: (_, n) => n === 1 ? internalError : reply(detailText) },
    { method: "POST", path: `${chapterPath}/versions`, reply: internalError },
  ]);
  m = mount(); await ready(m); edit(m); fireEvent.click(m.part("save"));
  await waitFor(() => expect(m.root).toHaveAttribute("data-state", "check-failed"));
  expect(m.part("save")).toHaveAttribute("aria-disabled", "true"); expect(m.part("send")).toHaveAttribute("aria-disabled", "true");
  const writeText = vi.fn().mockResolvedValue(undefined); const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try { fireEvent.click(m.part("copy-chapter")); expect(writeText).toHaveBeenCalledWith(`${text}!`); }
  finally { if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard"); }
  fireEvent.click(m.part("check-again")); await waitFor(() => expect(m.root).toHaveAttribute("data-state", "write-failed"));
  expect(chapterCalls(api.calls).map(call => call.method)).toEqual(["GET", "POST", "GET", "GET"]); cleanup();
  const pending = deferred<ReturnType<typeof reply>>();
  mockApi([noDraftRead, { method: "GET", path: chapterPath, reply: reply(detailText) }, { method: "POST", path: `${chapterPath}/versions`, reply: () => pending.promise }]);
  m = mount(); await ready(m); edit(m); fireEvent.click(m.part("save"));
  m.onLockChange.mockClear(); m.onWritten.mockClear(); m.unmount();
  await act(async () => pending.resolve(reply(writtenC(null), 201))); expect(m.onWritten).not.toHaveBeenCalled(); expect(m.onLockChange).not.toHaveBeenCalled();
});
