import {expect,test} from "vitest";
import {EditorState,TextSelection,type Transaction} from "prosemirror-state";
import {history,undo,redo,closeHistory,undoDepth} from "prosemirror-history";
import {Step,ReplaceStep} from "prosemirror-transform";
import {Fragment,Slice} from "prosemirror-model";
import {createParagraphIdentity,ParagraphAllocationError} from "../src/editor/paragraphIdentity";
import {blocksToDoc,docToEditorDocument,editorDocumentToDoc,schema} from "../src/editor/model";
import {canonicalLineage,lineageMap,normalizeLineage,reduceLineage,sameLineage,ParagraphLineageStep} from "../src/editor/paragraphLineage";
import type {EditorDocument,ParagraphLineageRecord} from "../src/api/types";
const O="b_000000000002",U="b_000000000003",C="b_000000000004",D="b_000000000005";
const P="dp_00000000-0000-4000-8000-000000000001",Q="dp_00000000-0000-4000-8000-000000000002";
const heading={kind:"heading",text:"North",paragraph_id:null} as const;
const para=(text:string,paragraph_id:string)=>({kind:"paragraph" as const,text,paragraph_id});
const base:EditorDocument=[heading,para("River.",O)];
const split=(old_id=O,new_id=P)=>({kind:"split" as const,old_id,new_id});
const merge=(old_id=P,new_id=O)=>({kind:"merge" as const,old_id,new_id});
function mount(doc:EditorDocument=base,ids=[P,Q],restoredLineage:readonly ParagraphLineageRecord[]=[]){
  const hp=history(),allocateUuid=()=>ids.shift()!.slice(3);
  const instance=createParagraphIdentity({mode:"draft",allocateUuid,restoredParagraphIds:doc.map(r=>r.paragraph_id),restoredLineage,isHistoryReplay:tr=>tr.getMeta(hp)!==undefined});
  let state=EditorState.create({doc:instance.initialize(editorDocumentToDoc(doc)),plugins:[hp,instance.plugin]});
  const apply=(tr:Transaction)=>{state=state.apply(tr);};
  return {get state(){return state},apply,read:()=>instance.lineage(state),undo:()=>undo(state,apply),redo:()=>redo(state,apply)};
}
const H=editorDocumentToDoc(base).firstChild!.nodeSize;
const at=(s:EditorState,index:number)=>{let pos=0;for(let i=0;i<index;i++)pos+=s.doc.child(i).nodeSize;return pos;};
function check(f:ReturnType<typeof mount>,doc:EditorDocument,records:ParagraphLineageRecord[]){
  expect(docToEditorDocument(f.state.doc)).toEqual(doc);expect(f.read()).toEqual(records);
}
test("AC3 native split, join and second split share one event each with exact inverse/forward lineage",()=>{
  const f=mount();
  const d1=[heading,para("Riv",O),para("er.",P)],d2=base,d3=[heading,para("Riv",O),para("er.",Q)];
  f.apply(closeHistory(f.state.tr.split(H+4)));check(f,d1,[split()]);expect(undoDepth(f.state)).toBe(1);
  f.apply(closeHistory(f.state.tr.join(at(f.state,2))));check(f,d2,[merge()]);expect(undoDepth(f.state)).toBe(2);
  f.apply(closeHistory(f.state.tr.split(H+4)));check(f,d3,[merge(),split(O,Q)]);expect(undoDepth(f.state)).toBe(3);
  expect(f.undo()).toBe(true);check(f,d2,[merge()]);
  expect(f.undo()).toBe(true);check(f,d1,[split()]);
  expect(f.undo()).toBe(true);check(f,base,[]);expect(f.undo()).toBe(false);
  expect(f.redo()).toBe(true);check(f,d1,[split()]);
  expect(f.redo()).toBe(true);check(f,d2,[merge()]);
  expect(f.redo()).toBe(true);check(f,d3,[merge(),split(O,Q)]);
});
test("AC3 undo/redo cannot remove unrelated later non-history writer lineage",()=>{
  const f=mount([...base,para("Brook.",U)]);
  f.apply(closeHistory(f.state.tr.split(H+4)));
  f.apply(f.state.tr.split(at(f.state,3)+4).setMeta("addToHistory",false));
  const both=[heading,para("Riv",O),para("er.",P),para("Bro",U),para("ok.",Q)];
  check(f,both,[split(),split(U,Q)]);
  expect(f.undo()).toBe(true);check(f,[...base,para("Bro",U),para("ok.",Q)],[split(U,Q)]);
  expect(f.undo()).toBe(false);
  expect(f.redo()).toBe(true);check(f,both,[split(),split(U,Q)]);
});
test("AC4 structural empty participants and empty split, not lookalike edits",()=>{
  for(const texts of [["","River."],["River.",""]]){
    const f=mount([para(texts[0]!,O),para(texts[1]!,P)]);
    f.apply(f.state.tr.join(at(f.state,1)));check(f,[para("River.",O)],[merge()]);
  }
  const empty=mount([para("",O)]);
  empty.apply(empty.state.tr.split(1));check(empty,[para("",O),para("",P)],[split()]);
  const deleted=mount([para("River.",O),para("",P)]);
  deleted.apply(deleted.state.tr.delete(at(deleted.state,1),deleted.state.doc.content.size));
  check(deleted,[para("River.",O)],[]);
  for(const edit of [
    (f:ReturnType<typeof mount>)=>f.state.tr.insert(f.state.doc.content.size,f.state.doc.lastChild!),
    (f:ReturnType<typeof mount>)=>f.state.tr.insert(H,f.state.doc.lastChild!),
    (f:ReturnType<typeof mount>)=>f.state.tr.delete(H,f.state.doc.content.size).insert(0,f.state.doc.lastChild!),
    (f:ReturnType<typeof mount>)=>f.state.tr.insertText("a",H+1),
    (f:ReturnType<typeof mount>)=>f.state.tr.step(new ReplaceStep(H,f.state.doc.content.size,new Slice(Fragment.fromArray([schema.nodes.paragraph.create({block_uid:O},schema.text("Riv")),schema.nodes.paragraph.create({block_uid:O},schema.text("er."))]),0,0))),
  ]){
    const f=mount();f.apply(edit(f));expect(f.read()).toEqual([]);
  }
  const f=mount();f.apply(f.state.tr.split(H+4));
  f.apply(f.state.tr.delete(at(f.state,2),f.state.doc.content.size));expect(f.read()).toEqual([]);
});
test("AC5 restored aliases flatten; missing targets and cycles drop; guarded inverse retains later value",()=>{
  const f=mount([para("North.",C),para("River.",O)],[Q],[merge()]);
  expect(f.read()).toEqual([merge()]);
  f.apply(f.state.tr.join(at(f.state,1)));check(f,[para("North.River.",C)],[merge(O,C),merge(P,C)]);
  const invalid=lineageMap([merge(P,Q),merge(Q,P),merge(O,D)]);
  expect(canonicalLineage(normalizeLineage(invalid,new Set([C])))).toEqual([]);
  const before=lineageMap([merge(P,D)]);
  const next=reduceLineage(before,[{kind:"merge",key_id:P,before:merge(P,C),after:merge(P,O)}]);
  expect(canonicalLineage(normalizeLineage(next,new Set([D])))).toEqual([merge(P,D)]);
  expect(sameLineage([],null)).toBe(true);
  const step=new ParagraphLineageStep([{kind:"merge",key_id:P,before:null,after:merge()}]);
  expect(Step.fromJSON(schema,step.toJSON()).toJSON()).toEqual(step.toJSON());
  expect(step.invert().invert().toJSON()).toEqual(step.toJSON());
  const a=f.read();a[0]!.new_id=D;expect(f.read()).toEqual([merge(O,C),merge(P,C)]);
});
test("AC5 malformed allocation and lineage overflow refuse atomically",()=>{
  const f=mount(base,["bad"]);const before=f.state;
  expect(()=>f.apply(f.state.tr.split(H+4))).toThrow(ParagraphAllocationError);
  expect(f.state).toBe(before);expect(undoDepth(f.state)).toBe(0);expect(f.read()).toEqual([]);
  const records=Array.from({length:1_000_000},(_,i)=>merge("dp_00000000-0000-4000-8000-"+(i+16).toString(16).padStart(12,"0"),O));
  const big=mount([para("Riv",O),para("er.",P)],[],records), prior=big.state;
  expect(()=>big.apply(big.state.tr.join(at(big.state,1)))).toThrow(ParagraphAllocationError);
  expect(big.state).toBe(prior);expect(undoDepth(big.state)).toBe(0);expect(big.read().length).toBe(1_000_000);
  const legacy=createParagraphIdentity();
  const state=EditorState.create({doc:legacy.initialize(blocksToDoc([])),plugins:[legacy.plugin]});
  expect(state.doc.firstChild!.attrs.block_uid).toBe("local_p_1");expect(legacy.lineage(state)).toEqual([]);
},60000);
