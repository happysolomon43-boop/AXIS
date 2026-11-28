import {act,fireEvent,waitFor} from "@testing-library/react";
import {expect,test} from "vitest";
import {docToEditorDocument} from "../src/editor/model";
import {V,V2,meta,chapterPath,draftPath,nextDetail,rowA} from "./d18Fixtures";
import {editorWorkingState,writeResponse} from "./writeFixtures";
import {captureReply} from "./snapshotCaptureFixtures";
import type {CaptureRequest} from "../src/api/types";
import {deferred} from "./helpers";
import {advance,fakeClock} from "./draftFixtures";
import {ack,allocate,base,sync,conflict,joined,joinAt,joinRaw,mergeLineage,mount,O,P,Q,raw,refusal,restoreClock,split,splitAt,splitLineage,splitRaw,stored} from "./lineageFixtures";

test("AC1 and AC2 guarded split, persisted join, reopen and fresh split",async()=>{
  allocate();
  const ui=mount({status:200,body:stored()},(_,n)=>ack(n+2));
  try{
    await ui.loaded();expect(ui.calls).toHaveLength(1);fakeClock();
    const view=ui.view();splitAt(view);await advance(2000);
    expect(ui.calls[1].body).toEqual({content:splitRaw,base_version:V,base_revision:1,editor_document:split,paragraph_lineage:splitLineage});
    joinAt(view);await advance(5000);
    expect(ui.calls[2].body).toEqual({content:joinRaw,base_version:V,base_revision:2,editor_document:joined,paragraph_lineage:mergeLineage});
    expect(ui.ready).toHaveBeenCalledTimes(1);expect(ui.calls.map(c=>c.method)).toEqual(["GET","PUT","PUT"]);
  }finally{ui.unmount();restoreClock();}
  allocate(Q);const reopened=mount({status:200,body:stored(joined,joinRaw,3,mergeLineage)},ack(4));
  try{
    await reopened.loaded();fakeClock();splitAt(reopened.view());await advance(2000);
    expect(reopened.calls[1].body).toEqual({content:splitRaw,base_version:V,base_revision:3,editor_document:[...split.slice(0,2),{...split[2],paragraph_id:Q}],paragraph_lineage:[...mergeLineage,{kind:"split",old_id:O,new_id:Q}]});
  }finally{reopened.unmount();restoreClock();}
});
test("AC2 lineage-only pending, acknowledgement freezes the pair and preserves newer edits",async()=>{
  allocate();const hold=deferred<ReturnType<typeof ack>>();
  const ui=mount({status:200,body:stored()},()=>hold.promise);
  try{
    await ui.loaded();fakeClock();const view=ui.view(),original=view.state.doc;
    splitAt(view);joinAt(view);expect(view.state.doc.eq(original)).toBe(true);
    expect(ui.root).toHaveAttribute("data-autosave","pending");expect(ui.lock).toHaveBeenLastCalledWith(true);
    await advance(2000);expect(ui.calls[1].body).toEqual({content:raw,base_version:V,base_revision:1,editor_document:joined,paragraph_lineage:mergeLineage});
    act(()=>view.dispatch(view.state.tr.insertText("!",view.state.doc.content.size-1)));
    const doc=view.state.doc,selection=view.state.selection;
    await act(async()=>hold.resolve(ack(2)));
    expect(ui.root).toHaveAttribute("data-autosave","pending");expect(view.state.doc).toBe(doc);expect(view.state.selection.eq(selection)).toBe(true);
    expect(view.dom).toHaveFocus();expect(ui.ready).toHaveBeenCalledTimes(1);expect(ui.calls.map(c=>c.method)).toEqual(["GET","PUT"]);
  }finally{ui.unmount();restoreClock();}
});
test.each([true,false])("AC3 conflict settle compares lineage as well as raw and document (%s)",async match=>{
  allocate();const ui=mount((_,n)=>({status:200,body:n===0?stored():stored(joined,raw,2,match?mergeLineage:null)}),conflict);
  try{
    await ui.loaded();fakeClock();const v=ui.view();splitAt(v);joinAt(v);const doc=v.state.doc,sel=v.state.selection;
    await advance(2000);
    expect(ui.root).toHaveAttribute("data-autosave",match?"idle":"stopped");
    expect(v.state.doc).toBe(doc);expect(v.state.selection.eq(sel)).toBe(true);expect(v.dom).toHaveFocus();
    expect(ui.calls.map(c=>c.method)).toEqual(["GET","PUT","GET"]);
    if(!match){expect(ui.part("reload-latest")).not.toBeNull();expect(ui.part("keep-mine")).not.toBeNull();}
  }finally{ui.unmount();restoreClock();}
});
test("AC4 invalid lineage read fails closed, Retry hydrates null and refusal retains text",async()=>{
  allocate();const ui=mount((_,n)=>({status:200,body:n===0?stored(joined,raw,1,[{kind:"split",old_id:O,new_id:P}]):stored()}),refusal);
  try{
    await waitFor(()=>expect(ui.root).toHaveAttribute("data-state","failed"));expect(ui.ready).not.toHaveBeenCalled();
    fireEvent.click(ui.part("try-again")!);await ui.loaded();fakeClock();
    const v=ui.view();splitAt(v);const doc=v.state.doc;await advance(2000);
    expect(ui.calls[2].body).toMatchObject({paragraph_lineage:splitLineage});
    expect(ui.root).toHaveAttribute("data-autosave","failed");expect(v.state.doc).toBe(doc);expect(docToEditorDocument(doc)).toEqual(split);
    expect(ui.part("autosave")).toHaveTextContent("The draft could not be saved.");
  }finally{ui.unmount();restoreClock();}
});

