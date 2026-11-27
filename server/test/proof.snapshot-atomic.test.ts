import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { makePool, resetDb } from "./helpers.js";
import { alice, fixture, labels, state } from "./namedCutsFixtures.js";
const pool=makePool();
afterAll(()=>pool.end());
test("AXB-0103 AC2: staged version, ledger, label, and receipt commit atomically",async()=>{
 await resetDb(pool);const f=await fixture(pool);
 try{
  const first=await f.create("The gate shut."),id=first.chapter.id;
  const a=await f.write(id,"The gate shut.","send");
  expect((await f.head(id,a.version.id,"The bell rang.")).statusCode).toBe(200);
  const before=await state(pool), beforeLabels=await labels(pool);
  const beforeReceipts=(await pool.query("SELECT * FROM snapshot_capture_requests")).rows;
  const body={request_id:randomUUID(),content:"The bell rang.",base_version:a.version.id,base_revision:1,name:"Before the bell"};
  const path="/chapters/"+id+"/snapshots";
  let staged=false, failed=false;
  const proxy={connect:async()=>{
   const client=await pool.connect();
   const query=vi.fn(async(sql:string,values?:unknown[])=>{
    if(staged&&!failed&&/^\s*INSERT INTO named_cuts\b/i.test(sql)){failed=true;throw new Error("D14 isolated probe");}
    const result=await client.query(sql,values);
    if(/commit_inputs/i.test(sql))staged=true;
    return result;
   });
   return {query,release:()=>client.release()} as unknown as PoolClient;
  },query:pool.query.bind(pool)} as unknown as Pool;
  const broken=buildApp({pool:proxy});
  try{
   const res=await broken.inject({method:"POST",url:path,headers:alice,payload:body});
   expect(staged).toBe(true);expect(failed).toBe(true);expect(res.statusCode,res.body).toBe(500);expect(res.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});
  }finally{await broken.close();}
  expect(await state(pool)).toEqual(before);expect(await labels(pool)).toEqual(beforeLabels);
  expect((await pool.query("SELECT * FROM snapshot_capture_requests")).rows).toEqual(beforeReceipts);
  const absent=await f.app.inject({method:"GET",url:path+"/"+body.request_id,headers:alice});expect(absent.statusCode).toBe(200);expect(absent.json()).toEqual({capture:null});
  const recovered=await f.app.inject({method:"POST",url:path,headers:alice,payload:body});expect(recovered.statusCode,recovered.body).toBe(201);
  const capture=recovered.json().capture;expect(capture.created_version).toBe(true);
  const after=await state(pool);expect(after.versions.length).toBe(before.versions.length+1);expect(after.ledger.length).toBe(before.ledger.length+1);
  expect(after.active).toEqual(before.active);expect(after.heads).toEqual([]);
  expect(await labels(pool)).toHaveLength(beforeLabels.length+1);
  expect((await pool.query("SELECT * FROM snapshot_capture_requests")).rows).toHaveLength(beforeReceipts.length+1);
  expect((await f.app.inject({method:"GET",url:path+"/"+body.request_id,headers:alice})).json()).toEqual({capture});
 }finally{await f.app.close();await resetDb(pool);}
 expect((await pool.query("SELECT filename FROM schema_migrations")).rowCount).toBe(16);
});
