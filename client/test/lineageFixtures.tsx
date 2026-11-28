import {act,render,waitFor} from "@testing-library/react";
import {expect,vi} from "vitest";
import type {EditorView} from "prosemirror-view";
import type {EditorDocument,ParagraphLineageRecord} from "../src/api/types";
import {Draft} from "../src/draft/Draft";
import {A,V,rowA,chapterPath,draftPath,detail} from "./d18Fixtures";
import {workingPath,editorWorkingState} from "./writeFixtures";
import {mockApi} from "./helpers";
export const O="b_000000000002",P="dp_00000000-0000-4000-8000-000000000001",Q="dp_00000000-0000-4000-8000-000000000002";
export const raw="# North\r\n\r\nRiver.\n",splitRaw="# North\n\nRiv\n\ner.",joinRaw="# North\n\nRiver.";
export const sync={state:"draft_only" as const,same:false};
export const base={...detail,active_version_id:null,version:{...detail.version!,content:raw},scenes:[],blocks:[{...detail.blocks[0],kind:"heading" as const,text:"North"},{...detail.blocks[0],ordinal:2,block_uid:O,text:"River."}]};
export const joined:EditorDocument=[{kind:"heading",text:"North",paragraph_id:null},{kind:"paragraph",text:"River.",paragraph_id:O}];
export const split:EditorDocument=[joined[0],{kind:"paragraph",text:"Riv",paragraph_id:O},{kind:"paragraph",text:"er.",paragraph_id:P}];
export const splitLineage:ParagraphLineageRecord[]=[{kind:"split",old_id:O,new_id:P}];
export const mergeLineage:ParagraphLineageRecord[]=[{kind:"merge",old_id:P,new_id:O}];
export function stored(document=joined,content=raw,revision=1,lineage:ParagraphLineageRecord[]|null=null){
  return editorWorkingState(base,{draft:{base_version:V,revision,content,blocks:document.map(({kind,text},i)=>({kind,text,ordinal:i+1}))},sync,editor_document:document,paragraph_lineage:lineage});
}
export const ack=(revision:number)=>({status:200,body:{chapter:rowA,base_version:V,revision,sync}});
export const conflict={status:409,body:{error:{code:"conflict",message:"Draft is out of date",details:{reason:"revision",current_version:V,current_revision:2}}}};
export const refusal={status:400,body:{error:{code:"validation_failed",message:"Request validation failed",details:{errors:[{path:"/paragraph_lineage",message:"must be sorted lineage records that match the editor document"}]}}}};
export const path=workingPath(chapterPath);
type Handler=Parameters<typeof mockApi>[0][number];
export function mount(read:Handler["reply"],put?:Handler["reply"],extra:Handler[]=[]){
  const ready=vi.fn<(v:EditorView)=>void>(),lock=vi.fn(),written=vi.fn();
  const api=mockApi([{method:"GET",path,reply:read},...(put?[{method:"PUT",path:draftPath,reply:put}]:[]),...extra]);
  const ui=render(<Draft chapterId={A} onEditorReady={ready} onLockChange={lock} onWritten={written}/>);
  const root=ui.container.querySelector<HTMLElement>('[data-surface="draft"]')!;
  const part=(name:string)=>root.querySelector<HTMLElement>('[data-part="'+name+'"]');
  return {...api,...ui,root,part,ready,lock,written,view:()=>ready.mock.calls.at(-1)![0],loaded:()=>waitFor(()=>expect(ready).toHaveBeenCalledTimes(1))};
}
export function splitAt(v:EditorView){act(()=>v.dispatch(v.state.tr.split(v.state.doc.firstChild!.nodeSize+4)));}
export function joinAt(v:EditorView){act(()=>v.dispatch(v.state.tr.join(v.state.doc.firstChild!.nodeSize+v.state.doc.child(1).nodeSize)));}
export function allocate(id=P){return vi.spyOn(globalThis.crypto,"randomUUID").mockReturnValue(id.slice(3) as ReturnType<Crypto["randomUUID"]>);}
export function restoreClock(){if(vi.isFakeTimers())vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();}
