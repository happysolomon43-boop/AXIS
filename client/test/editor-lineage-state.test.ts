import {expect,test} from "vitest";
import {getEditorLineageState,getEditorWorkingState,putEditorDraft} from "../src/api/endpoints";
import type {EditorDocument,ParagraphLineageRecord} from "../src/api/types";
import {mockApi} from "./helpers";
import {A,book,V,chapterPath,draftPath,rowA,detail,inBook} from "./d18Fixtures";
import {workingState} from "./writeFixtures";

const O="b_000000000002",P="dp_00000000-0000-4000-8000-000000000001",Q="dp_00000000-0000-4000-8000-000000000002";
const document:EditorDocument=[{kind:"paragraph",text:"Riv",paragraph_id:O},{kind:"paragraph",text:"er.",paragraph_id:P}];
const lineage:ParagraphLineageRecord[]=[{kind:"split",old_id:O,new_id:P}];
const raw="Riv\n\ner.", path=chapterPath+"/working-state?view=editor-lineage";
const oldPath=chapterPath+"/working-state?view=editor-document";
const head={chapter:rowA,draft:{base_version:V,revision:1,content:raw,blocks:[{ordinal:1,kind:"paragraph" as const,text:"Riv"},{ordinal:2,kind:"paragraph" as const,text:"er."}]},sync:inBook};
const old={...workingState(detail,head),editor_document:document},current={...old,paragraph_lineage:lineage};
test("AC1 exact one-request lineage view and unchanged D21 view",async()=>{
  const api=mockApi([{method:"GET",path,reply:{status:200,body:current}},{method:"GET",path:oldPath,reply:{status:200,body:old}}]);
  expect(await getEditorLineageState(A,book)).toEqual(current);
  expect(await getEditorWorkingState(A,book)).toEqual(old);
  expect(api.calls.map(c=>[c.method,c.path,c.body])).toEqual([["GET",path,undefined],["GET",oldPath,undefined]]);
  for(const body of [old,{...current,extra:true},{...current,editor_document:null},{...current,paragraph_lineage:[]},
      {...current,paragraph_lineage:[...lineage,{kind:"merge",old_id:Q,new_id:O}]},
      {...current,paragraph_lineage:[{...lineage[0],new_id:Q}]},
      {...current,paragraph_lineage:[{...lineage[0],extra:true}]},
      {...current,chapter:{...rowA,id:"ch_00000000000b"}}]){
    const api=mockApi([{method:"GET",path,reply:{status:200,body}}]);
    await expect(getEditorLineageState(A,book)).rejects.toMatchObject({status:200,code:"unreadable",details:null});
    expect(api.calls).toHaveLength(1);
  }
  const legacy={...old,editor_document:null,paragraph_lineage:null};
  mockApi([{method:"GET",path,reply:{status:200,body:legacy}}]);
  expect(await getEditorLineageState(A,book)).toEqual(legacy);
  mockApi([{method:"GET",path,reply:{status:201,body:current}}]);
  await expect(getEditorLineageState(A,book)).rejects.toMatchObject({status:201,code:"unreadable",details:null});
});
test("AC2 exact optional PUT key and inherited status/one-request behaviour",async()=>{
  const good={chapter:rowA,base_version:V,revision:1,sync:inBook};
  for(const records of [lineage,undefined,[]]){
    const api=mockApi([{method:"PUT",path:draftPath,reply:{status:200,body:good}}]);
    expect(await putEditorDraft(A,book,raw,V,0,document,records)).toEqual(good);
    expect(api.calls.map(c=>[c.method,c.path,c.body])).toEqual([["PUT",draftPath,{content:raw,base_version:V,base_revision:0,editor_document:document,...(records===undefined?{}:{paragraph_lineage:records})}]]);
  }
  for(const [status,code] of [[201,"unreadable"],[409,"conflict"],[0,"network"]] as const){
    const api=mockApi([{method:"PUT",path:draftPath,reply:status===0?"network":{status,body:status===201?good:{error:{code,message:"Draft is out of date",details:{reason:"revision",current_version:V,current_revision:1}}}}}]);
    await expect(putEditorDraft(A,book,raw,V,0,document,lineage)).rejects.toMatchObject({status,code});
    expect(api.calls).toHaveLength(1);
  }
});
