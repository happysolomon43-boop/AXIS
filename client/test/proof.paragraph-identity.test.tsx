import { act, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { DOMParser } from "prosemirror-model";
import { undo } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import { Draft } from "../src/draft/Draft";
import { schema } from "../src/editor/model";
import { equal, uid } from "./paragraphIdentityFixtures";
import { A, chapterPath } from "./d18Fixtures";
import { mockApi } from "./helpers";
test("AXB-0142 sole fault: an outside forged paragraph cannot steal the stored UID",async()=>{
 const {calls}=mockApi([{method:"GET",path:chapterPath+"/working-state?view=editor-document",reply:{status:200,body:{...equal,editor_document:null}}}]);
 const onEditorReady=vi.fn<(v:EditorView)=>void>(),onWritten=vi.fn();
 const ui=render(<Draft chapterId={A} onLockChange={()=>{}} {...{onEditorReady,onWritten}}/>);
 try{
  await waitFor(()=>expect(onEditorReady).toHaveBeenCalledTimes(1));vi.useFakeTimers();
  const view=onEditorReady.mock.calls[0][0], initial=view.state.doc, pos=initial.firstChild!.nodeSize;
  const html=document.createElement("div");html.innerHTML='<p data-block-uid="'+uid(2)+'">River.</p>';
  const copy=DOMParser.fromSchema(schema).parse(html).firstChild!;
  expect(copy.attrs.block_uid).toBeNull();
  act(()=>view.dispatch(view.state.tr.insert(pos,copy)));
  expect(view.state.doc.child(1).attrs.block_uid).toMatch(/^dp_[0-9a-f-]{36}$/);expect(view.state.doc.child(2).attrs.block_uid).toBe(uid(2));
  const ids:string[]=[];view.state.doc.forEach(n=>{if(n.type.name==="paragraph")ids.push(n.attrs.block_uid)});
  expect(new Set(ids).size).toBe(ids.length);
  act(()=>{undo(view.state,view.dispatch)});expect(view.state.doc.eq(initial)).toBe(true);
  expect(calls.map(c=>[c.method,c.path])).toEqual([["GET",chapterPath+"/working-state?view=editor-document"]]);
  expect(onWritten).not.toHaveBeenCalled();expect(ui.container.querySelector("[data-block-uid]")).toBeNull();
 }finally{ui.unmount();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();}
});
