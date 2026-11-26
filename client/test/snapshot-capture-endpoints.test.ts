import { expect,test,vi } from "vitest";
import { captureSnapshot,getSnapshotCapture } from "../src/api/endpoints";
import type { CaptureResult,CaptureRequest } from "../src/api/types";
import { ApiError } from "../src/api/http";
import { mockApi } from "./helpers";
import { eligible,snapshot,chapterA,errorReply } from "./namedCutFixtures";
const id=chapterA.id;
const request_id="12345678-1234-4abc-8def-123456789abc";
const base="ver_000000000009";
const body:CaptureRequest={request_id,content:"Captured text.",base_version:base,base_revision:1};
const version={id:eligible.id,chapter_id:id,source:"draft_edit",version_no:2,parent_version:base,l_seq:eligible.l_seq,text_hash:"a".repeat(64),hints_hash:"b".repeat(64)};
const capture:CaptureResult={request_id,version,snapshot:snapshot(eligible),created_version:true,draft_current:true,active_version_id:null,sync:{state:"draft_only",same:false}};
const postPath="/api/chapters/"+id+"/snapshots";
const getPath=postPath+"/"+request_id;
test("AXB-0101 AC3 exact POST and GET request, no body on GET and no retries",async()=>{
  for(const status of [201,200]) {
    const {calls}=mockApi([{method:"POST",path:postPath,reply:{status,body:{capture}}}]);
    expect(await captureSnapshot(id,body)).toEqual(capture);expect(calls).toHaveLength(1);expect(calls[0].body).toEqual(body);
    expect(calls[0].headers.get("X-Axis-User")).toBe("usr_alice");expect(calls[0].headers.get("Content-Type")).toBe("application/json");
  }
  const {calls}=mockApi([{method:"GET",path:getPath,reply:{status:200,body:{capture}}},{method:"POST",path:postPath,reply:{status:201,body:{capture}}}]);
  expect(await getSnapshotCapture(id,request_id)).toEqual(capture);
  expect(await captureSnapshot(id,{...body,name:"Name"})).toEqual(capture);
  expect(calls[0].headers.has("Content-Type")).toBe(false);expect(calls[1].body).toEqual({...body,name:"Name"});
  const encoded=mockApi([{method:"GET",path:"/api/chapters/ch%2Ftest/snapshots/id%2Ftest",reply:{status:200,body:{capture:null}}}]);
  expect(await getSnapshotCapture("ch/test","id/test")).toBeNull();expect(encoded.calls).toHaveLength(1);
});
test("AXB-0101 AC4 strict tuple and error transport",async()=>{
  const {draft_current:_,...missing}=capture;
  const invalid=[null,{capture:null},{capture,extra:true},{capture:missing},...[{request_id:"other"},{snapshot:{...capture.snapshot,l_seq:100}},{version:{...version,chapter_id:"other"}},{version:{...version,parent_version:"ver_000000000008"}},{version:{...version,hints_hash:"X"}},{version:{...version,source:"other"}},{snapshot:{...capture.snapshot,created_at:"2026-02-30T00:00:00.000Z"}},{sync:{state:"edited",same:true}},{sync:{state:"draft_only",same:false,extra:1}},{active_version_id:"wrong"},{created_version:"true"}].map(c=>({capture:{...capture,...c}}))];
  for(const reply of invalid) {
    const {calls}=mockApi([{method:"POST",path:postPath,reply:{status:201,body:reply}}]);
    expect(await captureSnapshot(id,body)).toBeNull();expect(calls).toHaveLength(1);
  }
  for(const [status,code,details] of [[400,"validation_failed",{errors:[{path:"/name",message:"invalid"}]}],[409,"snapshot_conflict",{reason:"name_exists"}],[500,"internal",null]] as const) {
    const {calls}=mockApi([{method:"POST",path:postPath,reply:errorReply(status,code,details)}]);
    const result=captureSnapshot(id,body);await expect(result).rejects.toBeInstanceOf(ApiError);await expect(result).rejects.toMatchObject({status,code,details});expect(calls).toHaveLength(1);
  }
  const {calls}=mockApi([{method:"GET",path:getPath,reply:"network"}]);await expect(getSnapshotCapture(id,request_id)).rejects.toMatchObject({status:0,code:"network",details:null});expect(calls).toHaveLength(1);
  const fetch=vi.fn(async()=>new Response("not JSON",{status:200}));vi.stubGlobal("fetch",fetch);
  await expect(getSnapshotCapture(id,request_id)).rejects.toMatchObject({status:200,code:"unreadable",details:null});expect(fetch).toHaveBeenCalledTimes(1);
});
