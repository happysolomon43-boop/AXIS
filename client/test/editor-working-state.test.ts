import {expect,test} from "vitest";
import {getEditorWorkingState,getWorkingState,putEditorDraft} from "../src/api/endpoints";
import type {EditorDocument} from "../src/api/types";
import {mockApi} from "./helpers";
import {A,book,V,chapterPath,draftPath,rowA,detail,inBook} from "./d18Fixtures";
import {workingState,workingPath} from "./writeFixtures";
const P="dp_00000000-0000-4000-8000-000000000001";
const Q="dp_00000000-0000-4000-8000-000000000002";
const document:EditorDocument=[{kind:"paragraph",text:"Riv",paragraph_id:P},{kind:"paragraph",text:"er.",paragraph_id:Q}];
const raw="Riv\n\ner.";
const head={chapter:rowA,draft:{base_version:V,revision:1,content:raw,blocks:[{ordinal:1,kind:"paragraph" as const,text:"Riv"},{ordinal:2,kind:"paragraph" as const,text:"er."}]},sync:inBook};
const old=workingState(detail,head), current={...old,editor_document:document};
test("AC1 exact opt-in and unchanged legacy decoder",async()=>{
  const api=mockApi([{method:"GET",path:workingPath(chapterPath),reply:{status:200,body:current}},{method:"GET",path:chapterPath+"/working-state",reply:{status:200,body:old}}]);
  expect(await getEditorWorkingState(A,book)).toEqual(current);
  expect(await getWorkingState(A,book)).toEqual(old);
  expect(api.calls.map(c=>[c.method,c.path,c.body])).toEqual([["GET",workingPath(chapterPath),undefined],["GET",chapterPath+"/working-state",undefined]]);
  for(const value of [old,{...current,extra:1},{...current,editor_document:[{...document[0],paragraph_id:"bad"}]}, {...current,draft:null},{...current,editor_document:[document[0],{...document[1],paragraph_id:P}]}]){
    const next=mockApi([{method:"GET",path:workingPath(chapterPath),reply:{status:200,body:value}}]);
    await expect(getEditorWorkingState(A,book)).rejects.toMatchObject({status:200,code:"unreadable",details:null});
    expect(next.calls).toHaveLength(1);
  }
});
test("AC2 exact guarded acknowledgement and no retry",async()=>{
  const good={chapter:rowA,base_version:V,revision:1,sync:inBook};
  const api=mockApi([{method:"PUT",path:draftPath,reply:{status:200,body:good}}]);
  expect(await putEditorDraft(A,book,raw,V,0,document)).toEqual(good);
  expect(api.calls.map(c=>[c.method,c.path,c.body])).toEqual([["PUT",draftPath,{content:raw,base_version:V,base_revision:0,editor_document:document}]]);
  for(const bad of [{...good,chapter:{...rowA,id:"ch_00000000000b"}},{...good,chapter:{...rowA,book_id:"bk_000000000002"}},{...good,base_version:"ver_00000000000b"},{...good,revision:2},{...good,sync:{state:"in_book",same:false}},{...good,extra:1}]){
    const next=mockApi([{method:"PUT",path:draftPath,reply:{status:200,body:bad}}]);
    await expect(putEditorDraft(A,book,raw,V,0,document)).rejects.toMatchObject({status:200,code:"unreadable",details:null});expect(next.calls).toHaveLength(1);
  }
  for(const [status,code] of [[201,"unreadable"],[409,"conflict"],[0,"network"]] as const){
    const next=mockApi([{method:"PUT",path:draftPath,reply:status===0?"network":{status,body:status===201?good:{error:{code,message:"Draft is out of date",details:{reason:"revision",current_version:V,current_revision:1}}}}}]);
    await expect(putEditorDraft(A,book,raw,V,0,document)).rejects.toMatchObject({status,code});expect(next.calls).toHaveLength(1);
  }
});
