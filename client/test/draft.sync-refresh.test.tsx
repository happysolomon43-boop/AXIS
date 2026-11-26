import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { undo, undoDepth } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import { afterEach, expect, test, vi } from "vitest";
import { Draft } from "../src/draft/Draft";
import { capturePath,captureReply } from "./snapshotCaptureFixtures";
import type { CaptureRequest, ChapterSync } from "../src/api/types";
import { chapterA, chapterPath, detailText, reply } from "./d06.fixtures";
import { advance, draftNone, draftPath, edit, fakeClock, putOk } from "./draftFixtures";
import { deferred, mockApi } from "./helpers";
import { internalEnvelope } from "./historyFixtures";
import { chapterNotFoundEnvelope } from "./pullbackFixtures";
import { syncDraftOnly, syncInBook, syncEdited, syncRevisedSame, syncRevised, withSync } from "./syncDraftFixtures";

const path = draftPath + "?view=sync";
const head = (sync: ChapterSync) => withSync({ status: 200, body: draftNone }, sync);
const projected = (sync: ChapterSync) => reply({ sync });
const count = (calls: ReturnType<typeof mockApi>["calls"]) => calls.filter(c => c.method === "GET" && c.path === path).length;
type Handler = Parameters<typeof mockApi>[0][number];
function mount(sync: ChapterSync, metadata: Handler["reply"], options: { initial?: number; draft?: Handler["reply"]; extra?: Handler[] } = {}) {
  const onReady = vi.fn<(view: EditorView) => void>();
  const onLockChange = vi.fn();
  const onWritten = vi.fn();
  const api = mockApi([
    { method: "GET", path: chapterPath, reply: reply(detailText) },
    { method: "GET", path: draftPath, reply: options.draft ?? head(sync) },
    { method: "GET", path, reply: metadata },
    ...(options.extra ?? []),
  ]);
  const element = (token: number) => <Draft chapterId={chapterA.id} syncRefreshToken={token}
    onEditorReady={onReady} onLockChange={onLockChange} onWritten={onWritten} />;
  const ui = render(element(options.initial ?? 0));
  const root = ui.container.querySelector<HTMLElement>('[data-surface="draft"]')!;
  const chip = () => root.querySelector('[data-part="version-chip"]');
  return { ...ui, ...api, root, chip, onReady, onWritten,
    token: (n: number) => ui.rerender(element(n)),
    view: () => onReady.mock.calls[0][0],
    loaded: () => waitFor(() => expect(root).toHaveAttribute("data-state", "clean")) };
}
afterEach(() => { if (vi.isFakeTimers()) vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
test("AXB-0085 AC1 applies only the served chip, preserving Editor and undo", async () => {
  const first = deferred<ReturnType<typeof projected>>();
  const second = deferred<ReturnType<typeof projected>>();
  const ui = mount(syncInBook, (_, n) => n === 0 ? first.promise : second.promise);
  await ui.loaded();
  fakeClock();
  const view = ui.view();
  const root = ui.root;
  view.focus();
  edit(view);
  const selection = view.state.selection;
  const doc = view.state.doc;
  const depth = undoDepth(view.state);
  const focused = document.activeElement;
  const before = ui.calls.length;
  ui.token(1);
  expect(count(ui.calls)).toBe(1);
  expect(ui.chip()).toBeNull();
  await act(async () => { first.resolve(projected(syncRevisedSame)); });
  expect(ui.chip()).toHaveTextContent("Being revised, no changes yet");
  ui.token(2);
  await act(async () => { second.resolve(projected(syncRevised)); });
  expect(ui.chip()).toHaveTextContent(/^Being revised$/);
  expect(ui.container.querySelector('[data-surface="draft"]')).toBe(root);
  expect(ui.onReady).toHaveBeenCalledTimes(1);
  expect(ui.view()).toBe(view);
  expect(view.state.doc.eq(doc)).toBe(true);
  expect(view.state.selection.eq(selection)).toBe(true);
  expect(document.activeElement).toBe(focused);
  expect(undoDepth(view.state)).toBe(depth);
  expect(ui.calls.slice(before).map(c => [c.method,c.path])).toEqual([["GET",path],["GET",path]]);
  act(() => { expect(undo(view.state, view.dispatch)).toBe(true); });
  expect(view.state.doc.textContent).not.toContain("!");
  expect(ui.onWritten).not.toHaveBeenCalled();
  ui.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const [sync, words] of [[syncDraftOnly,"Draft only"],[syncEdited,"In Book, edited since upload"],[syncInBook,null]] as const) {
    const next = mount(syncRevised, projected(sync));
    await next.loaded();
    await act(async () => { next.token(1); });
    if (words === null) expect(next.chip()).toBeNull(); else expect(next.chip()).toHaveTextContent(words);
    next.unmount();
  }
});
test("AXB-0085 AC2 coalesces while autosave or opening is active", async () => {
  const put = deferred<ReturnType<typeof reply>>();
  const ui = mount(syncInBook, projected(syncRevised), { extra: [{ method:"PUT", path:draftPath, reply: () => put.promise }] });
  await ui.loaded(); fakeClock(); edit(ui.view()); await advance(2000);
  ui.token(1); ui.token(2);
  expect(count(ui.calls)).toBe(0);
  await act(async () => { put.resolve(reply({ ...putOk(1), sync: syncEdited })); });
  expect(count(ui.calls)).toBe(1);
  expect(ui.chip()).toHaveTextContent(/^Being revised$/);
  expect(ui.root).toHaveAttribute("data-autosave","saved");
  expect(ui.view().state.doc.textContent).toContain("Two!");
  ui.unmount(); vi.clearAllTimers(); vi.useRealTimers();
  const open = deferred<ReturnType<typeof head>>();
  const opening = mount(syncInBook, projected(syncRevisedSame), { initial:5, draft: () => open.promise });
  await waitFor(() => expect(opening.calls.map(c => c.path)).toContain(draftPath));
  opening.token(5); expect(count(opening.calls)).toBe(0);
  opening.token(6); opening.token(7); expect(count(opening.calls)).toBe(0);
  await act(async () => { open.resolve(head(syncInBook)); });
  expect(count(opening.calls)).toBe(1);
  expect(opening.chip()).toHaveTextContent("Being revised, no changes yet");
  opening.unmount();
  const initial = mount(syncInBook, projected(syncRevised), { initial:7 });
  await initial.loaded(); expect(count(initial.calls)).toBe(0); initial.unmount();
});
test("AXB-0085 AC3 superseded and unmounted replies cannot land", async () => {
  const first = deferred<ReturnType<typeof projected>>();
  const second = deferred<ReturnType<typeof projected>>();
  const ui = mount(syncEdited, (_, n) => n === 0 ? first.promise : second.promise);
  await ui.loaded(); ui.token(1); ui.token(2);
  expect(count(ui.calls)).toBe(1);
  await act(async () => { first.resolve(projected(syncRevised)); });
  expect(ui.chip()).toHaveTextContent("In Book, edited since upload");
  expect(count(ui.calls)).toBe(2);
  ui.unmount();
  const B = "ch_00000000000b", bPath = "/api/chapters/" + B;
  const { calls } = mockApi([
    { method:"GET", path:bPath, reply:reply({ ...detailText, chapter:{ ...chapterA,id:B } }) },
    { method:"GET", path:bPath+"/draft", reply:reply({ ...draftNone, chapter:{ ...chapterA,id:B }, sync:syncDraftOnly }) },
  ]);
  const next = render(<Draft chapterId={B} syncRefreshToken={2} onLockChange={vi.fn()} onWritten={vi.fn()} />);
  await waitFor(() => expect(next.container.querySelector('[data-state="clean"]')).not.toBeNull());
  await act(async () => { second.resolve(projected(syncInBook)); });
  expect(next.container.querySelector('[data-part="version-chip"]')).toHaveTextContent("Draft only");
  expect(calls.map(c => c.path)).toEqual([bPath,bPath+"/draft"]);
  next.unmount();
});
test("AXB-0085 AC4 errors and null consume only their own token", async () => {
  const unauthorized = reply({ error:{ code:"auth_required",message:"Missing or invalid X-Axis-User header",details:null } },401);
  const responses = [unauthorized,chapterNotFoundEnvelope,internalEnvelope,"network",reply({}),projected(syncInBook)] as const;
  const ui = mount(syncRevised, (_,n) => responses[n]);
  await ui.loaded();
  const doc = ui.view().state.doc;
  const focus = document.activeElement;
  for (let i=1;i<=responses.length;i++) {
    await act(async () => { ui.token(i); });
    expect(count(ui.calls)).toBe(i);
    expect(ui.root).toHaveAttribute("data-state","clean");
    expect(ui.view().state.doc.eq(doc)).toBe(true);
    expect(document.activeElement).toBe(focus);
    expect(ui.root.querySelector('[role="alert"]')).toBeNull();
    if(i<responses.length) expect(ui.chip()).toHaveTextContent(/^Being revised$/); else expect(ui.chip()).toBeNull();
  }
  ui.unmount();
  const bad = mount(syncRevised, projected(syncInBook));
  await bad.loaded();
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch",vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === path ? new Response("not json",{status:200}) : fetch(input,init)));
  await act(async () => { bad.token(1); });
  expect(bad.chip()).toHaveTextContent(/^Being revised$/);
  expect(bad.root).toHaveAttribute("data-state","clean");
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  bad.unmount();
});

test("D14 capture invalidates an older D12 projection and queues the latest notice",async()=>{
 const first=deferred<ReturnType<typeof projected>>(), second=deferred<ReturnType<typeof projected>>();
 const captured=deferred<ReturnType<typeof reply>>();
 const ui=mount(syncInBook,(_,n)=>n===0?first.promise:second.promise,{extra:[{method:"POST",path:capturePath,reply:()=>captured.promise}]});
 await ui.loaded();ui.token(1);expect(count(ui.calls)).toBe(1);
 fireEvent.keyDown(window,{code:"KeyS",ctrlKey:true,cancelable:true});ui.token(2);
 await act(async()=>first.resolve(projected(syncRevisedSame)));expect(ui.chip()).toBeNull();expect(count(ui.calls)).toBe(1);
 const body=ui.calls.find(c=>c.path===capturePath)!.body as CaptureRequest;
 await act(async()=>captured.resolve(captureReply(body,false,true)));expect(count(ui.calls)).toBe(2);
 await act(async()=>second.resolve(projected(syncRevised)));expect(ui.chip()).toHaveTextContent(/^Being revised$/);expect(ui.onWritten).toHaveBeenCalledTimes(1);
});
