import { act, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import { Draft } from "../src/draft/Draft";
import { equal, changed, uid } from "./paragraphIdentityFixtures";
import { A, chapterPath } from "./d18Fixtures";
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
