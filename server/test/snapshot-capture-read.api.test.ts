import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { makePool, resetDb } from "./helpers.js";
import { fixture, labels, state, alice, bob } from "./namedCutsFixtures.js";
import type { CaptureResult } from "../src/named-cuts/capture.js";
const pool=makePool();
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{await resetDb(pool);f=await fixture(pool);});
afterEach(async()=>{await f.app.close();await resetDb(pool);});
afterAll(()=>pool.end());
const path=(id:string,requestId:string)=>"/chapters/"+id+"/snapshots/"+requestId;
const read=(id:string,requestId:string,headers:Record<string,string>=alice)=>f.app.inject({method:"GET",url:path(id,requestId),headers});
async function committed() {
  const a=await f.create(),id=a.chapter.id,request_id=randomUUID();
  const r=await f.app.inject({method:"POST",url:"/chapters/"+id+"/snapshots",headers:alice,payload:{request_id,content:"Captured text.",base_version:a.version.id,base_revision:0}});
  expect(r.statusCode,r.body).toBe(201);
  return {id,request_id,capture:r.json<{capture:CaptureResult}>().capture};
}
const receipts=async()=>(await pool.query("SELECT * FROM snapshot_capture_requests ORDER BY chapter_id,request_id")).rows;
test("AXB-0101 AC1 readback is scoped, immutable capture with live coordinates and no mutation",async()=>{
  const {id,request_id,capture}=await committed();
  const sent=await f.write(id,"Later version.","send");
  expect((await f.head(id,sent.version.id,"Later head.")).statusCode).toBe(200);
  const other=await f.create();
  const before=await state(pool),named=await labels(pool),stored=await receipts();
  const r=await read(id,request_id);
  expect(r.statusCode,r.body).toBe(200);expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.json()).toEqual({capture:{...capture,draft_current:false,active_version_id:sent.version.id,sync:{state:"edited",same:false}}});
  for(const [chapter,request] of [[id,randomUUID()],[other.chapter.id,request_id]]) {
    const missing=await read(chapter!,request!);expect(missing.statusCode).toBe(200);expect(missing.headers["cache-control"]).toBe("no-store");expect(missing.json()).toEqual({capture:null});
  }
  expect(await state(pool)).toEqual(before);expect(await labels(pool)).toEqual(named);expect(await receipts()).toEqual(stored);
});
test("AXB-0101 AC2 identity, chapter scope, UUID, route limit, and failed read",async()=>{
  const {id,request_id}=await committed();
  for(const [chapter,request,headers,status,message] of [[id,request_id,bob,404,"Chapter not found"],[id,request_id,{},401,"Missing or invalid X-Axis-User header"],["ch_000000000000",request_id,alice,404,"Chapter not found"],[id,"bad",alice,400,"Request validation failed"],[id,"x".repeat(101),alice,404,"Route not found"],["x".repeat(101),request_id,alice,404,"Route not found"],["%00","bad",alice,404,"Chapter not found"]] as const) {
    const r=await read(chapter,request,headers);expect(r.statusCode,r.body).toBe(status);expect(r.json().error.message).toBe(message);
    if(status===400)expect(r.json().error.details).toEqual({errors:[{path:"/requestId",message:"must be a lowercase UUID v4"}]});
  }
  const before=await state(pool);
  const proxy={async connect(){const c=await pool.connect();return {release:c.release.bind(c),query:async(sql:string,params?:unknown[])=>{
    if(sql.includes("SELECT * FROM snapshot_capture_requests"))throw new Error("private data");
    return c.query(sql,params);
  }} as unknown as PoolClient;}};
  const bad=buildApp({pool:proxy as unknown as Pool});
  try {const failed=await bad.inject({method:"GET",url:path(id,request_id),headers:alice});expect(failed.statusCode).toBe(500);expect(failed.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});}
  finally {await bad.close();}
  expect(await state(pool)).toEqual(before);
  await pool.query("DELETE FROM named_cuts WHERE chapter_id=$1",[id]);
  const broken=await read(id,request_id);expect(broken.statusCode).toBe(500);expect(broken.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});
});

test("D15: receipt readback distinguishes deliberate removal from inconsistent live binding",async()=>{
  const {id,request_id,capture}=await committed();
  const v=capture.version.id;
  const row=(await f.history(id)).json().versions.find((item:{id:string})=>item.id===v);
  const url="/chapters/"+id+"/versions/"+v+"/snapshot-label";
  const removed=await f.app.inject({method:"POST",url,headers:alice,payload:{action:"remove",snapshot_id:row.snapshot_lifecycle.snapshot_id,expected_token:row.snapshot_lifecycle.state_token}});
  expect(removed.statusCode).toBe(200);
  const absent=await read(id,request_id);
  expect(absent.statusCode).toBe(409);expect(absent.json()).toEqual({error:{code:"snapshot_conflict",message:"Snapshot name was removed",details:{reason:"snapshot_removed"}}});
  const undo=await f.app.inject({method:"POST",url,headers:alice,payload:{action:"undo",snapshot_id:row.snapshot_lifecycle.snapshot_id,expected_token:removed.json().snapshot_lifecycle.state_token,name:capture.snapshot.name}});
  expect(undo.statusCode).toBe(200);
  expect((await read(id,request_id)).json()).toEqual({capture});
  await pool.query("DELETE FROM snapshot_label_lifecycles WHERE chapter_id=$1 AND version_id=$2",[id,v]);
  const inconsistent=await read(id,request_id);expect(inconsistent.statusCode).toBe(500);expect(inconsistent.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});
});
