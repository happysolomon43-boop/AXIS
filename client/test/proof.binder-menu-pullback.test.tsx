import { workingRead } from "./writeFixtures";
import {act,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {expect,test,vi} from "vitest";
import type {EditorView} from "prosemirror-view";
import {Shell} from "../src/shell/Shell";
import {A,V,V2,tree,list,landed,listPath,chapterPath,pullPath,meta,detail,nextDetail,head,nextHead,revised,row,part} from "./d18Fixtures";
import {reply} from "./d06.fixtures";
import {mockApi} from "./helpers";
const watch=vi.hoisted(()=>({view:null as EditorView|null,notice:vi.fn(),opened:vi.fn()}));
vi.mock("../src/editor/Editor",async original=>{const {Editor}=await original<typeof import("../src/editor/Editor")>();return {Editor:(props:Parameters<typeof Editor>[0])=><Editor {...props} onReady={v=>{watch.view=v;props.onReady?.(v);}}/>};});
vi.mock("../src/binder/Binder",async original=>{const {Binder}=await original<typeof import("../src/binder/Binder")>();return {Binder:(props:Parameters<typeof Binder>[0])=><Binder {...props} onChapterPullBackLanded={id=>{watch.notice(id);props.onChapterPullBackLanded?.(id);}} onOpenChapter={id=>{watch.opened(id);props.onOpenChapter?.(id);}}/>};});
test("AXB-0134 AC2 one committed lost reply settles once on A/V without another write",async()=>{
 vi.stubEnv("VITE_AXIS_USER","usr_aa");watch.notice.mockClear();watch.opened.mockClear();
 const recorded={versions:[{id:V,active:true}],marks:[] as string[],active:V};let committed=false;
 const {calls}=mockApi([{method:"GET",path:listPath,reply:()=>reply(committed?landed:list)},workingRead(chapterPath, ()=>reply(committed?nextDetail:detail), ()=>reply(committed?nextHead():head)),{method:"GET",path:meta,reply:reply({sync:revised})},{method:"POST",path:pullPath,reply:call=>{expect(call.body).toEqual({expected_active_version_id:V});expect(committed).toBe(false);recorded.versions.push({id:V2,active:false});recorded.marks.push(V);committed=true;return "network";}}]);
 const ui=render(<Shell tree={tree}/>);
 try{
 fireEvent.click(await screen.findByRole("button",{name:"Open Chapter 2"}));const draft=ui.container.querySelector('[data-surface="draft"]')!;await waitFor(()=>expect(draft).toHaveAttribute("data-state","clean"));
 const editor=watch.view!,doc=editor.state.doc,selection=editor.state.selection;const a=row(ui.container,A),op=part(a,"chapter-open");act(()=>op.focus());fireEvent.keyDown(op,{key:"F10",shiftKey:true});
 await act(async()=>fireEvent.click(screen.getByRole("menuitem",{name:"Pull back to Draft"})));
 await waitFor(()=>expect(part(a,"chip")).toHaveTextContent("Being revised, no changes yet"));
 expect(calls.filter(c=>c.method==="POST")).toHaveLength(1);expect(calls.filter(c=>c.method==="GET"&&c.path===listPath)).toHaveLength(2);expect(watch.notice.mock.calls).toEqual([[A]]);expect(watch.opened.mock.calls).toEqual([[A]]);expect(op).toHaveFocus();expect(watch.view).toBe(editor);expect(editor.state.doc).toBe(doc);expect(editor.state.selection.eq(selection)).toBe(true);expect(recorded).toEqual({versions:[{id:V,active:true},{id:V2,active:false}],marks:[V],active:V});expect(part(ui.container,"pull-back-failure")).toBeNull();
 }finally{ui.unmount();vi.unstubAllGlobals();vi.unstubAllEnvs();if(vi.isFakeTimers())vi.clearAllTimers();vi.useRealTimers();}
});
