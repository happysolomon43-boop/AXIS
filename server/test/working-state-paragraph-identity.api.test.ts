import { afterAll, beforeEach, expect, test } from "vitest";
import type { Pool, PoolClient } from "pg";
import { Writable } from "node:stream";
import { buildApp } from "../src/app.js";
import { makePool, resetDb } from "./helpers.js";
import { fixture, state, labels, alice, bob } from "./namedCutsFixtures.js";
import type { WorkingState } from "../src/drafts/repository.js";
const pool=makePool();
beforeEach(()=>resetDb(pool));
afterAll(()=>pool.end());
const raw="# North\n\nRiver.\n\nHe nodded.\n\nHe nodded.\n\n* * *\n\nBrook.";
const changed="# North\n\nBrook.\n\nHe nodded.\n\nRiver!\n\n* * *\n\nHe nodded.\n\nNew.";
test.each([raw,changed,""])("AXB-0138 coherent head projection and unchanged legacy reads",async content=>{
  const f=await fixture(pool);
  try {
    const created=await f.create(raw);
    const sent=await f.write(created.chapter.id,raw,"send");
    const url="/chapters/"+created.chapter.id;
    const get=(suffix:string,headers=alice)=>f.app.inject({method:"GET",url:url+suffix,headers});
    expect((await get("/working-state")).json<WorkingState>().draft).toBeNull();
    expect((await f.head(created.chapter.id,sent.version.id,content)).statusCode).toBe(200);
    const before=await state(pool), named=await labels(pool);
    const response=await get("/working-state");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const work=response.json<WorkingState>(), ids=work.blocks.map(b=>b.block_uid);
    expect(Object.keys(work).sort()).toEqual(["active_version_id","blocks","chapter","draft","scenes","sync","version"]);
    expect(work.draft).toMatchObject({base_version:sent.version.id,revision:1,content});
    expect(work.active_version_id).toBe(sent.version.id);
    expect(work.draft!.blocks.map(b=>b.block_uid)).toEqual(content===raw?[null,ids[1],ids[2],ids[3],null,ids[5]]:content===changed?[null,ids[5],null,null,null,null,null]:[]);
    const legacy=(await get("/draft")).json(), sync=(await get("/draft?view=sync")).json(), detail=(await get("")).json();
    expect(legacy).toEqual({chapter:work.chapter,sync:work.sync,draft:{...work.draft,blocks:work.draft!.blocks.map(({ordinal,kind,text})=>({ordinal,kind,text}))}});
    expect(sync).toEqual({sync:work.sync});
    const {draft:_draft,sync:_sync,...old}=work;expect(detail).toEqual(old);
    expect((await f.app.inject({method:"GET",url:url+"/working-state"})).statusCode).toBe(401);
    const foreign=await get("/working-state",bob);
    const unknown=await f.app.inject({method:"GET",url:"/chapters/ch_000000000000/working-state",headers:alice});
    expect(foreign.statusCode).toBe(404);expect(foreign.json()).toEqual(unknown.json());
    expect(await state(pool)).toEqual(before);expect(await labels(pool)).toEqual(named);
    expect(Number((await pool.query("SELECT count(*) AS n FROM schema_migrations")).rows[0].n)).toBe(18);
  }finally{await f.app.close();}
});

test("AXB-0138 corrupt equal-text segmentation fails closed without content or UID in the log",async()=>{
 const f=await fixture(pool);
 let app:ReturnType<typeof buildApp>|undefined;
 try{
  const created=await f.create(raw);
  expect((await f.head(created.chapter.id,created.version.id,raw)).statusCode).toBe(200);
  const before=await state(pool),named=await labels(pool);
  let log="", corrupted=false;
  const connection={
   query:pool.query.bind(pool),
   async connect(){
    const client=await pool.connect();
    return {release:client.release.bind(client),async query(sql:string,args?:unknown[]){
     const result=await client.query(sql,args);
     if(sql.startsWith("SELECT block_uid, ordinal, kind, text, hash FROM blocks")&&result.rows.length){
      corrupted=true;return {...result,rows:result.rows.map((row,i)=>i===1?{...row,text:"private mismatched content"}:row)};
     }
     return result;
    }} as PoolClient;
   },
  } as Pool;
  app=buildApp({pool:connection},new Writable({write(chunk,_encoding,done){log+=chunk.toString();done();}}));
  const response=await app.inject({method:"GET",url:"/chapters/"+created.chapter.id+"/working-state",headers:alice});
  expect(corrupted).toBe(true);expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});
  expect(log).toContain("request_failed");expect(log).not.toContain("private mismatched content");expect(log).not.toContain(created.chapter.id);expect(log).not.toContain(created.version.id);expect(log).not.toContain("River.");
  expect(await state(pool)).toEqual(before);expect(await labels(pool)).toEqual(named);
 }finally{await app?.close();await f.app.close();}
});
