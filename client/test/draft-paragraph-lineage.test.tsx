import {act,fireEvent,waitFor} from "@testing-library/react";
import {expect,test} from "vitest";
import {docToEditorDocument} from "../src/editor/model";
import {V} from "./d18Fixtures";
import {deferred} from "./helpers";
import {advance,fakeClock} from "./draftFixtures";
import {ack,allocate,conflict,joined,joinAt,joinRaw,mergeLineage,mount,O,P,Q,raw,refusal,restoreClock,split,splitAt,splitLineage,splitRaw,stored} from "./lineageFixtures";

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
