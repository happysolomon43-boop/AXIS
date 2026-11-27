import { expect, test, vi } from "vitest";
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

test("coherent hint transport is exactly one HTTPS request, and preexisting errors propagate",async()=>{
 const origin="https://axis.example";
 const resource=chapterPath.replace(/^\/api/,"");
 try {
  vi.stubEnv("VITE_AXIS_SERVICE_ORIGIN",origin);
  const api=mockApi([{method:"GET",path:origin+resource+"/working-state",reply:{status:200,body:equal}}]);
  expect(await getWorkingState(A)).toEqual(equal);
  expect(api.calls.map(c=>[c.method,c.path,c.body])).toEqual([["GET",origin+resource+"/working-state",undefined]]);
  for(const [status,code] of [[401,"auth_required"],[404,"not_found"],[500,"internal"],[0,"network"]] as const){
   const details=null;
   const next=mockApi([{method:"GET",path:origin+resource+"/working-state",reply:status===0?"network":{status,body:{error:{code,message:"fixture",details}}}}]);
   await expect(getWorkingState(A)).rejects.toMatchObject({status,code,details});expect(next.calls).toHaveLength(1);
  }
 }finally{vi.unstubAllEnvs();vi.unstubAllGlobals();}
});
