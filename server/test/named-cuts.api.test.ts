import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { NamedSnapshot } from "../src/named-cuts/repository.js";
import { makePool, resetDb } from "./helpers.js";
import { fixture, state, labels, alice, bob } from "./namedCutsFixtures.js";
import { seedVersionAs } from "./seed.js";
const pool=makePool();
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{await resetDb(pool); f=await fixture(pool);});
afterEach(async()=>{await f.app.close(); await resetDb(pool);});
afterAll(()=>pool.end());
function validation(path: string,message: string) {
  return {error:{code:"validation_failed",message:"Request validation failed",details:{errors:[{path,message}]}}};
}
function conflict(reason: string,message: string) {
  return {error:{code:"snapshot_conflict",message,details:{reason}}};
}
function dto(res: {json: <T>()=>T}) { return res.json<{snapshot:NamedSnapshot}>().snapshot; }
async function saved(content="The bell rang.") {
  const first=await f.create();
  return f.write(first.chapter.id,content);
}
test("AXB-0092 AC1 names older saved cut, defaults, normalized Unicode and no Corpus change",async()=>{
  const first=await f.create();
  const a=await f.write(first.chapter.id,"The bell rang.");
  // Test-only timestamp fixture: restore the immutable trigger before committing.
  const c=await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("ALTER TABLE ledger DISABLE TRIGGER ledger_immutable");
    await c.query("UPDATE ledger SET at='2026-11-16T23:30:00.000Z' WHERE series_id=$1 AND l_seq=$2",[f.seriesId,a.version.l_seq]);
    await c.query("ALTER TABLE ledger ENABLE TRIGGER ledger_immutable");
    await c.query("COMMIT");
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
  const b=await f.write(first.chapter.id,"The bell rang.");
  const c2=await f.write(first.chapter.id,"The bell rang. The gate opened.");
  const d=await f.write(first.chapter.id,"The bell rang.");
  expect((await f.head(first.chapter.id,d.version.id,"New working text")).statusCode).toBe(200);
  const before=await state(pool);
  const named=await f.name(first.chapter.id,a.version.id);
  expect(named.statusCode,named.body).toBe(201);
  expect(named.headers["cache-control"]).toBe("no-store");
  expect(named.json()).toEqual({snapshot:{chapter_id:first.chapter.id,version_id:a.version.id,kind:"snapshot",name:"Chapter 1 · 2026-11-16 · The bell rang.",l_seq:a.version.l_seq,pack_pins:{},created_at:expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)}});
  const equal=await f.name(first.chapter.id,b.version.id," \n\t");
  expect(equal.statusCode).toBe(201);expect(dto(equal).name).toMatch(/ · The bell rang\.$/);
  const custom=await f.name(first.chapter.id,c2.version.id,"  Before\tThe\u00a0Bell  ");
  expect(custom.statusCode).toBe(201);expect(dto(custom).name).toBe("Before The Bell");
  const deletion=await f.name(first.chapter.id,d.version.id);
  expect(deletion.statusCode).toBe(201);expect(dto(deletion).name).toMatch(/ · The bell rang\.$/);
  expect(await state(pool)).toEqual(before);
  const longParent=await f.write(first.chapter.id,"One. Two. Three.");
  const tail=await f.write(first.chapter.id,"One. Two.");
  const tailName=await f.name(first.chapter.id,tail.version.id);
  expect(dto(tailName).name).toMatch(/ · Two\.$/);
  // Compare at the point before the extra Save fixtures as well.
  const after=await state(pool);
  expect(after.versions.slice().filter(v=>before.versions.some(b=>b.id===v.id))).toEqual(before.versions);
  expect(after.ledger.slice(0,before.ledger.length)).toEqual(before.ledger);
  expect(after.active).toEqual(before.active);
  expect(longParent.version.id).not.toBe(tail.version.id);
});
test("AXB-0092 AC2 eligibility, released guard and replay",async()=>{
  const first=await f.create(), id=first.chapter.id;
  const empty=await f.write(id,"---");
  const sent=await f.write(id,"Sent text","send");
  const imported=await f.write(id,"Imported text","versions","import");
  expect((await f.head(id,imported.version.id,"checkpoint text")).statusCode).toBe(200);
  const restore=await f.app.inject({method:"POST",url:"/chapters/"+id+"/restore",headers:alice,payload:{version_id:sent.version.id}});
  expect(restore.statusCode,restore.body).toBe(201);
  const rr=restore.json();
  const checkpointReplay=await f.name(id,rr.checkpoint_version_id);
  expect(checkpointReplay.statusCode,checkpointReplay.body).toBe(200);
  expect(dto(checkpointReplay)).toMatchObject({version_id:rr.checkpoint_version_id,name:"Before restore"});
  const unnamedCheckpoint=await seedVersionAs(pool,f.seriesId,id,"Other checkpoint","checkpoint","chapter.version.append");
  const e=await f.name(id,empty.version.id);expect(e.statusCode).toBe(400);expect(e.json()).toEqual(validation("/version_id","nothing to capture"));
  for(const v of [first.version.id,sent.version.id,imported.version.id,rr.version.id,unnamedCheckpoint]) {
    const r=await f.name(id,v);expect(r.statusCode,r.body).toBe(400);expect(r.json()).toEqual(validation("/version_id","select a version created by Save"));
  }
  const a=await f.write(id,"Save A"),b=await f.write(id,"Save B");
  const firstName=await f.name(id,a.version.id,"A");expect(firstName.statusCode).toBe(201);
  await pool.query("UPDATE books SET status='released' WHERE id=$1",[f.bookId]);
  const blocked=await f.name(id,b.version.id);
  expect(blocked.statusCode).toBe(409);expect(blocked.json()).toEqual(conflict("released_book","Released chapters require a locked version"));
  const retry=await f.name(id,a.version.id,"A");expect(retry.statusCode).toBe(200);expect(retry.json()).toEqual(firstName.json());
  expect(await labels(pool)).toHaveLength(2);
});
test("AXB-0092 AC3 owner, path, schema, Unicode and transport precedence",async()=>{
  const a=await saved(), b=await saved();
  const foreign=await fixture(pool);
  try {
    const outside=await foreign.create();
    const data=f.payload(a.chapter.id,a.version.id);
    const post=(url:string,headers:Record<string,string>,payload:object|string=data)=>f.app.inject({method:"POST",url,headers,payload});
    expect((await post(f.path,{},data)).statusCode).toBe(401);
    for(const [url,headers,payload,message] of [
      [f.path,bob,data,"Series not found"],[f.path,alice,f.payload(a.chapter.id,b.version.id),"Version not found"],
      [f.path,alice,f.payload(outside.chapter.id,outside.version.id),"Chapter not found"],
      ["/series/ser_000000000000/named-cuts",alice,data,"Series not found"],
      ["/series/"+ "a".repeat(65)+"/named-cuts",alice,data,"Series not found"],
      ["/series/"+ "a".repeat(101)+"/named-cuts",alice,data,"Route not found"],
      ["/series/%00/named-cuts",alice,data,"Series not found"],
    ] as const){
      const r=await post(url,headers,payload);expect(r.statusCode,r.body).toBe(404);expect(r.json()).toEqual({error:{code:"not_found",message,details:null}});
    }
    for(const body of [{...data,extra:1},{...data,name:null}]) expect((await post(f.path,alice,body)).statusCode).toBe(400);
    for(const name of ["\u0000","\ud800","a".repeat(200)+"😀"]){
      const r=await post(f.path,alice,{...data,name});expect(r.statusCode,r.body).toBe(400);
      expect(r.json()).toEqual(validation("/name","must be at most 200 characters after whitespace normalization and must not contain NUL or unpaired surrogates"));
    }
    expect((await post(f.path,{"x-axis-user":"usr_alice","content-type":"application/json"},JSON.stringify({...data,name:"x".repeat(1048576)}))).statusCode).toBe(413);
    expect((await post(f.path,{"x-axis-user":"usr_alice","content-type":"text/plain"},"x")).statusCode).toBe(415);
    expect(await labels(pool)).toEqual([]);
    const name="a".repeat(199)+"😀";
    const ok=await f.name(a.chapter.id,a.version.id,name);expect(ok.statusCode,ok.body).toBe(201);expect(dto(ok).name).toBe(name);
  } finally{await foreign.app.close();}
});
test("AXB-0092 AC4 concurrent naming and exact stable replays",async()=>{
  const a=await saved();
  const replies=await Promise.all(["Before bell","After bell"].map(n=>f.name(a.chapter.id,a.version.id,n)));
  expect(replies.map(r=>r.statusCode).sort()).toEqual([201,409]);
  const win=replies.find(r=>r.statusCode===201)!;
  const lose=replies.find(r=>r.statusCode===409)!;
  expect(lose.json()).toEqual(conflict("name_exists","This version already has a snapshot name"));
  const name=dto(win).name;
  for(const n of [name,"  "+name.replace(" ","\t")+"  ",undefined]){
    const replay=await f.name(a.chapter.id,a.version.id,n);expect(replay.statusCode).toBe(200);expect(replay.headers["cache-control"]).toBe("no-store");expect(replay.json()).toEqual(win.json());
  }
  expect(await labels(pool)).toHaveLength(1);
});
test("AXB-0092 AC5 failed insert rolls back without logging label, later explicit retry succeeds",async()=>{
  const a=await saved();expect((await f.head(a.chapter.id,a.version.id,"Unsaved working text")).statusCode).toBe(200);
  const before=await state(pool);
  const proxy={async connect(){const c=await pool.connect();return {release:c.release.bind(c),query:async(sql:string,params?:unknown[])=>{
    if(sql.includes("INSERT INTO named_cuts")) throw new Error("private label must not be logged");
    return c.query(sql,params);
  }} as unknown as PoolClient;}};
  const bad=buildApp({pool:proxy as unknown as Pool});
  const logged=vi.spyOn(bad.log,"error");
  try{
    const r=await f.name(a.chapter.id,a.version.id,"private label",bad);
    expect(r.statusCode).toBe(500);expect(r.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});
    expect(logged).not.toHaveBeenCalled();expect(await labels(pool)).toEqual([]);expect(await state(pool)).toEqual(before);
  }finally{logged.mockRestore();await bad.close();}
  expect((await f.name(a.chapter.id,a.version.id,"private label")).statusCode).toBe(201);
});
