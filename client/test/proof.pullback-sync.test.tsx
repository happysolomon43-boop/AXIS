import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import { Shell } from "../src/shell/Shell";
import type { ChapterSync } from "../src/api/types";
import { b,c,chapterA,chapterPath,detailText,reply,writtenC } from "./d06.fixtures";
import { draftNone,draftPath,edit,fakeClock } from "./draftFixtures";
import { chaptersPath,deferred,mockApi } from "./helpers";
import { pbList,pbTree,pullBackReplyB } from "./pullbackFixtures";
import { syncInBook,syncRevisedSame,withSync } from "./syncDraftFixtures";
const editor=vi.hoisted(()=>({view:null as EditorView|null}));
vi.mock("../src/editor/Editor",async(importOriginal)=>{
  const {Editor}=await importOriginal<typeof import("../src/editor/Editor")>();
  return {Editor:(props:Parameters<typeof Editor>[0])=><Editor {...props} onReady={view=>{editor.view=view;props.onReady?.(view);}}/>};
});
const part=(scope:ParentNode,name:string)=>scope.querySelector<HTMLElement>('[data-part="'+name+'"]')!;
const list=(sync:ChapterSync,version:string)=>({chapters:pbList.chapters.map(row=>row.id===chapterA.id?{...row,version_id:version,active_version_id:version,sync}:row)});
const meta=draftPath+"?view=sync",pull=chapterPath+"/pull-back",send=chapterPath+"/send";
afterEach(()=>{if(vi.isFakeTimers())vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
test("AXB-0088 AC2 Break-It Probe: Send wins against a held Pull back snapshot",async()=>{
  const stale=deferred<ReturnType<typeof reply>>(),fresh=deferred<ReturnType<typeof reply>>();
  const {calls}=mockApi([
    {method:"GET",path:chaptersPath,reply:(_,n)=>reply(n===0?list(syncInBook,b):n===1?list(syncRevisedSame,b):list(syncInBook,c))},
    {method:"GET",path:chapterPath,reply:reply({...detailText,active_version_id:b})},
    {method:"GET",path:draftPath,reply:withSync({status:200,body:draftNone},syncInBook)},
    {method:"POST",path:pull,reply:{...pullBackReplyB,body:{chapter:chapterA,active_version_id:b}}},
    {method:"GET",path:meta,reply:(_,n)=>{if(n===0)return stale.promise;if(n===1)return fresh.promise;throw Error("unexpected third projection");}},
    {method:"POST",path:send,reply:reply(writtenC(c),201)},
  ]);
  const ui=render(<Shell tree={pbTree}/>);
  try{
    fireEvent.click(await screen.findByRole("button",{name:"Open Chapter 1"}));
    const root=ui.container.querySelector<HTMLElement>('[data-surface="draft"]')!;
    await waitFor(()=>expect(root).toHaveAttribute("data-state","clean"));
    const start=calls.length;
    fakeClock();
    await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Pull back Chapter 1"}));});
    expect(calls.filter(c=>c.path===meta)).toHaveLength(1);
    expect(part(root,"version-chip")).toBeNull();
    const row=ui.container.querySelector('[data-chapter-id="'+chapterA.id+'"]')!;
    expect(part(row,"chip")).toHaveTextContent("Being revised, no changes yet");
    edit(editor.view!);
    await act(async()=>{fireEvent.click(part(root,"send"));});
    expect(root).toHaveAttribute("data-state","clean");
    expect(part(root,"version-chip")).toBeNull();
    const view=editor.view!,text=view.state.doc;
    expect(text.textContent).toContain("Two!");
    expect(part(row,"chip")).toBeNull();
    await act(async()=>{stale.resolve(reply({sync:syncRevisedSame}));});
    expect(part(root,"version-chip")).toBeNull();
    expect(calls.filter(c=>c.path===meta)).toHaveLength(2);
    expect(editor.view).toBe(view);expect(view.state.doc.eq(text)).toBe(true);
    await act(async()=>{fresh.resolve(reply({sync:syncInBook}));});
    expect(part(root,"version-chip")).toBeNull();
    expect(editor.view).toBe(view);expect(view.state.doc.eq(text)).toBe(true);
    expect(calls.slice(start).map(c=>c.method+" "+c.path).sort()).toEqual([
      "POST "+pull,"POST "+send,"GET "+chaptersPath,"GET "+chaptersPath,"GET "+meta,"GET "+meta,
    ].sort());
  }finally{
    ui.unmount();
    if(vi.isFakeTimers())vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
