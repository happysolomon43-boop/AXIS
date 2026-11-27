import {act,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,test,vi} from "vitest";
import {undoDepth} from "prosemirror-history";
import type {EditorView} from "prosemirror-view";
import {Draft} from "../src/draft/Draft";
import {Shell} from "../src/shell/Shell";
import {A,V,V2,rowA,detail,nextDetail,head,nextHead,chapterPath,draftPath,meta,revised,part,tree,list,landed,listPath,pullPath,success,row} from "./d18Fixtures";
import {advance,edit,fakeClock} from "./draftFixtures";
import {deferred,internalError,mockApi} from "./helpers";
import {reply} from "./d06.fixtures";
type Handler=Parameters<typeof mockApi>[0][number];
async function mount(chapter:Handler["reply"],draft:Handler["reply"],put:Handler["reply"]=reply({chapter:rowA,base_version:V2,revision:1,sync:revised})){
 const api=mockApi([{method:"GET",path:chapterPath,reply:(_,n)=>n===0?reply(detail):typeof chapter==="function"?chapter(_,n):chapter},{method:"GET",path:draftPath,reply:(_,n)=>n===0?reply(head):typeof draft==="function"?draft(_,n):draft},{method:"GET",path:meta,reply:reply({sync:revised})},{method:"PUT",path:draftPath,reply:put}]);
 const onEditorReady=vi.fn<(v:EditorView)=>void>(),onLockChange=vi.fn(),onWritten=vi.fn();const element=(token:number)=><Draft chapterId={A} syncRefreshToken={token} {...{onEditorReady,onLockChange,onWritten}}/>;const ui=render(element(0));const root=ui.container.querySelector('[data-surface="draft"]')!;
 await waitFor(()=>expect(root).toHaveAttribute("data-state","clean"));
 return {...ui,...api,root,onEditorReady,view:onEditorReady.mock.calls[0][0],token:(n:number)=>ui.rerender(element(n))};
}
afterEach(()=>{if(vi.isFakeTimers())vi.clearAllTimers();vi.useRealTimers();});
test("AXB-0133 AC1/2 clean metadata adopts V2 and exact null or equal head revision without remount",async()=>{
 for(const revision of [0,3]){
 const ui=await mount(reply(nextDetail),reply(nextHead(revision)));fakeClock();const view=ui.view;
 act(()=>view.focus());const doc=view.state.doc,selection=view.state.selection,depth=undoDepth(view.state),focus=document.activeElement;
 await act(async()=>ui.token(1));expect(ui.onEditorReady).toHaveBeenCalledTimes(1);expect(view.state.doc).toBe(doc);expect(view.state.selection.eq(selection)).toBe(true);expect(undoDepth(view.state)).toBe(depth);expect(document.activeElement).toBe(focus);expect(ui.root).toHaveAttribute("data-state","clean");expect(ui.calls.filter(c=>c.method==="GET"&&c.path===chapterPath)).toHaveLength(2);expect(ui.calls.filter(c=>c.method==="GET"&&c.path===draftPath)).toHaveLength(2);
 edit(view);await advance(2000);expect(ui.calls.find(c=>c.method==="PUT")?.body).toMatchObject({base_version:V2,base_revision:revision,content:"River.!"});ui.unmount();vi.clearAllTimers();vi.useRealTimers();
 }
});
test("AXB-0133 AC2 mismatched raw text or head does not adopt",async()=>{
 for(const [chapter,draft] of [[reply({...nextDetail,version:{...nextDetail.version!,content:"Other."}}),reply(nextHead())],[reply(nextDetail),reply({...nextHead(3),draft:{...nextHead(3).draft!,base_version:V}})],[reply(nextDetail),reply({...nextHead(3),draft:{...nextHead(3).draft!,content:"Other."}})]] as const){
 const ui=await mount(chapter,draft,reply({chapter:rowA,base_version:V,revision:2,sync:revised}));fakeClock();await act(async()=>ui.token(1));edit(ui.view);await advance(2000);expect(ui.calls.find(c=>c.method==="PUT")?.body).toMatchObject({base_version:V,base_revision:1});ui.unmount();vi.clearAllTimers();vi.useRealTimers();
 }
});
test("AXB-0133 AC3 typing during verification and a dirty notice cannot adopt or request stale follow-on",async()=>{
 const pending=deferred<ReturnType<typeof reply>>(),ui=await mount(()=>pending.promise,reply(nextHead()),reply({chapter:rowA,base_version:V,revision:2,sync:revised}));fakeClock();
 ui.token(1);expect(ui.calls.filter(c=>c.path===chapterPath)).toHaveLength(2);edit(ui.view);ui.token(2);await act(async()=>pending.resolve(reply(nextDetail)));expect(ui.calls.filter(c=>c.path===draftPath&&c.method==="GET")).toHaveLength(1);expect(ui.calls.filter(c=>c.path===chapterPath)).toHaveLength(2);await advance(2000);expect(ui.calls.find(c=>c.method==="PUT")?.body).toMatchObject({base_version:V,base_revision:1,content:"River.!"});ui.unmount();
});
test("AXB-0133 AC4 failed metadata and stale PUT preserve local text and conflict options",async()=>{
 for(const failFirst of [true,false]){const conflict=reply({error:{code:"conflict",message:"Draft is out of date",details:{reason:"version",current_version:V2,current_revision:0}}},409);const ui=await mount(failFirst?internalError:reply(nextDetail),(_,n)=>n===1&&!failFirst?internalError:reply(nextHead()),conflict);fakeClock();await act(async()=>ui.token(1));edit(ui.view);await advance(2000);expect(ui.view.state.doc.textContent).toBe("River.!");expect(ui.calls.find(c=>c.method==="PUT")?.body).toMatchObject({base_version:V,base_revision:1});expect(ui.root).toHaveAttribute("data-state","conflict");ui.unmount();vi.clearAllTimers();vi.useRealTimers();}
});

