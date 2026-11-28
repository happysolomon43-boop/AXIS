import { randomUUID, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { makePool, resetDb } from "./helpers.js";
import { alice, fixture, labels, state } from "./namedCutsFixtures.js";
const pool=makePool();
afterAll(()=>pool.end());

test("AXB-0110 AC2: removal rollback preserves the exact name, lifecycle, receipt and manuscript",async()=>{
  await resetDb(pool);
  const f=await fixture(pool);
  try {
    const first=await f.create("The gate shut."),id=first.chapter.id;
    const a=await f.write(id,"The gate shut.","send");
    const capturePath="/chapters/"+id+"/snapshots";
    const captureBody={request_id:randomUUID(),content:"The bell rang.",base_version:a.version.id,base_revision:0,name:"Before the bell"};
    const written=await f.app.inject({method:"POST",url:capturePath,headers:alice,payload:captureBody});
    expect(written.statusCode,written.body).toBe(201);
    const capture=written.json().capture,b=capture.version.id;
    expect(capture.created_version).toBe(true);
    expect((await f.head(id,b,"The bell rang again.")).statusCode).toBe(200);
    const history=async()=>{const res=await f.history(id);expect(res.statusCode).toBe(200);return res.json();};
    const receipt=()=>f.app.inject({method:"GET",url:capturePath+"/"+captureBody.request_id,headers:alice});
    const draft=()=>f.app.inject({method:"GET",url:"/chapters/"+id+"/draft",headers:alice});
    const markers=async()=> (await pool.query("SELECT *,removed_created_at::text AS exact_stamp FROM snapshot_label_lifecycles ORDER BY chapter_id,version_id")).rows;
    const receipts=async()=> (await pool.query("SELECT * FROM snapshot_capture_requests ORDER BY chapter_id,request_id")).rows;
    const stamps=async()=> (await pool.query("SELECT created_at::text AS stamp FROM named_cuts WHERE chapter_id=$1 AND version_id=$2",[id,b])).rows;
    const before=await state(pool), beforeNames=await labels(pool),beforeMarkers=await markers(),beforeReceipts=await receipts(),beforeStamps=await stamps();
    const beforeHistory=await history(),beforeDraft=await draft(),beforeReceipt=await receipt();
    expect(beforeReceipt.statusCode).toBe(200);
    expect(beforeDraft.statusCode).toBe(200);
    expect(beforeHistory.active_version_id).toBe(a.version.id);
    expect(beforeDraft.json().draft).toMatchObject({content:"The bell rang again.",base_version:b,revision:1});
    const row=beforeHistory.versions.find((v:{id:string})=>v.id===b);
    expect(row.snapshot).toEqual(capture.snapshot);
    const body={action:"remove",snapshot_id:row.snapshot_lifecycle.snapshot_id,expected_token:row.snapshot_lifecycle.state_token};
    const url="/chapters/"+id+"/versions/"+b+"/snapshot-label";
    const client=await pool.connect();
    const original=client.query.bind(client);
    let deleted=false,failed=false,released=false;
    const spy=vi.spyOn(client,"query").mockImplementation((async(sql:string,params?:unknown[])=>{
      if(deleted&&!failed&&/^\s*UPDATE snapshot_label_lifecycles\b/i.test(sql)){
        failed=true;
        throw new Error("D15 isolated removal probe");
      }
      const result=await original(sql,params);
      if(/^\s*DELETE FROM named_cuts\b/i.test(sql)){
        expect(result.rowCount).toBe(1);
        deleted=true;
      }
      return result;
    }) as typeof client.query);
    const proxy={query:pool.query.bind(pool),connect:async()=>({
      query:client.query.bind(client),
      release:(discard?:boolean)=>{spy.mockRestore();released=true;client.release(discard);},
    } as unknown as PoolClient)} as unknown as Pool;
    const broken=buildApp({pool:proxy});
    try {
      const response=await broken.inject({method:"POST",url,headers:alice,payload:body});
      expect(deleted).toBe(true);expect(failed).toBe(true);expect(released).toBe(true);
      expect(response.statusCode,response.body).toBe(500);
      expect(response.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});
    } finally {
      spy.mockRestore();
      if(!released)client.release(true);
      await broken.close();
    }
    expect(await state(pool)).toEqual(before);
    expect(await labels(pool)).toEqual(beforeNames);
    expect(await markers()).toEqual(beforeMarkers);
    expect(await receipts()).toEqual(beforeReceipts);
    expect(await stamps()).toEqual(beforeStamps);
    expect(await history()).toEqual(beforeHistory);
    expect((await draft()).json()).toEqual(beforeDraft.json());
    const read=await receipt();
    expect(read.statusCode).toBe(200);expect(read.json()).toEqual(beforeReceipt.json());
    const recovered=await f.app.inject({method:"POST",url,headers:alice,payload:body});
    expect(recovered.statusCode,recovered.body).toBe(200);
    const removed=recovered.json();
    expect(removed.snapshot).toBeNull();
    expect(removed.snapshot_lifecycle).toEqual({snapshot_id:body.snapshot_id,state_token:expect.any(String),previous_token:body.expected_token});
    expect(removed.snapshot_lifecycle.state_token).not.toBe(body.expected_token);
    expect(await history()).toEqual({...beforeHistory,versions:beforeHistory.versions.map((v:{id:string})=>v.id===b?{...v,snapshot:null,snapshot_lifecycle:removed.snapshot_lifecycle,can_name_snapshot:removed.can_name_snapshot}:v)});
    expect(await labels(pool)).toEqual([]);
    expect(await markers()).toEqual([{...beforeMarkers[0],...removed.snapshot_lifecycle,removed_name_hash:createHash("sha256").update("Before the bell","utf8").digest("hex"),removed_created_at:beforeNames[0].created_at,exact_stamp:beforeStamps[0].stamp}]);
    expect(await receipts()).toEqual(beforeReceipts);
    expect(await state(pool)).toEqual(before);
    expect((await draft()).json()).toEqual(beforeDraft.json());
    const removedReceipt=await receipt();
    expect(removedReceipt.statusCode).toBe(409);
    expect(removedReceipt.json()).toEqual({error:{code:"snapshot_conflict",message:"Snapshot name was removed",details:{reason:"snapshot_removed"}}});
  } finally { await f.app.close();await resetDb(pool); }
  expect((await pool.query("SELECT filename FROM schema_migrations")).rowCount).toBe(17);
});
