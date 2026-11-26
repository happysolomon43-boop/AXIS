import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { Binder } from "../src/binder/Binder";
import type { ChapterSync } from "../src/api/types";
import { chapterA, b, reply } from "./d06.fixtures";
import { chaptersPath, deferred, mockApi } from "./helpers";
import { internalEnvelope } from "./historyFixtures";
import { pbList, pbTree, pullBackReplyB } from "./pullbackFixtures";
import { syncEdited, syncInBook, syncRevised, syncRevisedSame } from "./syncDraftFixtures";
const A = chapterA.id, B = pbList.chapters[1].id;
const path = (id: string) => "/api/chapters/" + id + "/pull-back";
const list = (sync: ChapterSync) => ({ chapters: pbList.chapters.map(row => row.id === A ? { ...row, version_id:b, active_version_id:b, sync } : row) });
const posted = { ...pullBackReplyB, body: { chapter:chapterA, active_version_id:b } };
const routes = (calls: ReturnType<typeof mockApi>["calls"]) => calls.map(c => c.method+" "+c.path);
const part = (scope:ParentNode,name:string) => scope.querySelector<HTMLElement>('[data-part="'+name+'"]')!;
const failure = "The chapter could not be pulled back.";
afterEach(() => vi.unstubAllGlobals());
test("AXB-0086 AC1 current row, native Enter, single notice and focus hand-off", async () => {
  const post = deferred<typeof posted>();
  const settle = deferred<ReturnType<typeof reply>>();
  const spy=vi.fn(), open=vi.fn();
  const { calls } = mockApi([
    {method:"GET",path:chaptersPath,reply:(_,n)=>n===0?reply(list(syncInBook)):settle.promise},
    {method:"POST",path:path(A),reply:()=>post.promise},
  ]);
  const ui=render(<Binder tree={pbTree} openChapterId={A} onOpenChapter={open} onChapterPullBackLanded={spy}/>);
  const button=await screen.findByRole("button",{name:"Pull back Chapter 1"});
  const row=button.parentElement!;
  button.focus();
  await userEvent.setup().keyboard("{Enter}{Enter}");
  expect(button).toHaveTextContent("Pulling back...");
  expect(spy).not.toHaveBeenCalled();
  expect(routes(calls)).toEqual(["GET "+chaptersPath,"POST "+path(A)]);
  await act(async()=>{post.resolve(posted);});
  expect(spy.mock.calls).toEqual([[A]]);
  expect(open).not.toHaveBeenCalled();
  await act(async()=>{settle.resolve(reply(list(syncRevisedSame)));});
  expect(spy.mock.calls).toEqual([[A]]);
  expect(part(row,"chip")).toHaveTextContent("Being revised, no changes yet");
  expect(part(row,"chapter-open")).toHaveFocus();
  expect(routes(calls)).toEqual(["GET "+chaptersPath,"POST "+path(A),"GET "+chaptersPath]);
  ui.unmount();
});
test("AXB-0086 AC2 confirms only the matching served revised row",async()=>{
  for(const [settle,landed] of [
    [reply(list(syncRevised)),true],
    [reply({chapters:pbList.chapters.filter(row=>row.id!==A)}),false],
    [reply({chapters:list(syncInBook).chapters.map(row=>row.id===A?{...row,sync:undefined}:row)}),false],
    [reply(list(syncEdited)),false],[internalEnvelope,false],
  ] as const){
    const spy=vi.fn(), open=vi.fn();
    const {calls}=mockApi([
      {method:"GET",path:chaptersPath,reply:(_,n)=>n===0?reply(list(syncInBook)):settle},
      {method:"POST",path:path(A),reply:"network"},
    ]);
    const ui=render(<Binder tree={pbTree} openChapterId={A} onOpenChapter={open} onChapterPullBackLanded={spy}/>);
    const button=await screen.findByRole("button",{name:"Pull back Chapter 1"});
    await act(async()=>{fireEvent.click(button);});
    expect(spy.mock.calls).toEqual(landed?[[A]]:[]);
    expect(open).not.toHaveBeenCalled();
    expect(routes(calls)).toEqual(["GET "+chaptersPath,"POST "+path(A),"GET "+chaptersPath]);
    if(landed) expect(part(ui.container,"pull-back-failure")).toBeNull();
    else expect(part(ui.container,"pull-back-failure")).toHaveTextContent(failure);
    ui.unmount();
  }
});
test("AXB-0086 AC3 a successful POST survives lock, collapse, and failed list refresh",async()=>{
  for(const state of ["locked","collapsed","failed"]){
    const post=deferred<typeof posted>(), spy=vi.fn(), open=vi.fn();
    const {calls}=mockApi([
      {method:"GET",path:chaptersPath,reply:(_,n)=>n===0?reply(list(syncInBook)):state==="failed"?internalEnvelope:reply(list(syncRevisedSame))},
      {method:"POST",path:path(A),reply:()=>post.promise},
    ]);
    const element=(locked=false)=><Binder tree={pbTree} openChapterId={A} locked={locked} onOpenChapter={open} onChapterPullBackLanded={spy}/>;
    const ui=render(element());
    fireEvent.click(await screen.findByRole("button",{name:"Pull back Chapter 1"}));
    if(state==="locked") ui.rerender(element(true));
    if(state==="collapsed") fireEvent.click(part(ui.container,"book-toggle"));
    await act(async()=>{post.resolve(posted);});
    expect(spy.mock.calls).toEqual([[A]]);
    expect(open).not.toHaveBeenCalled();
    expect(calls.filter(c=>c.method==="GET")).toHaveLength(state==="collapsed"?1:2);
    ui.unmount();
  }
});
test("AXB-0086 AC4 non-current navigation and locked-at-press guard",async()=>{
  const spy=vi.fn(), open=vi.fn();
  const {calls}=mockApi([
    {method:"GET",path:chaptersPath,reply:(_,n)=>reply(n===0?list(syncInBook):{chapters:list(syncInBook).chapters.map(row=>row.id===B?{...row,sync:syncRevisedSame}:row)})},
    {method:"POST",path:path(B),reply:pullBackReplyB},
  ]);
  const element=(locked:boolean)=><Binder tree={pbTree} openChapterId={A} locked={locked} onOpenChapter={open} onChapterPullBackLanded={spy}/>;
  const ui=render(element(true));
  const button=await screen.findByRole("button",{name:"Pull back Chapter 2"});
  fireEvent.click(button);
  expect(calls).toHaveLength(1); expect(spy).not.toHaveBeenCalled();
  ui.rerender(element(false));
  await act(async()=>{fireEvent.click(button);});
  expect(spy.mock.calls).toEqual([[B]]);expect(open.mock.calls).toEqual([[B]]);
  expect(routes(calls)).toEqual(["GET "+chaptersPath,"POST "+path(B),"GET "+chaptersPath]);
});