test("AXB-0133 AC1 mounted History refreshes once without a second Binder read",async()=>{
 const historyPath=chapterPath+"/history";const {content:_raw,...v}=detail.version!;const {content:_next,...v2}=nextDetail.version!;const initial={chapter:rowA,active_version_id:V,versions:[{...v,at:"2026-11-26T00:00:00Z",word_count:1,snapshot:null,can_name_snapshot:false}]};const refreshed={...initial,versions:[{...v2,at:"2026-11-27T00:00:00Z",word_count:1,snapshot:null,can_name_snapshot:false},...initial.versions]};let committed=false;
 const {calls}=mockApi([{method:"GET",path:listPath,reply:()=>reply(committed?landed:list)},{method:"GET",path:chapterPath,reply:()=>reply(committed?nextDetail:detail)},{method:"GET",path:draftPath,reply:()=>reply(committed?nextHead():head)},{method:"GET",path:meta,reply:reply({sync:revised})},{method:"GET",path:historyPath,reply:()=>reply(committed?refreshed:initial)},{method:"POST",path:pullPath,reply:()=>{committed=true;return reply(success);}}]);
 const ui=render(<Shell tree={tree}/>);fireEvent.click(await screen.findByRole("button",{name:"Open Chapter 2"}));await waitFor(()=>expect(ui.container.querySelector('[data-surface="draft"]')).toHaveAttribute("data-state","clean"));fireEvent.click(screen.getByRole("button",{name:"History"}));await waitFor(()=>expect(ui.container.querySelector('[data-version-id="'+V+'"]')).not.toBeNull());
 fireEvent.click(part(row(ui.container,A),"chapter-menu-trigger"));fireEvent.click(screen.getByRole("menuitem",{name:"Pull back to Draft"}));await waitFor(()=>expect(ui.container.querySelector('[data-version-id="'+V2+'"]')).not.toBeNull());expect(part(ui.container.querySelector('[data-version-id="'+V2+'"]')!,"version-source")).toHaveTextContent("Saved");expect(part(ui.container.querySelector('[data-version-id="'+V2+'"]')!,"in-book")).toBeNull();expect(part(ui.container.querySelector('[data-version-id="'+V+'"]')!,"in-book")).not.toBeNull();expect(calls.filter(c=>c.path===historyPath)).toHaveLength(2);expect(calls.filter(c=>c.path===listPath)).toHaveLength(2);expect(calls.filter(c=>c.method==="POST")).toHaveLength(1);ui.unmount();
});
