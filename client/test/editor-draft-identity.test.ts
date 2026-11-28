import {expect,test} from "vitest";
import {EditorState,TextSelection} from "prosemirror-state";
import {history,undo,redo,closeHistory,undoDepth} from "prosemirror-history";
import {createParagraphIdentity,ParagraphAllocationError} from "../src/editor/paragraphIdentity";
import {blocksToDoc,docToBlocks,docToEditorDocument,editorDocumentToDoc,serializeBlocks,schema} from "../src/editor/model";
import type {EditorDocument} from "../src/api/types";
const P="dp_00000000-0000-4000-8000-000000000001", Q="dp_00000000-0000-4000-8000-000000000002", R="dp_00000000-0000-4000-8000-000000000003", b="b_000000000002";
const initial:EditorDocument=[{kind:"heading",text:"North",paragraph_id:null},{kind:"paragraph",text:"Riv",paragraph_id:b},{kind:"paragraph",text:"er.",paragraph_id:P}];
const mount=(allocateUuid:()=>string)=>{const instance=createParagraphIdentity({mode:"draft",allocateUuid,restoredParagraphIds:initial.map(x=>x.paragraph_id)});return EditorState.create({doc:instance.initialize(editorDocumentToDoc(initial)),plugins:[history(),instance.plugin]});};
test("AC3 admitted identity, split, join, move, duplicate and native history",()=>{
  const sequence=[Q,R];let s=mount(()=>sequence.shift()!.slice(3));const start=s.doc;
  expect(docToEditorDocument(start)).toEqual(initial);
  const heading=start.child(0).nodeSize, para=start.child(1).nodeSize;
  s=s.apply(s.tr.split(heading+2));const split=s.doc;
  expect(docToEditorDocument(split).map(x=>x.paragraph_id)).toEqual([null,b,Q,P]);
  const dispatch=(tr:Parameters<EditorState["apply"]>[0])=>{s=s.apply(tr)};
  expect(undo(s,dispatch)).toBe(true);expect(s.doc.eq(start)).toBe(true);expect(redo(s,dispatch)).toBe(true);expect(s.doc.eq(split)).toBe(true);
  s=s.apply(closeHistory(s.tr.join(heading+s.doc.child(1).nodeSize)));expect(s.doc.eq(start)).toBe(true);
  const first=s.doc.child(1);s=s.apply(closeHistory(s.tr.delete(heading,heading+para).insert(s.doc.content.size-para,first)));
  expect(docToEditorDocument(s.doc).map(x=>x.paragraph_id)).toEqual([null,P,b]);
  s=s.apply(closeHistory(s.tr.insert(heading,s.doc.lastChild!)));
  expect(docToEditorDocument(s.doc).map(x=>x.paragraph_id)).toEqual([null,R,P,b]);
  for(const text of ["","# North"]){const doc:EditorDocument=[{kind:"paragraph",text,paragraph_id:P}];const n=editorDocumentToDoc(doc);expect(docToEditorDocument(n)).toEqual(doc);expect(serializeBlocks(docToBlocks(n))).toBe(text);}
});
test("AC4 rejects unadmitted identity and duplicate or malformed allocation atomically",()=>{
  let s=mount(()=>Q.slice(3));const external=schema.nodes.paragraph.create({block_uid:R},schema.text("external"));
  s=s.apply(s.tr.insert(0,external));expect(s.doc.firstChild!.attrs.block_uid).toBe(Q);
  for(const allocate of [()=>P.slice(3),()=>"bad"]){
    const prior=mount(allocate), selection=TextSelection.atEnd(prior.doc);
    const before=prior.apply(prior.tr.setSelection(selection)), depth=undoDepth(before);
    expect(()=>before.applyTransaction(before.tr.split(before.doc.content.size-1))).toThrow(ParagraphAllocationError);
    expect(before.selection.eq(selection)).toBe(true);expect(before.doc.eq(editorDocumentToDoc(initial))).toBe(true);expect(undoDepth(before)).toBe(depth);
  }
  expect(createParagraphIdentity().initialize(blocksToDoc([])).firstChild!.attrs.block_uid).toBe("local_p_1");
});