test.each([true,false])("D18 metadata adoption requires exact confirmed lineage in the coherent head (%s)",async matches=>{
  allocate(Q);
  const initial=stored(joined,raw,1,mergeLineage);
  const latest=stored(joined,raw,3,matches?mergeLineage:null);
  const ui=mount((_,n)=>({status:200,body:n===0?initial:latest}),ack(matches?4:2),[
    {method:"GET",path:meta,reply:{status:200,body:{sync}}},
  ]);
  try{
    await ui.loaded();fakeClock();const view=ui.view(),doc=view.state.doc,selection=view.state.selection;
    await act(async()=>ui.token(1));
    expect(view.state.doc).toBe(doc);expect(view.state.selection.eq(selection)).toBe(true);expect(view.dom).toHaveFocus();
    expect(ui.ready).toHaveBeenCalledTimes(1);
    act(()=>view.dispatch(view.state.tr.insertText("!",view.state.doc.content.size-1)));
    await advance(2000);
    expect(ui.calls.filter(c=>c.method==="PUT").map(c=>c.body)).toEqual([{
      content:"# North\n\nRiver.!",base_version:V,base_revision:matches?3:1,
      editor_document:[joined[0],{...joined[1],text:"River.!"}],paragraph_lineage:mergeLineage,
    }]);
    expect(ui.calls.map(c=>c.method)).toEqual(["GET","GET","GET","PUT"]);
  }finally{ui.unmount();restoreClock();}
});

test.each(["save","send","snapshot"] as const)("verified %s clears the head but preserves the mounted pair for its next edit",async action=>{
  allocate(Q);
  const path=chapterPath+(action==="save"?"/versions":action==="send"?"/send":"/snapshots");
  const {content:_raw,...version}=nextDetail.version!;
  const ui=mount({status:200,body:stored(split,splitRaw,1,splitLineage)},
    {status:200,body:{chapter:rowA,base_version:V2,revision:1,sync:action==="send"?{state:"edited",same:false}:sync}},[
    {method:"POST",path,reply:call=>action==="snapshot"
      ?captureReply(call.body as CaptureRequest,true,true,version)
      :writeResponse(call,{status:201,body:{chapter:rowA,version:{...version,source:action==="send"?"send":"draft_edit"},active_version_id:action==="send"?V2:null,sync:action==="send"?{state:"in_book",same:true}:sync}})},
  ]);
  try{
    await ui.loaded();fakeClock();const view=ui.view(),doc=view.state.doc,sel=view.state.selection;
    await act(async()=>{
      if(action==="snapshot")fireEvent.keyDown(window,{code:"KeyS",ctrlKey:true,cancelable:true});
      else fireEvent.click(ui.part(action)!);
    });
    expect(ui.written).toHaveBeenCalledTimes(1);
    expect(ui.calls.map(c=>c.method)).toEqual(["GET","POST"]);
    expect(ui.calls[1].body).toEqual({request_id:Q.slice(3),base_version:V,base_revision:1,content:splitRaw,
      ...(action==="snapshot"?{}:{parent_version:V})});
    expect(view.state.doc).toBe(doc);expect(view.state.selection.eq(sel)).toBe(true);expect(ui.ready).toHaveBeenCalledTimes(1);
    expect(ui.root).toHaveAttribute("data-autosave","idle");
    await advance(10000);expect(ui.calls).toHaveLength(2);
    act(()=>view.dispatch(view.state.tr.insertText("!",view.state.doc.content.size-1)));await advance(2000);
    expect(ui.calls[2]).toMatchObject({method:"PUT",path:draftPath,body:{content:splitRaw+"!",base_version:V2,base_revision:0,
      editor_document:[...split.slice(0,2),{...split[2],text:"er.!"}],paragraph_lineage:splitLineage}});
  }finally{ui.unmount();restoreClock();}
});

test("a remount after a cleared head seeds no old workspace lineage",async()=>{
  const B="b_000000000003";
  const current={...base,version:{...base.version,id:V2,content:splitRaw,parent_version:V,version_no:2,l_seq:2,source:"draft_edit" as const},
    blocks:[...base.blocks.slice(0,1),{...base.blocks[1],ordinal:2,text:"Riv"},{...base.blocks[1],ordinal:3,text:"er.",block_uid:B}]};
  const ui=mount({status:200,body:editorWorkingState(current)},{status:200,body:{chapter:rowA,base_version:V2,revision:1,sync}});
  try{
    await ui.loaded();fakeClock();expect(ui.calls).toHaveLength(1);
    joinAt(ui.view());await advance(2000);
    expect(ui.calls[1].body).toEqual({content:joinRaw,base_version:V2,base_revision:0,editor_document:joined,paragraph_lineage:[{kind:"merge",old_id:B,new_id:O}]});
  }finally{ui.unmount();restoreClock();}
});
