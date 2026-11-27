import { workingPath, workingRead } from "./writeFixtures";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import { Shell } from "../src/shell/Shell";
import type { ChapterSync } from "../src/api/types";
import { b, chapterA, chapterPath, detailText, reply } from "./d06.fixtures";
import { draftNone, draftPath } from "./draftFixtures";
import { chaptersPath, deferred, mockApi } from "./helpers";
import { pbTree, pbList, pullBackReplyB } from "./pullbackFixtures";
import { syncInBook, syncRevisedSame, withSync } from "./syncDraftFixtures";
const editor = vi.hoisted(() => ({ view: null as EditorView | null }));
vi.mock("../src/editor/Editor",async(importOriginal)=>{
  const {Editor}=await importOriginal<typeof import("../src/editor/Editor")>();
  return {Editor:(props:Parameters<typeof Editor>[0])=><Editor {...props} onReady={view=>{editor.view=view;props.onReady?.(view);}}/>};
});
const A=chapterA.id, B=pbList.chapters[1].id, pathB="/api/chapters/"+B;
const meta=draftPath+"?view=sync";
const pull=(id:string)=>"/api/chapters/"+id+"/pull-back";
const part=(scope:ParentNode,name:string)=>scope.querySelector<HTMLElement>('[data-part="'+name+'"]')!;
const root=(scope:ParentNode)=>scope.querySelector<HTMLElement>('[data-surface="draft"]')!;
const list=(a:ChapterSync,bState:ChapterSync=syncInBook)=>({chapters:pbList.chapters.map(row=>row.id===A?{...row,version_id:b,active_version_id:b,sync:a}:row.id===B?{...row,sync:bState}:row)});
const postA={...pullBackReplyB,body:{chapter:chapterA,active_version_id:b}};
const head=withSync({status:200,body:draftNone},syncInBook);
afterEach(()=>vi.unstubAllGlobals());
test("AXB-0087 AC1 only the open Draft receives the landed signal",async()=>{
  const held=deferred<ReturnType<typeof reply>>();
  const {calls}=mockApi([
    {method:"GET",path:chaptersPath,reply:(_,n)=>reply(list(n===0?syncInBook:syncRevisedSame))},
    workingRead(chapterPath, reply(detailText), head),
    {method:"POST",path:pull(A),reply:postA},
    {method:"GET",path:meta,reply:()=>held.promise},
  ]);
  const ui=render(<Shell tree={pbTree}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Open Chapter 1"}));
  await waitFor(()=>expect(root(ui.container)).toHaveAttribute("data-state","clean"));
  const draft=root(ui.container), view=editor.view, text=view!.state.doc;
  const history=part(ui.container,"history-door").getAttribute("aria-expanded");
  const before=calls.length;
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Pull back Chapter 1"}));});
  expect(part(draft,"version-chip")).toBeNull();
  await act(async()=>{held.resolve(reply({sync:syncRevisedSame}));});
  expect(part(draft,"version-chip")).toHaveTextContent("Being revised, no changes yet");
  expect(root(ui.container)).toBe(draft);expect(editor.view).toBe(view);
  expect(editor.view!.state.doc.eq(text)).toBe(true);
  expect(part(ui.container,"history-door")).toHaveAttribute("aria-expanded",history!);
  expect(calls.slice(before).map(c=>c.method+" "+c.path).sort()).toEqual(["GET "+chaptersPath,"GET "+meta,"POST "+pull(A),"GET "+workingPath(chapterPath)].sort());
});
test("AXB-0087 AC2 routes against live chapter; navigation does not replay token",async()=>{
  const post=deferred<"network">(), settle=deferred<ReturnType<typeof reply>>();
  const chapterB={...chapterA,id:B,order_key:"0000002000"};
  const {calls}=mockApi([
    {method:"GET",path:chaptersPath,reply:(_,n)=>n===0?reply(list(syncInBook)):n===1?settle.promise:reply(list(syncRevisedSame,n===2?syncInBook:syncRevisedSame))},
    workingRead(chapterPath, reply(detailText), head),
    workingRead(pathB, reply({...detailText,chapter:chapterB,version:{...detailText.version!,chapter_id:B}}), reply({chapter:chapterB,draft:null,sync:syncInBook})),
    {method:"POST",path:pull(A),reply:()=>post.promise},
    {method:"POST",path:pull(B),reply:pullBackReplyB},
    {method:"GET",path:pathB+"/draft?view=sync",reply:reply({sync:syncRevisedSame})},
  ]);
  const ui=render(<Shell tree={pbTree}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Open Chapter 1"}));
  await waitFor(()=>expect(root(ui.container)).toHaveAttribute("data-state","clean"));
  fireEvent.click(screen.getByRole("button",{name:"Pull back Chapter 1"}));
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Open Chapter 2"}));});
  expect(root(ui.container)).toHaveAttribute("data-state","clean");
  const draftB=root(ui.container), viewB=editor.view;
  await act(async()=>{post.resolve("network");});
  expect(calls.filter(c=>c.path===chaptersPath)).toHaveLength(2);
  // Keep the D10 non-current navigation guard in force; the read already started.
  fireEvent.click(part(ui.container,"book-toggle"));
  const focus=document.activeElement;
  await act(async()=>{settle.resolve(reply(list(syncRevisedSame)));});
  expect(root(ui.container)).toBe(draftB);expect(editor.view).toBe(viewB);
  expect(document.activeElement).toBe(focus);
  expect(calls.filter(c=>c.path.includes("?view=sync"))).toHaveLength(0);
  await act(async()=>{fireEvent.click(part(ui.container,"book-toggle"));});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Pull back Chapter 2"}));});
  expect(part(draftB,"version-chip")).toHaveTextContent("Being revised, no changes yet");
  expect(calls.filter(c=>c.path.includes("?view=sync")).map(c=>c.path)).toEqual([pathB+"/draft?view=sync"]);
  const before=calls.length;
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Open Chapter 1"}));});
  expect(calls.slice(before).map(c=>c.method+" "+c.path)).toEqual(["GET "+workingPath(chapterPath)]);
});
