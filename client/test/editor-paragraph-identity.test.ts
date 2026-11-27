import { expect, test } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { history, closeHistory, undo, redo } from "prosemirror-history";
import { createParagraphIdentity } from "../src/editor/paragraphIdentity";
import { blocksToDoc, sameContentDoc, type EditorBlock } from "../src/editor/model";
import { uid } from "./paragraphIdentityFixtures";
const p=(text:string,block_uid:string|null=null):EditorBlock=>({kind:"paragraph",text,block_uid});
const ids=(s:EditorState)=>{const result:string[]=[];s.doc.forEach(n=>{if(n.type.name==="paragraph")result.push(n.attrs.block_uid)});return result;};
const mount=(blocks:EditorBlock[])=>{const identity=createParagraphIdentity();return EditorState.create({doc:identity.initialize(blocksToDoc(blocks)),plugins:[history(),identity.plugin]});};
test("AXB-0140 AC1 initialization, deletion and monotonic allocation",()=>{
 let s=mount([p("one",uid(2)),p("two"),p("three",uid(2)),{kind:"heading",text:"H"}]);
 expect(ids(s)).toEqual([uid(2),"local_p_1","local_p_2"]);
 expect(s.doc.lastChild!.attrs).not.toHaveProperty("block_uid");
 expect(ids(mount([]))).toEqual(["local_p_1"]);
 s=s.apply(s.tr.delete(s.doc.child(0).nodeSize,s.doc.child(0).nodeSize+s.doc.child(1).nodeSize));
 s=s.apply(s.tr.insert(0,blocksToDoc([p("new")]).firstChild!));
 expect(ids(s)).toEqual(["local_p_3",uid(2),"local_p_2"]);
});
test("AXB-0140 AC2 real split at beginning/middle/end, edit and join",()=>{
 for(const pos of [1,3,7]){
  let s=mount([p("River.",uid(2))]);
  const split=s.tr.split(pos);s=s.apply(split);
  expect(ids(s)).toEqual([uid(2),"local_p_1"]);expect(s.doc.textContent).toBe("River.");
  s=s.apply(s.tr.join(s.doc.firstChild!.nodeSize));expect(ids(s)).toEqual([uid(2)]);expect(s.doc.textContent).toBe("River.");
 }
 let s=mount([p("River.",uid(2))]);s=s.apply(s.tr.insertText("!",7));expect(ids(s)).toEqual([uid(2)]);
});
test("AXB-0140 AC3/5 duplicate and move keep mapped original, selection and content",()=>{
 for(const before of [true,false]){
  let s=mount([p("a",uid(2)),p("b",uid(3))]);
  const tr=s.tr.insert(before?0:s.doc.firstChild!.nodeSize,s.doc.firstChild!);
  tr.setSelection(TextSelection.atEnd(tr.doc));
  const result=s.applyTransaction(tr);
  expect(ids(result.state)).toEqual(before?["local_p_1",uid(2),uid(3)]:[uid(2),"local_p_1",uid(3)]);
  expect(sameContentDoc(tr.doc,result.state.doc)).toBe(true);expect(result.state.selection.eq(tr.selection)).toBe(true);
  expect(result.state.applyTransaction(result.state.tr.setSelection(TextSelection.atStart(result.state.doc))).transactions).toHaveLength(1);
 }
 let s=mount([p("a",uid(2)),p("b",uid(3))]);const first=s.doc.firstChild!;
 const tr=s.tr.delete(0,first.nodeSize);tr.insert(tr.doc.content.size,first);s=s.apply(tr);expect(ids(s)).toEqual([uid(3),uid(2)]);
});
test("AXB-0140 AC4 history restores exact local IDs in one event and never reuses them",()=>{
 let s=mount([p("River.",uid(2))]);const initial=s.doc;
 s=s.apply(s.tr.split(3));const split=s.doc;expect(ids(s)).toEqual([uid(2),"local_p_1"]);
 s=s.apply(closeHistory(s.tr.insert(0,s.doc.firstChild!)));const copy=s.doc;expect(ids(s)).toEqual(["local_p_2",uid(2),"local_p_1"]);
 const dispatch=(tr:Parameters<EditorState["apply"]>[0])=>{s=s.apply(tr)};
 expect(undo(s,dispatch)).toBe(true);expect(s.doc.eq(split)).toBe(true);expect(undo(s,dispatch)).toBe(true);expect(s.doc.eq(initial)).toBe(true);
 expect(redo(s,dispatch)).toBe(true);expect(s.doc.eq(split)).toBe(true);expect(redo(s,dispatch)).toBe(true);expect(s.doc.eq(copy)).toBe(true);
 expect(undo(s,dispatch)).toBe(true);s=s.apply(closeHistory(s.tr.insert(0,blocksToDoc([p("New")]).firstChild!)));expect(ids(s)[0]).toBe("local_p_3");
});
