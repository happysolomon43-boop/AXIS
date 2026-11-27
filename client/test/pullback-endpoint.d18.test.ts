import { expect, test, vi } from "vitest";
import { pullBackChapter } from "../src/api/endpoints";
import { mockApi } from "./helpers";
const id="ch_00000000000a", active="ver_00000000000a";
const good={chapter:{id,book_id:"bk_000000000001",order_key:"0000002000"},active_version_id:active};
test("AXB-0130 AC1 guarded and bodyless calls each dispatch once through both transports",async()=>{
  for(const origin of [undefined,"https://axis.example.test"]){
    vi.stubEnv("VITE_AXIS_SERVICE_ORIGIN",origin);
    const {calls}=mockApi([{method:"POST",path:(origin??"/api")+"/chapters/"+id+"/pull-back",reply:{status:200,body:good}}]);
    expect(await pullBackChapter(id,active)).toEqual(good);
    expect(await pullBackChapter(id)).toEqual(good);
    expect(calls.map(c=>c.body)).toEqual([{expected_active_version_id:active},undefined]);
    expect(calls.map(c=>c.headers.get("content-type"))).toEqual(["application/json",null]);
    expect(calls.every(c=>c.headers.get("x-axis-user")==="usr_alice")).toBe(true);
  }
});
test("AXB-0130 AC2 exact success shape and all error envelopes",async()=>{
  const path="/api/chapters/"+id+"/pull-back";
  for(const body of [null,{...good,extra:1},{...good,chapter:{...good.chapter,extra:1}},{...good,chapter:{...good.chapter,id:"ch_00000000000b"}},{...good,chapter:{...good.chapter,order_key:"123"}},{...good,active_version_id:"ver_00000000000b"}]){
    const {calls}=mockApi([{method:"POST",path,reply:{status:200,body}}]);
    await expect(pullBackChapter(id,active)).rejects.toMatchObject({status:200,code:"unreadable",details:null});
    expect(calls).toHaveLength(1);
  }
  for(const [status,code,details] of [[400,"validation_failed",null],[401,"auth_required",null],[404,"not_found",null],[409,"not_in_book",null],[409,"pull_back_conflict",{reason:"active_changed"}],[409,"pull_back_conflict",{reason:"released_book"}],[409,"pull_back_conflict",{reason:"base_choice_required"}],[413,"payload_too_large",null],[415,"unsupported_media_type",null],[500,"internal",null]] as const){
    const {calls}=mockApi([{method:"POST",path,reply:{status,body:{error:{code,message:"failure",details}}}}]);
    await expect(pullBackChapter(id,active)).rejects.toMatchObject({status,code,details});expect(calls).toHaveLength(1);
  }
});
