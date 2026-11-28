import { act, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import { Draft } from "../src/draft/Draft";
import { equal, changed, uid } from "./paragraphIdentityFixtures";
import { A, V, V2, chapterPath, detail, rowA, inBook, revised, meta, draftPath } from "./d18Fixtures";
import { advance, fakeClock } from "./draftFixtures";
import { undo, undoDepth } from "prosemirror-history";
import { mockApi, deferred } from "./helpers";
test("AXB-0141 mount coherent hints, local IDs, metadata-only changes and strict retry",async()=>{
 const bad=structuredClone(equal);bad.draft!.blocks[1].block_uid=null;
 const {calls}=mockApi([{method:"GET",path:chapterPath+"/working-state?view=editor-lineage",reply:(_,n)=>({status:200,body:{...(n===0?bad:changed),editor_document:null,paragraph_lineage:null}})}]);
 const onEditorReady=vi.fn<(v:EditorView)=>void>(),onDocumentChange=vi.fn();
 const ui=render(<Draft chapterId={A} onLockChange={()=>{}} onWritten={()=>{}} {...{onEditorReady,onDocumentChange}}/>);
 try{
  await waitFor(()=>expect(ui.container.querySelector('[data-state="failed"]')).not.toBeNull());
  expect(onEditorReady).not.toHaveBeenCalled();
  act(()=>{ui.container.querySelector<HTMLButtonElement>('[data-part="try-again"]')!.click()});
  await waitFor(()=>expect(onEditorReady).toHaveBeenCalledTimes(1));
  const v=onEditorReady.mock.calls[0][0];expect(v.state.doc.child(1).attrs.block_uid).toBe(uid(6));expect(v.state.doc.child(2).attrs.block_uid).toMatch(/^dp_[0-9a-f-]{36}$/);
  expect(onDocumentChange).not.toHaveBeenCalled();expect(calls).toHaveLength(2);
  expect(ui.container.querySelector("[data-block-uid]")).toBeNull();
 }finally{ui.unmount();vi.unstubAllGlobals();}
});

test("versionless reads fail closed; ordinary empty first version mounts a blank paragraph and keeps guarded writes",async()=>{
 const noVersion={...detail,version:null,active_version_id:null,blocks:[],scenes:[],draft:null,sync:{state:"draft_only",same:false}};
 const empty={...noVersion,version:{...detail.version!,content:""},sync:{state:"draft_only",same:false}};
 const {calls}=mockApi([{method:"GET",path:chapterPath+"/working-state?view=editor-lineage",reply:(_,n)=>({status:200,body:{...(n===0?noVersion:empty),editor_document:null,paragraph_lineage:null}})},
 {method:"PUT",path:draftPath,reply:{status:200,body:{chapter:rowA,base_version:V,revision:1,sync:{state:"draft_only",same:false}}}}]);
 const ready=vi.fn<(v:EditorView)=>void>();
 const ui=render(<Draft chapterId={A} onLockChange={()=>{}} onWritten={()=>{}} onEditorReady={ready}/>);
 try{
  await waitFor(()=>expect(ui.container.querySelector('[data-state="failed"]')).not.toBeNull());
  expect(ready).not.toHaveBeenCalled();expect(calls).toHaveLength(1);
  act(()=>ui.container.querySelector<HTMLButtonElement>('[data-part="try-again"]')!.click());
  await waitFor(()=>expect(ready).toHaveBeenCalledTimes(1));
  const view=ready.mock.calls[0][0];expect(view.state.doc.firstChild!.attrs.block_uid).toMatch(/^dp_[0-9a-f-]{36}$/);expect(view.state.doc.textContent).toBe("");
  fakeClock();act(()=>view.dispatch(view.state.tr.insertText("New",1)));await advance(2000);
  expect(calls.filter(c=>c.method==="PUT").map(c=>c.body)).toEqual([{content:"New",base_version:V,base_revision:0,editor_document:expect.any(Array),paragraph_lineage:[]}]);
 }finally{ui.unmount();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();}
});
test("AXB-0141 identity-only change autosaves, a real split is one callback, and undo is one native event",async()=>{
 const {calls}=mockApi([{method:"GET",path:chapterPath+"/working-state?view=editor-lineage",reply:{status:200,body:{...equal,editor_document:null,paragraph_lineage:null}}},
 {method:"PUT",path:draftPath,reply:(_,n)=>({status:200,body:{chapter:rowA,base_version:V,revision:2+n,sync:inBook}})}]);
 const ready=vi.fn<(v:EditorView)=>void>(),changed=vi.fn();
 const ui=render(<Draft chapterId={A} onLockChange={()=>{}} onWritten={()=>{}} onEditorReady={ready} onDocumentChange={changed}/>);
 try{
  await waitFor(()=>expect(ready).toHaveBeenCalledTimes(1));fakeClock();
  const view=ready.mock.calls[0][0],pos=view.state.doc.firstChild!.nodeSize;
  act(()=>view.dispatch(view.state.tr.setNodeMarkup(pos,undefined,{block_uid:null})));
  const local=view.state.doc.child(1).attrs.block_uid;expect(local).toMatch(/^dp_[0-9a-f-]{36}$/);
  expect(changed).toHaveBeenCalledTimes(1);expect(ui.container.querySelector('[data-surface="draft"]')).toHaveAttribute("data-state","clean");
  expect(ui.container.querySelector('[data-surface="draft"]')).toHaveAttribute("data-autosave","pending");
  await advance(10000);expect(calls).toHaveLength(2);
  const before=view.state.doc;
  act(()=>view.dispatch(view.state.tr.split(pos+3)));
  expect(changed).toHaveBeenCalledTimes(2);expect(view.state.doc.child(1).attrs.block_uid).toBe(local);expect(view.state.doc.child(2).attrs.block_uid).toMatch(/^dp_[0-9a-f-]{36}$/);
  act(()=>{undo(view.state,view.dispatch)});expect(view.state.doc.eq(before)).toBe(true);
  await advance(10000);expect(calls).toHaveLength(2);
  act(()=>view.dispatch(view.state.tr.insertText("!",pos+2)));await advance(2000);
  expect(calls.filter(c=>c.method==="PUT").map(c=>c.body)).toEqual([{content:equal.version!.content,base_version:V,base_revision:1,editor_document:expect.any(Array),paragraph_lineage:[]},{content:equal.version!.content.replace("River.","R!iver."),base_version:V,base_revision:2,editor_document:expect.any(Array),paragraph_lineage:[]}]);
 }finally{ui.unmount();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();}
});

test("AXB-0141 D18 matching notice adopts verified coordinates without changing mixed identities, selection or history",async()=>{
 const next={...equal,version:{...equal.version!,id:V2,parent_version:V,version_no:2,l_seq:2},blocks:equal.blocks.map((b,i)=>({...b,block_uid:uid(i+101)})),draft:null,sync:revised};
 const api=mockApi([{method:"GET",path:chapterPath+"/working-state?view=editor-lineage",reply:(_,n)=>({status:200,body:{...(n===0?equal:next),editor_document:null,paragraph_lineage:null}})},
 {method:"GET",path:meta,reply:{status:200,body:{sync:revised}}},
 {method:"PUT",path:draftPath,reply:{status:200,body:{chapter:rowA,base_version:V2,revision:1,sync:revised}}}]);
 const ready=vi.fn<(v:EditorView)=>void>(),written=vi.fn(),lock=vi.fn();
 const element=(n:number)=><Draft chapterId={A} syncRefreshToken={n} onLockChange={lock} onWritten={written} onEditorReady={ready}/>;
 const ui=render(element(0));
 try{
  await waitFor(()=>expect(ready).toHaveBeenCalledTimes(1));fakeClock();
  const v=ready.mock.calls[0][0],pos=v.state.doc.firstChild!.nodeSize;
  act(()=>v.dispatch(v.state.tr.setNodeMarkup(pos,undefined,{block_uid:null})));
  const original=v.state.doc,selection=v.state.selection,depth=undoDepth(v.state);
  expect(original.child(1).attrs.block_uid).toMatch(/^dp_[0-9a-f-]{36}$/);expect(original.child(2).attrs.block_uid).toBe(uid(3));
  await act(async()=>ui.rerender(element(1)));
  expect(v.state.doc).toBe(original);expect(v.state.selection.eq(selection)).toBe(true);expect(undoDepth(v.state)).toBe(depth);expect(ready).toHaveBeenCalledTimes(1);
  act(()=>v.dispatch(v.state.tr.insertText("!",pos+2)));await advance(2000);
  expect(api.calls.filter(c=>c.method==="GET").map(c=>c.path)).toEqual([chapterPath+"/working-state?view=editor-lineage",meta,chapterPath+"/working-state?view=editor-lineage"]);
  expect(api.calls.find(c=>c.method==="PUT")?.body).toEqual({base_version:V2,base_revision:0,content:equal.version!.content.replace("River.","R!iver."),editor_document:expect.any(Array),paragraph_lineage:[]});
  expect(written).not.toHaveBeenCalled();
 }finally{ui.unmount();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();}
});
