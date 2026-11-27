import { act, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import { Draft } from "../src/draft/Draft";
import { equal, changed, uid } from "./paragraphIdentityFixtures";
import { A, V, chapterPath, detail, rowA, inBook, draftPath } from "./d18Fixtures";
import { advance, fakeClock } from "./draftFixtures";
import { undo } from "prosemirror-history";
import { mockApi } from "./helpers";
test("AXB-0141 mount coherent hints, local IDs, metadata-only changes and strict retry",async()=>{
 const bad=structuredClone(equal);bad.draft!.blocks[1].block_uid=null;
 const {calls}=mockApi([{method:"GET",path:chapterPath+"/working-state",reply:(_,n)=>({status:200,body:n===0?bad:changed})}]);
 const onEditorReady=vi.fn<(v:EditorView)=>void>(),onDocumentChange=vi.fn();
 const ui=render(<Draft chapterId={A} onLockChange={()=>{}} onWritten={()=>{}} {...{onEditorReady,onDocumentChange}}/>);
 try{
  await waitFor(()=>expect(ui.container.querySelector('[data-state="failed"]')).not.toBeNull());
  expect(onEditorReady).not.toHaveBeenCalled();
  act(()=>{ui.container.querySelector<HTMLButtonElement>('[data-part="try-again"]')!.click()});
  await waitFor(()=>expect(onEditorReady).toHaveBeenCalledTimes(1));
  const v=onEditorReady.mock.calls[0][0];expect(v.state.doc.child(1).attrs.block_uid).toBe(uid(6));expect(v.state.doc.child(2).attrs.block_uid).toBe("local_p_1");
  expect(onDocumentChange).not.toHaveBeenCalled();expect(calls).toHaveLength(2);
  expect(ui.container.querySelector("[data-block-uid]")).toBeNull();
 }finally{ui.unmount();vi.unstubAllGlobals();}
});

test("versionless reads fail closed; ordinary empty first version mounts a blank paragraph and keeps guarded writes",async()=>{
 const noVersion={...detail,version:null,active_version_id:null,blocks:[],scenes:[],draft:null,sync:{state:"draft_only",same:false}};
 const empty={...noVersion,version:{...detail.version!,content:""},sync:{state:"draft_only",same:false}};
 const {calls}=mockApi([{method:"GET",path:chapterPath+"/working-state",reply:(_,n)=>({status:200,body:n===0?noVersion:empty})},
 {method:"PUT",path:draftPath,reply:{status:200,body:{chapter:rowA,base_version:V,revision:1,sync:{state:"draft_only",same:false}}}}]);
 const ready=vi.fn<(v:EditorView)=>void>();
 const ui=render(<Draft chapterId={A} onLockChange={()=>{}} onWritten={()=>{}} onEditorReady={ready}/>);
 try{
  await waitFor(()=>expect(ui.container.querySelector('[data-state="failed"]')).not.toBeNull());
  expect(ready).not.toHaveBeenCalled();expect(calls).toHaveLength(1);
  act(()=>ui.container.querySelector<HTMLButtonElement>('[data-part="try-again"]')!.click());
  await waitFor(()=>expect(ready).toHaveBeenCalledTimes(1));
  const view=ready.mock.calls[0][0];expect(view.state.doc.firstChild!.attrs.block_uid).toBe("local_p_1");expect(view.state.doc.textContent).toBe("");
  fakeClock();act(()=>view.dispatch(view.state.tr.insertText("New",1)));await advance(2000);
  expect(calls.filter(c=>c.method==="PUT").map(c=>c.body)).toEqual([{content:"New",base_version:V,base_revision:0}]);
 }finally{ui.unmount();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();}
});
test("AXB-0141 metadata-only change is not dirty, a real split is one callback, and undo is one native event",async()=>{
 const {calls}=mockApi([{method:"GET",path:chapterPath+"/working-state",reply:{status:200,body:equal}},
 {method:"PUT",path:draftPath,reply:{status:200,body:{chapter:rowA,base_version:V,revision:2,sync:inBook}}}]);
 const ready=vi.fn<(v:EditorView)=>void>(),changed=vi.fn();
 const ui=render(<Draft chapterId={A} onLockChange={()=>{}} onWritten={()=>{}} onEditorReady={ready} onDocumentChange={changed}/>);
 try{
  await waitFor(()=>expect(ready).toHaveBeenCalledTimes(1));fakeClock();
  const view=ready.mock.calls[0][0],pos=view.state.doc.firstChild!.nodeSize;
  act(()=>view.dispatch(view.state.tr.setNodeMarkup(pos,undefined,{block_uid:null})));
  const local=view.state.doc.child(1).attrs.block_uid;expect(local).toBe("local_p_1");
  expect(changed).toHaveBeenCalledTimes(1);expect(ui.container.querySelector('[data-surface="draft"]')).toHaveAttribute("data-state","clean");
  await advance(10000);expect(calls).toHaveLength(1);
  const before=view.state.doc;
  act(()=>view.dispatch(view.state.tr.split(pos+3)));
  expect(changed).toHaveBeenCalledTimes(2);expect(view.state.doc.child(1).attrs.block_uid).toBe(local);expect(view.state.doc.child(2).attrs.block_uid).toBe("local_p_2");
  act(()=>{undo(view.state,view.dispatch)});expect(view.state.doc.eq(before)).toBe(true);
  await advance(10000);expect(calls).toHaveLength(1);
  act(()=>view.dispatch(view.state.tr.insertText("!",pos+2)));await advance(2000);
  expect(calls.filter(c=>c.method==="PUT").map(c=>c.body)).toEqual([{content:equal.version!.content.replace("River.","R!iver."),base_version:V,base_revision:1}]);
 }finally{ui.unmount();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();}
});
