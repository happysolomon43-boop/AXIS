import { expect, test } from "vitest";
import { getWorkingState } from "../src/api/endpoints";
import { mockApi } from "./helpers";
import { equal, changed, uid } from "./paragraphIdentityFixtures";
import { A, chapterPath } from "./d18Fixtures";
test("AXB-0139 AC1 validates canonical coherent hints and rejects malformed successful reads",async()=>{
 for(const fixture of [equal,changed]){
  const api=mockApi([{method:"GET",path:chapterPath+"/working-state",reply:{status:200,body:fixture}}]);
  expect(await getWorkingState(A)).toEqual(fixture);expect(api.calls).toHaveLength(1);
 }
 const edits:Array<(f:typeof equal)=>void>=[
  f=>{delete (f.draft!.blocks[1] as Partial<import("../src/api/types").WorkingDraftBlock>).block_uid;},
  f=>{Object.assign(f.draft!.blocks[1],{block_uid:7});},
  f=>{f.draft!.blocks[1].block_uid="local_p_1";},
  f=>{f.draft!.blocks[2].block_uid=uid(2);},
  f=>{f.draft!.blocks[0].block_uid=uid(1);},
  f=>{f.draft!.blocks[1].block_uid=uid(6);},
  f=>{f.draft!.blocks[1].block_uid=uid(90);},
  f=>{f.draft!.blocks[1].block_uid=null;},
  f=>{f.draft!.blocks[2].block_uid=uid(4);},
  f=>{f.blocks[1].block_uid=f.blocks[0].block_uid;},
 ];
 for(const edit of edits){
  const f=structuredClone(equal);edit(f);
  const api=mockApi([{method:"GET",path:chapterPath+"/working-state",reply:{status:200,body:f}}]);
  await expect(getWorkingState(A)).rejects.toMatchObject({status:200,code:"unreadable",details:null});expect(api.calls).toHaveLength(1);
 }
 const ambiguous=structuredClone(changed);ambiguous.draft!.blocks[2].block_uid=uid(3);
 mockApi([{method:"GET",path:chapterPath+"/working-state",reply:{status:200,body:ambiguous}}]);
 await expect(getWorkingState(A)).rejects.toMatchObject({status:200,code:"unreadable",details:null});
});
