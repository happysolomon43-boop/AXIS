import {act,render,waitFor,fireEvent} from "@testing-library/react";
import {afterEach,expect,test,vi} from "vitest";
import type {EditorView} from "prosemirror-view";
import type {EditorDocument} from "../src/api/types";
import {Draft} from "../src/draft/Draft";
import {docToEditorDocument} from "../src/editor/model";
import {A,V,book,rowA,chapterPath,draftPath,detail} from "./d18Fixtures";
import {workingPath,editorWorkingState} from "./writeFixtures";
import {mockApi,deferred} from "./helpers";
import {advance,fakeClock} from "./draftFixtures";
import {readFileSync} from "node:fs";
const P="dp_00000000-0000-4000-8000-000000000001", Q="dp_00000000-0000-4000-8000-000000000002", B="b_000000000002";
const raw="# North\r\n\r\nRiver.\n", splitRaw="# North\n\nRiv\n\ner.";
const sync={state:"draft_only" as const,same:false}, base={...detail,active_version_id:null,version:{...detail.version!,content:raw},scenes:[],blocks:[{...detail.blocks[0],kind:"heading" as const,text:"North"},{...detail.blocks[0],ordinal:2,block_uid:B,text:"River."}]};
const split:EditorDocument=[{kind:"heading",text:"North",paragraph_id:null},{kind:"paragraph",text:"Riv",paragraph_id:B},{kind:"paragraph",text:"er.",paragraph_id:P}];
const initial=editorWorkingState(base);
function stored(document=split,content=splitRaw,revision=1){
  return editorWorkingState(base,{draft:{base_version:V,revision,content,blocks:[{ordinal:1,kind:"heading",text:"North"},{ordinal:2,kind:"paragraph",text:"Riv"},{ordinal:3,kind:"paragraph",text:"er."}]},sync,editor_document:document});
}
const ack=(revision:number)=>({status:200,body:{chapter:rowA,base_version:V,revision,sync}});
const conflict={status:409,body:{error:{code:"conflict",message:"Draft is out of date",details:{reason:"revision",current_version:V,current_revision:1}}}};
const path=workingPath(chapterPath);
type Handler=Parameters<typeof mockApi>[0][number];
function mount(read:Handler["reply"],put?:Handler["reply"]){
  const ready=vi.fn<(v:EditorView)=>void>(),lock=vi.fn(),written=vi.fn();
  const api=mockApi([{method:"GET",path,reply:read},...(put?[{method:"PUT",path:draftPath,reply:put}]:[])]);
  const ui=render(<Draft chapterId={A} onEditorReady={ready} onLockChange={lock} onWritten={written}/>);
  const root=ui.container.querySelector<HTMLElement>('[data-surface="draft"]')!;
  const part=(name:string)=>root.querySelector<HTMLElement>('[data-part="'+name+'"]');
  return {...api,...ui,root,part,ready,lock,written,view:()=>ready.mock.calls.at(-1)![0],loaded:()=>waitFor(()=>expect(ready).toHaveBeenCalledTimes(1))};
}
afterEach(()=>{if(vi.isFakeTimers())vi.clearAllTimers();vi.useRealTimers();});
test("AC1 split autosave and reopen with exact persisted identity",async()=>{
  vi.spyOn(globalThis.crypto,"randomUUID").mockReturnValue(P.slice(3) as ReturnType<Crypto["randomUUID"]>);
  const ui=mount({status:200,body:initial},ack(1));await ui.loaded();expect(ui.calls).toHaveLength(1);
  fakeClock();const view=ui.view();const at=view.state.doc.firstChild!.nodeSize+4;
  act(()=>view.dispatch(view.state.tr.split(at)));expect(docToEditorDocument(view.state.doc)).toEqual(split);
  await advance(2000);expect(ui.calls[1].body).toEqual({content:splitRaw,base_version:V,base_revision:0,editor_document:split});
  expect(ui.root).toHaveAttribute("data-autosave","saved");ui.unmount();vi.useRealTimers();
  const reopened=mount({status:200,body:stored()});await reopened.loaded();expect(docToEditorDocument(reopened.view().state.doc)).toEqual(split);expect(reopened.calls).toHaveLength(1);expect(reopened.part("editor")).toHaveFocus();
});
test("AC2 identity-only change keeps raw companion and newer edit stays pending",async()=>{
  vi.spyOn(globalThis.crypto,"randomUUID").mockReturnValue(P.slice(3) as ReturnType<Crypto["randomUUID"]>);
  const pending=deferred<ReturnType<typeof ack>>();const ui=mount({status:200,body:initial},()=>pending.promise);await ui.loaded();fakeClock();
  const v=ui.view(),pos=v.state.doc.firstChild!.nodeSize;
  act(()=>v.dispatch(v.state.tr.setNodeMarkup(pos,undefined,{block_uid:null})));
  expect(ui.root).toHaveAttribute("data-state","clean");expect(ui.root).toHaveAttribute("data-autosave","pending");expect(ui.part("autosave-dot")).not.toBeNull();
  expect(ui.part("save")).toHaveAttribute("aria-disabled","true");expect(ui.lock).toHaveBeenLastCalledWith(true);
  await advance(2000);expect(ui.root).toHaveAttribute("data-autosave","saving");expect(ui.calls[1].body).toEqual({content:raw,base_version:V,base_revision:0,editor_document:[{kind:"heading",text:"North",paragraph_id:null},{kind:"paragraph",text:"River.",paragraph_id:P}]});
  act(()=>v.dispatch(v.state.tr.insertText("!",v.state.doc.content.size-1)));const live=v.state.doc,selection=v.state.selection;
  await act(async()=>pending.resolve(ack(1)));expect(ui.root).toHaveAttribute("data-autosave","pending");expect(v.state.doc).toBe(live);expect(v.state.selection.eq(selection)).toBe(true);expect(ui.ready).toHaveBeenCalledTimes(1);expect(ui.calls).toHaveLength(2);
  expect(ui.calls.filter(c=>c.method==="POST")).toHaveLength(0);
});
test.each([true,false])("AC3 conflict settles only exact raw and identity evidence: %s",async matches=>{
  vi.spyOn(globalThis.crypto,"randomUUID").mockReturnValue(P.slice(3) as ReturnType<Crypto["randomUUID"]>);
  const reply=stored(matches?split:[...split.slice(0,2),{...split[2],paragraph_id:Q}]);
  const ui=mount((_,n)=>({status:200,body:n===0?initial:reply}),conflict);await ui.loaded();fakeClock();
  const v=ui.view();act(()=>v.dispatch(v.state.tr.split(v.state.doc.firstChild!.nodeSize+4)));const before=v.state.doc,selection=v.state.selection;
  await advance(2000);expect(ui.calls.map(c=>c.method)).toEqual(["GET","PUT","GET"]);expect(v.state.doc).toBe(before);expect(v.state.selection.eq(selection)).toBe(true);expect(ui.ready).toHaveBeenCalledTimes(1);
  expect(ui.root).toHaveAttribute("data-autosave",matches?"saved":"stopped");
  if(!matches){expect(ui.part("reload-latest")).not.toBeNull();expect(ui.part("keep-mine")).not.toBeNull();expect(ui.part("conflict-copy")).not.toBeNull();
    await act(async()=>fireEvent.click(ui.part("reload-latest")!));expect(ui.ready).toHaveBeenCalledTimes(2);expect(docToEditorDocument(ui.view().state.doc)).toEqual(reply.editor_document);
  }
});
test("AC4/5 allocation failure retains content, selection and focus, draws exact local alert",async()=>{
  for(const theme of ["light","dark","sepia"])for(const profile of ["literary","modern","warm"]){
    document.documentElement.dataset.theme=theme;document.documentElement.dataset.profile=profile;
    const uuid=vi.spyOn(globalThis.crypto,"randomUUID").mockReturnValue("bad" as ReturnType<Crypto["randomUUID"]>);
    const ui=mount({status:200,body:initial});await ui.loaded();fakeClock();
    const v=ui.view(),before=v.state.doc,selection=v.state.selection;
    act(()=>v.dispatch(v.state.tr.split(v.state.doc.firstChild!.nodeSize+4)));
    expect(v.state.doc).toBe(before);expect(v.state.selection.eq(selection)).toBe(true);expect(v.dom).toHaveFocus();expect(ui.calls).toHaveLength(1);
    const alert=ui.part("editor-identity-failure")!;
    expect(alert.tagName).toBe("P");expect(alert).toHaveClass("ax-draft__identity-failure");expect(alert).toHaveAttribute("role","alert");expect(alert).toHaveAttribute("aria-live","polite");expect(alert).toHaveAttribute("aria-atomic","true");expect(alert).not.toHaveAttribute("tabindex");expect(alert).toHaveTextContent("The edit could not be applied. Your draft is unchanged.");expect(ui.root.lastElementChild).toBe(alert);expect(ui.root.querySelectorAll('[data-part="editor-identity-failure"]')).toHaveLength(1);
    uuid.mockReturnValue(P.slice(3) as ReturnType<Crypto["randomUUID"]>);
    act(()=>v.dispatch(v.state.tr.split(v.state.doc.firstChild!.nodeSize+4)));expect(ui.part("editor-identity-failure")).toBeNull();expect(v.dom).toHaveFocus();
    ui.unmount();vi.clearAllTimers();vi.useRealTimers();uuid.mockRestore();
  }
  delete document.documentElement.dataset.theme;delete document.documentElement.dataset.profile;
  const css=readFileSync(new URL("../src/styles/draft-identity.css",import.meta.url),"utf8"),tokens=readFileSync(new URL("../src/styles/tokens.css",import.meta.url),"utf8");
  for(const token of css.matchAll(/var\((--[^)]+)\)/g))expect(tokens).toContain(token[1]+":");
  for(const decl of ["position: sticky","inset-block-end: 0","z-index: var(--ax-z-shell)","box-sizing: border-box","inline-size: 100%","margin: 0","min-block-size: var(--ax-size-status-line)","padding-block: var(--ax-space-2)","padding-inline: var(--ax-space-6)","background: var(--ax-color-surface-shell)","color: var(--ax-color-text-primary)","border-block-start: 1px solid var(--ax-color-border-hair)","border-radius: 0","box-shadow: none","font-family: var(--ax-type-family-chrome)","font-size: 0.875rem","line-height: 1.25rem","font-weight: 400","letter-spacing: 0","text-align: start","overflow-wrap: anywhere","@media (max-width: 767px)","font-size: 0.9375rem","line-height: 1.375rem","@media (forced-colors: active)","background: Canvas","color: CanvasText","border-block-start-color: CanvasText"])expect(css).toContain(decl);
  expect(css).not.toMatch(/animation|transition|@keyframes|opacity|outline|#[0-9a-f]{3,8}\b|(?:^|\s)block-size:/i);
  function luminance(hex:string){const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;}
  for(const [ink,shell] of [["#1B1C1E","#ECEBE6"],["#D9D6CD","#0B0C0E"],["#2B2418","#D8CAAD"]]){const a=luminance(ink),b=luminance(shell);expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeGreaterThanOrEqual(7);}
});
