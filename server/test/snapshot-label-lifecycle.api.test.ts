import {randomUUID} from "node:crypto";
import {afterAll,afterEach,beforeEach,expect,test} from "vitest";
import {makePool,resetDb} from "./helpers.js";
import {alice,bob,fixture,labels,state} from "./namedCutsFixtures.js";
import {seedSeries} from "./seed.js";
const pool=makePool();
let f:Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{await resetDb(pool);f=await fixture(pool);});
afterEach(async()=>{await f.app.close();await resetDb(pool);});afterAll(()=>pool.end());
const path=(id:string,v:string)=>"/chapters/"+id+"/versions/"+v+"/snapshot-label";
const post=(id:string,v:string,payload:object|string,headers:Record<string,string>=alice)=>f.app.inject({method:"POST",url:path(id,v),headers,payload});
const row=async(id:string,v:string)=>(await f.history(id)).json().versions.find((x:{id:string})=>x.id===v);
const removedError={error:{code:"snapshot_conflict",message:"Snapshot name was removed",details:{reason:"snapshot_removed"}}};
const changedError={error:{code:"snapshot_conflict",message:"Snapshot name changed",details:{reason:"snapshot_changed"}}};
async function named(){
 const first=await f.create(),id=first.chapter.id,a=await f.write(id,"The gate shut.","send"),b=await f.write(id,"The bell rang.");
 expect((await f.name(id,b.version.id,"Before the bell")).statusCode).toBe(201);
 expect((await f.head(id,b.version.id,"The bell rang again.")).statusCode).toBe(200);
 const v=b.version.id,h=await row(id,v);
 return {id,v,a,b,h,remove:{action:"remove",snapshot_id:h.snapshot_lifecycle.snapshot_id,expected_token:h.snapshot_lifecycle.state_token}};
}
test("AXB-0107 AC1/3/5 and AXB-0108 AC1: exact removal, concurrent replay, undo, late tokens and replacement",async()=>{
 const {id,v,a,h,remove}=await named(),before=await state(pool);
 await pool.query("UPDATE named_cuts SET created_at='2026-11-16T23:30:00.123456Z' WHERE chapter_id=$1 AND version_id=$2",[id,v]);
 const saved=await row(id,v),stamp=(await pool.query("SELECT created_at::text AS t FROM named_cuts")).rows[0].t;
 const both=await Promise.all([post(id,v,remove),post(id,v,remove)]);
 expect(both.map(r=>r.statusCode)).toEqual([200,200]);expect(both[0].headers["cache-control"]).toBe("no-store");
 const result=both[0].json();expect(both[1].json()).toEqual(result);
 expect(result).toEqual({chapter_id:id,version_id:v,snapshot:null,can_name_snapshot:true,snapshot_lifecycle:{snapshot_id:remove.snapshot_id,state_token:expect.any(String),previous_token:remove.expected_token}});
 expect(result.snapshot_lifecycle.state_token).not.toBe(remove.expected_token);
 expect(await row(id,v)).toEqual({...saved,snapshot:null,snapshot_lifecycle:result.snapshot_lifecycle,can_name_snapshot:true});
 expect((await f.history(id)).json().active_version_id).toBe(a.version.id);
 expect(await labels(pool)).toEqual([]);expect(await state(pool)).toEqual(before);
 const undo={action:"undo",snapshot_id:remove.snapshot_id,expected_token:result.snapshot_lifecycle.state_token,name:"Before the bell"};
 expect((await post(id,v,{...undo,name:"Wrong"})).json()).toEqual(changedError);
 const restored=await post(id,v,undo);expect(restored.statusCode,restored.body).toBe(200);
 expect(restored.json()).toEqual({chapter_id:id,version_id:v,snapshot:saved.snapshot,can_name_snapshot:false,snapshot_lifecycle:{snapshot_id:remove.snapshot_id,state_token:expect.any(String),previous_token:undo.expected_token}});
 expect((await post(id,v,undo)).json()).toEqual(restored.json());
 expect((await pool.query("SELECT created_at::text AS t FROM named_cuts")).rows[0].t).toBe(stamp);
 expect((await post(id,v,remove)).json()).toEqual(changedError);
 const again=await post(id,v,{...remove,expected_token:restored.json().snapshot_lifecycle.state_token});expect(again.statusCode).toBe(200);
 expect((await f.name(id,v,"Before the bell")).statusCode).toBe(201);
 expect((await row(id,v)).snapshot_lifecycle.snapshot_id).not.toBe(remove.snapshot_id);
 expect((await post(id,v,undo)).json()).toEqual(changedError);expect((await post(id,v,remove)).json()).toEqual(changedError);
 expect(await state(pool)).toEqual(before);expect((await row(id,a.version.id)).snapshot_lifecycle).toBeNull();
});
test("AXB-0107 AC2: scope, body, canonical names, limits and released labels",async()=>{
 const {id,v,remove}=await named();const other=await f.create(),foreign=await seedSeries(pool,"usr_bob");
 const created=await f.app.inject({method:"POST",url:"/books/"+foreign.bookId+"/chapters",headers:bob,payload:{content:"Private"}});
 const outside=created.json();const before=await state(pool),names=await labels(pool);
 for(const [ch,ver,headers,status,message] of [[id,v,{},401,"Missing or invalid X-Axis-User header"],[id,v,bob,404,"Chapter not found"],[outside.chapter.id,outside.version.id,alice,404,"Chapter not found"],["unknown",v,alice,404,"Chapter not found"],[id,other.version.id,alice,404,"Version not found"],[id,"x".repeat(65),alice,404,"Version not found"],[id,"x".repeat(101),alice,404,"Route not found"],["%00",v,alice,404,"Chapter not found"]] as const){
  const r=await post(ch,ver,remove,headers);expect(r.statusCode,r.body).toBe(status);expect(r.json().error.message).toBe(message);
 }
 for(const payload of [{...remove,extra:1},{...remove,name:"x"},{...remove,snapshot_id:null},{...remove,expected_token:"bad"},{...remove,action:"undo"},{...remove,action:"undo",name:null}])expect((await post(id,v,payload)).statusCode).toBe(400);
 for(const name of [""," unnormalized ","a  b","\u0000","\ud800","x".repeat(201)])expect((await post(id,v,{...remove,action:"undo",name})).statusCode).toBe(400);
 expect((await post(id,v,JSON.stringify({...remove,action:"undo",name:"x".repeat(1048576)}),{...alice,"content-type":"application/json"})).statusCode).toBe(413);
 expect((await post(id,v,"x",{...alice,"content-type":"text/plain"})).statusCode).toBe(415);
 expect((await post(other.chapter.id,other.version.id,remove)).json()).toEqual(changedError);
 expect(await state(pool)).toEqual(before);expect(await labels(pool)).toEqual(names);
 await pool.query("UPDATE books SET status='released' WHERE id=$1",[f.bookId]);
 const removed=await post(id,v,remove);expect(removed.statusCode).toBe(200);expect(removed.json().can_name_snapshot).toBe(false);
 const restored=await post(id,v,{action:"undo",snapshot_id:remove.snapshot_id,expected_token:removed.json().snapshot_lifecycle.state_token,name:"Before the bell"});expect(restored.statusCode).toBe(200);
 expect(await state(pool)).toEqual(before);
},20000);
test("AXB-0107 AC4/5: both D14 receipt producers bind to original label only",async()=>{
 const first=await f.create(),id=first.chapter.id,a=await f.write(id,"The gate shut.","send");
 const snapshotPath="/chapters/"+id+"/snapshots";
 const capture=(payload:object)=>f.app.inject({method:"POST",url:snapshotPath,headers:alice,payload});
 const read=(requestId:string)=>f.app.inject({method:"GET",url:snapshotPath+"/"+requestId,headers:alice});
 const bBody={request_id:randomUUID(),content:"The bell rang.",base_version:a.version.id,base_revision:0,name:"Before the bell"};
 const b=await capture(bBody);expect(b.statusCode,b.body).toBe(201);
 const aBody={request_id:randomUUID(),content:"The gate shut.",base_version:b.json().capture.version.id,base_revision:0,name:"Gate"};
 const ar=await capture(aBody);expect(ar.statusCode,ar.body).toBe(201);
 for(const [input,reply,eligible] of [[bBody,b,true],[aBody,ar,false]] as const){
  const original=reply.json().capture,v=original.version.id,h=await row(id,v);
  const receipts=(await pool.query("SELECT * FROM snapshot_capture_requests ORDER BY request_id")).rows;
  const before=await state(pool),body={action:"remove",snapshot_id:h.snapshot_lifecycle.snapshot_id,expected_token:h.snapshot_lifecycle.state_token};
  const removal=await post(id,v,body);expect(removal.statusCode,removal.body).toBe(200);expect(removal.json().can_name_snapshot).toBe(eligible);
  expect((await read(input.request_id)).json()).toEqual(removedError);expect((await capture(input)).json()).toEqual(removedError);
  expect((await capture({...input,content:"Mismatch"})).json().error.details).toEqual({reason:"request_mismatch"});
  expect((await read(randomUUID())).json()).toEqual({capture:null});
  const undo=await post(id,v,{action:"undo",snapshot_id:body.snapshot_id,expected_token:removal.json().snapshot_lifecycle.state_token,name:original.snapshot.name});expect(undo.statusCode,undo.body).toBe(200);
  expect((await read(input.request_id)).json().capture.snapshot).toEqual(original.snapshot);expect((await capture(input)).statusCode).toBe(200);
  expect((await pool.query("SELECT * FROM snapshot_capture_requests ORDER BY request_id")).rows).toEqual(receipts);expect(await state(pool)).toEqual(before);
  if(eligible){expect((await post(id,v,{...body,expected_token:undo.json().snapshot_lifecycle.state_token})).statusCode).toBe(200);expect((await f.name(id,v,original.snapshot.name)).statusCode).toBe(201);expect((await read(input.request_id)).json()).toEqual(removedError);}
 }
});
