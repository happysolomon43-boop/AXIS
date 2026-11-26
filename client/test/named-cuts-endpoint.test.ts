import { expect,test,vi } from "vitest";
import { getHistory,nameSnapshot } from "../src/api/endpoints";
import { ApiError } from "../src/api/http";
import { mockApi } from "./helpers";
import { historyPath } from "./historyFixtures";
import { eligible,historyEligible,namePath,seriesId,snapshot,chapterA,errorReply } from "./namedCutFixtures";
const saved=snapshot(eligible);
test("AXB-0094 AC1 exact request, encoded series, no retry and ordinary History GET",async()=>{
  for(const [status,name] of [[201,"Before the bell"],[200,undefined]] as const){
    const {calls}=mockApi([{method:"POST",path:namePath,reply:{status,body:{snapshot:saved}}}]);
    expect(await nameSnapshot(seriesId,chapterA.id,eligible.id,name)).toEqual(saved);
    expect(calls).toHaveLength(1);expect(calls[0].body).toEqual({kind:"snapshot",chapter_id:chapterA.id,version_id:eligible.id,...(name===undefined?{}:{name})});
    expect(calls[0].headers.get("X-Axis-User")).toBe("usr_alice");expect(calls[0].headers.get("Content-Type")).toBe("application/json");
  }
  const {calls}=mockApi([{method:"POST",path:"/api/series/ser%2Ftest/named-cuts",reply:{status:201,body:{snapshot:saved}}},{method:"GET",path:historyPath,reply:{status:200,body:historyEligible}}]);
  expect(await nameSnapshot("ser/test",chapterA.id,eligible.id)).toEqual(saved);
  expect(await getHistory(chapterA.id)).toEqual(historyEligible);
  expect(calls.map(c=>[c.method,c.path])).toEqual([["POST","/api/series/ser%2Ftest/named-cuts"],["GET",historyPath]]);
  expect(calls[1].headers.has("Content-Type")).toBe(false);
});
test("AXB-0094 AC2 exact validation and transport errors",async()=>{
  const {created_at:_,...missing}=saved;
  for(const body of [null,{},[],{snapshot:saved,extra:true},{snapshot:missing},
    ...[{version_id:"wrong"},{chapter_id:"wrong"},{kind:"other"},{name:""},{l_seq:0},{l_seq:1.5},{pack_pins:[]},{pack_pins:{x:1}},{created_at:"2026-11-16T23:30:00Z"},{created_at:"2026-02-30T00:00:00.000Z"},{extra:1}].map(change=>({snapshot:{...saved,...change}}))]){
    const {calls}=mockApi([{method:"POST",path:namePath,reply:{status:200,body}}]);
    expect(await nameSnapshot(seriesId,chapterA.id,eligible.id)).toBeNull();expect(calls).toHaveLength(1);
  }
  for(const [status,code,details] of [[400,"validation_failed",{errors:[{path:"/name",message:"invalid"}]}],[401,"auth_required",null],[404,"not_found",null],[409,"snapshot_conflict",{reason:"name_exists"}],[413,"payload_too_large",null],[415,"unsupported_media_type",null],[500,"internal",null]] as const){
    const {calls}=mockApi([{method:"POST",path:namePath,reply:errorReply(status,code,details)}]);
    const result=nameSnapshot(seriesId,chapterA.id,eligible.id);await expect(result).rejects.toBeInstanceOf(ApiError);await expect(result).rejects.toMatchObject({status,code,details});expect(calls).toHaveLength(1);
  }
  const {calls}=mockApi([{method:"POST",path:namePath,reply:"network"}]);await expect(nameSnapshot(seriesId,chapterA.id,eligible.id)).rejects.toMatchObject({status:0,code:"network",details:null});expect(calls).toHaveLength(1);
  const fetch=vi.fn(async()=>new Response("not JSON",{status:200}));vi.stubGlobal("fetch",fetch);
  await expect(nameSnapshot(seriesId,chapterA.id,eligible.id)).rejects.toMatchObject({status:200,code:"unreadable",details:null});expect(fetch).toHaveBeenCalledTimes(1);
});
