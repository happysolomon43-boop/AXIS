import {expect,test,vi} from "vitest";
import {changeSnapshotLabel} from "../src/api/endpoints";
import {mockApi} from "./helpers";
import {chapterA,named,errorReply} from "./namedCutFixtures";
import {body,undo,removal,restoration,path,uuid} from "./snapshotLabelFixtures";
test("AXB-0109 AC4 exact bodies, strict result and transport errors",async()=>{
 for(const [input,result] of [[body,removal],[undo,restoration]] as const){
  const {calls}=mockApi([{method:"POST",path,reply:{status:200,body:result}}]);
  expect(await changeSnapshotLabel(chapterA.id,named.id,input)).toEqual(result);
  expect(calls).toHaveLength(1);expect(calls[0].body).toEqual(input);expect(calls[0].headers.get("Content-Type")).toBe("application/json");
 }
 const invalid=[{...removal,extra:1},{...removal,chapter_id:"wrong"},{...removal,version_id:"wrong"},
 ...[{snapshot_id:uuid(99)},{state_token:"bad"},{state_token:body.expected_token},{previous_token:uuid(99)},{extra:1}].map(x=>({...removal,snapshot_lifecycle:{...removal.snapshot_lifecycle,...x}})),
 {...removal,snapshot:restoration.snapshot},{...removal,can_name_snapshot:null}];
 for(const response of invalid){const {calls}=mockApi([{method:"POST",path,reply:{status:200,body:response}}]);expect(await changeSnapshotLabel(chapterA.id,named.id,body)).toBeNull();expect(calls).toHaveLength(1);}
 for(const patch of [{name:"wrong"},{created_at:"2026-02-30T00:00:00.000Z"},{extra:1},{l_seq:0},{pack_pins:{bad:1}}]){
  mockApi([{method:"POST",path,reply:{status:200,body:{...restoration,snapshot:{...restoration.snapshot,...patch}}}}]);expect(await changeSnapshotLabel(chapterA.id,named.id,undo)).toBeNull();
 }
 const encoded="/api/chapters/ch%2Fa/versions/ver%2Fb/snapshot-label";
 const {calls}=mockApi([{method:"POST",path:encoded,reply:{status:200,body:{...removal,chapter_id:"ch/a",version_id:"ver/b"}}}]);expect(await changeSnapshotLabel("ch/a","ver/b",body)).not.toBeNull();expect(calls).toHaveLength(1);
 for(const [status,code] of [[400,"validation_failed"],[401,"auth_required"],[404,"not_found"],[409,"snapshot_conflict"],[413,"payload_too_large"],[415,"unsupported_media_type"],[500,"internal"]] as const){
  mockApi([{method:"POST",path,reply:errorReply(status,code)}]);await expect(changeSnapshotLabel(chapterA.id,named.id,body)).rejects.toMatchObject({status,code,details:null});
 }
 mockApi([{method:"POST",path,reply:"network"}]);await expect(changeSnapshotLabel(chapterA.id,named.id,body)).rejects.toMatchObject({status:0,code:"network"});
 vi.stubGlobal("fetch",vi.fn(async()=>new Response("not JSON",{status:200})));await expect(changeSnapshotLabel(chapterA.id,named.id,body)).rejects.toMatchObject({status:200,code:"unreadable"});
});
