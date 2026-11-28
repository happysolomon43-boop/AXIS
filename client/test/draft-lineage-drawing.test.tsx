import {act,fireEvent,waitFor} from "@testing-library/react";
import {expect,test,vi} from "vitest";
import {deferred} from "./helpers";
import {advance,fakeClock} from "./draftFixtures";
import {ack,allocate,conflict,joined,joinAt,mergeLineage,mount,O,P,Q,raw,refusal,restoreClock,splitAt,stored} from "./lineageFixtures";
type UI=ReturnType<typeof mount>;
// DL-1 preserves the existing D21 structural hooks; DL-6 does not enumerate
// the inherited draft-head, autosave-dot, page, leaf and leaf-edge hooks.
const allowed=new Set("editor-host editor reading read-failure try-again toolbar version-chip save send status write-failure only-here copy-chapter check-again autosave conflict reload-latest keep-mine conflict-copy reload-failure snapshot snapshot-form snapshot-name snapshot-submit snapshot-cancel snapshot-status snapshot-failure snapshot-check-again snapshot-return editor-identity-failure draft-head autosave-dot page leaf leaf-edge".split(" "));
function drawing(ui:UI,state:string,dot:boolean,text="",alerts:string[]=[]){
  expect(ui.root).toHaveAttribute("data-autosave",state);
  const autosave=ui.part("autosave");
  if(autosave){expect(autosave).toHaveAttribute("role","status");expect(autosave.textContent).toBe(text);
    expect(autosave.children.length).toBe(dot?1:0);
    if(dot){expect(autosave.firstElementChild).toHaveClass("ax-autosave__dot");expect(autosave.firstElementChild).toHaveAttribute("aria-hidden","true");}}
  else expect(dot).toBe(false);
  expect(Array.from(ui.root.querySelectorAll('[role="alert"]'),e=>e.getAttribute("data-part"))).toEqual(alerts);
  expect(ui.root.querySelector('[role="tooltip"],[data-part="toast"]')).toBeNull();
  for(const el of ui.root.querySelectorAll("[data-part]"))expect(allowed.has(el.getAttribute("data-part")!)).toBe(true);
  const clone=ui.root.cloneNode(true) as HTMLElement;clone.querySelector('[data-part="editor"]')?.replaceChildren();
  expect(clone.outerHTML).not.toMatch(/paragraph_lineage|\b(?:lineage|alias|split|merge)\b|dp_[0-9a-f-]{36}|b_[0-9a-f]{12}/i);
  for(const el of ui.root.querySelectorAll('[role="status"]'))if(el!==autosave)expect(el.textContent).toBe("");
}
function motion(reduce:boolean){vi.stubGlobal("matchMedia",vi.fn((query:string)=>({matches:reduce&&query.includes("prefers-reduced-motion"),media:query,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:vi.fn()})));}
test.each([false,true])("DL-4 clean, pending, saving, saved and local rejection; reduced motion %s",async reduce=>{
  motion(reduce);const allocator=allocate();const hold=deferred<ReturnType<typeof ack>>();
  const ui=mount({status:200,body:stored()},()=>hold.promise);
  try{
    await ui.loaded();fakeClock();drawing(ui,"idle",false);
    const v=ui.view(),initial=v.state.doc,selection=v.state.selection;
    allocator.mockReturnValue("bad" as ReturnType<Crypto["randomUUID"]>);splitAt(v);
    drawing(ui,"idle",false,"",["editor-identity-failure"]);expect(v.state.doc).toBe(initial);expect(v.state.selection.eq(selection)).toBe(true);expect(v.dom).toHaveFocus();
    expect(ui.part("editor-identity-failure")).toHaveTextContent("The edit could not be applied. Your draft is unchanged.");
    allocator.mockReturnValue(P.slice(3) as ReturnType<Crypto["randomUUID"]>);
    splitAt(v);joinAt(v);expect(v.state.doc.eq(initial)).toBe(true);drawing(ui,"pending",true);
    const doc=v.state.doc,sel=v.state.selection;await advance(2000);drawing(ui,"saving",true);
    expect(ui.calls[1].body).toMatchObject({paragraph_lineage:mergeLineage});
    await act(async()=>hold.resolve(ack(2)));drawing(ui,"idle",false);
    expect(v.state.doc).toBe(doc);expect(v.state.selection.eq(sel)).toBe(true);expect(v.dom).toHaveFocus();expect(ui.ready).toHaveBeenCalledTimes(1);
    const writer=" lineage alias split merge "+Q;act(()=>v.dispatch(v.state.tr.insertText(writer,v.state.doc.content.size-1)));
    expect(v.state.doc.textContent).toContain(writer);
  }finally{ui.unmount();restoreClock();}
});
test.each([false,true])("DL-4 failed 400 and network, no extra drawing; reduced motion %s",async reduce=>{
  for(const failure of [refusal,"network" as const]){
    motion(reduce);allocate();const ui=mount({status:200,body:stored()},failure);
    try{await ui.loaded();fakeClock();const v=ui.view();splitAt(v);joinAt(v);drawing(ui,"pending",true);
      const doc=v.state.doc,sel=v.state.selection;await advance(2000);
      drawing(ui,"failed",true,"The draft could not be saved.");expect(v.state.doc).toBe(doc);expect(v.state.selection.eq(sel)).toBe(true);expect(v.dom).toHaveFocus();
    }finally{ui.unmount();restoreClock();}
  }
});
test.each([false,true])("DL-4 settle, stop and rejected reload; reduced motion %s",async reduce=>{
  for(const match of [true,false]){
    motion(reduce);allocate();const ui=mount((_,n)=>n===0?{status:200,body:stored()}:n===1?{status:200,body:stored(joined,raw,2,match?mergeLineage:null)}:"network",conflict);
    try{await ui.loaded();fakeClock();const v=ui.view();splitAt(v);joinAt(v);const doc=v.state.doc,sel=v.state.selection;
      await advance(2000);drawing(ui,match?"idle":"stopped",!match,"",match?[]:["conflict"]);
      expect(v.state.doc).toBe(doc);expect(v.state.selection.eq(sel)).toBe(true);expect(v.dom).toHaveFocus();
      if(!match){await act(async()=>fireEvent.click(ui.part("reload-latest")!));drawing(ui,"stopped",true,"",["conflict","reload-failure"]);expect(v.state.doc).toBe(doc);expect(v.state.selection.eq(sel)).toBe(true);}
    }finally{ui.unmount();restoreClock();}
  }
});
test.each([false,true])("DL-4 invalid read and null lineage Retry; reduced motion %s",async reduce=>{
  motion(reduce);allocate();const ui=mount((_,n)=>({status:200,body:n===0?stored(joined,raw,1,[{kind:"split",old_id:O,new_id:P},{kind:"merge",old_id:Q,new_id:O}]):stored()}));
  try{await waitFor(()=>expect(ui.root).toHaveAttribute("data-state","failed"));
    expect(ui.part("editor")).toBeNull();expect(ui.part("read-failure")).not.toBeNull();expect(ui.part("try-again")).toHaveTextContent("Try again");
    fireEvent.click(ui.part("try-again")!);await ui.loaded();fakeClock();drawing(ui,"idle",false);expect(ui.view().dom).toHaveFocus();
  }finally{ui.unmount();restoreClock();}
});
