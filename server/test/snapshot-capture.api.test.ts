import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { makePool, resetDb } from "./helpers.js";
import { fixture, state, labels, alice, bob } from "./namedCutsFixtures.js";
import { seedSeries } from "./seed.js";
import type { CaptureRequest, CaptureResult } from "../src/named-cuts/capture.js";

const pool = makePool();
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { await resetDb(pool); f = await fixture(pool); });
afterEach(async () => { await f.app.close(); await resetDb(pool); });
afterAll(() => pool.end());
const body = (base: string, content: string, revision = 0, name?: string): CaptureRequest =>
  ({request_id:randomUUID(),content,base_version:base,base_revision:revision,...(name === undefined ? {} : {name})});
const post = (id: string, payload: object | string, headers: Record<string,string> = alice) =>
  f.app.inject({method:"POST",url:"/chapters/"+id+"/snapshots",headers,payload});
const receipts = async () => (await pool.query("SELECT * FROM snapshot_capture_requests ORDER BY chapter_id,request_id")).rows;
const validation = (path:string,message:string) => ({error:{code:"validation_failed",message:"Request validation failed",details:{errors:[{path,message}]}}});
const snapshotConflict = (reason:string,message:string) => ({error:{code:"snapshot_conflict",message,details:{reason}}});
const result = (r: {json:<T>()=>T}) => r.json<{capture:CaptureResult}>().capture;
async function stamp(seq:number) {
  const c=await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("ALTER TABLE ledger DISABLE TRIGGER ledger_immutable");
    await c.query("UPDATE ledger SET at='2026-11-16T23:30:00.000Z' WHERE series_id=$1 AND l_seq=$2",[f.seriesId,seq]);
    await c.query("ALTER TABLE ledger ENABLE TRIGGER ledger_immutable");
    await c.query("COMMIT");
  } catch(e) {await c.query("ROLLBACK");throw e;} finally {c.release();}
}
test("AXB-0100 AC1 commits inert version and folded label with the receipt, and defaults to saved UTC date", async()=>{
  const first=await f.create(), id=first.chapter.id;
  const a=await f.write(id,"The gate shut.","send");
  expect((await f.head(id,a.version.id,"The bell rang.")).statusCode).toBe(200);
  const before=await state(pool);
  const input=body(a.version.id,"The bell rang.",1,"  Before   the bell  ");
  const response=await post(id,input);
  expect(response.statusCode,response.body).toBe(201);
  expect(response.headers["cache-control"]).toBe("no-store");
  const c=result(response);
  expect(c).toMatchObject({request_id:input.request_id,created_version:true,draft_current:true,active_version_id:a.version.id,sync:{state:"edited",same:false},snapshot:{chapter_id:id,name:"Before the bell",kind:"snapshot",pack_pins:{}},version:{chapter_id:id,source:"draft_edit",parent_version:a.version.id}});
  expect(c.snapshot.version_id).toBe(c.version.id);
  expect(c.snapshot.l_seq).toBe(c.version.l_seq);
  const after=await state(pool);
  expect(after.ledger).toHaveLength(before.ledger.length+1);
  expect(after.versions).toHaveLength(before.versions.length+1);
  expect(after.heads).toEqual([]);
  expect(after.active).toEqual(before.active);
  expect(await receipts()).toEqual([expect.objectContaining({chapter_id:id,request_id:input.request_id,captured_version_id:c.version.id,draft_base_version_id:c.version.id,draft_base_revision:0,created_version:true})]);
  const history=(await f.history(id)).json();
  expect(history.versions[0]).toMatchObject({id:c.version.id,snapshot:c.snapshot,can_name_snapshot:false});
  await resetDb(pool);
  await f.app.close(); f=await fixture(pool);
  const other=await f.create("The gate shut.");
  const saved=await f.write(other.chapter.id,"The bell rang.");
  await stamp(saved.version.l_seq);
  const named=await post(other.chapter.id,body(saved.version.id,"The bell rang."));
  expect(named.statusCode,named.body).toBe(201);
  expect(result(named).snapshot.name).toBe("Chapter 1 · 2026-11-16 · The bell rang.");
});
test("AXB-0100 AC2 greatest byte-exact reuse, name conflict, different bytes and saved hints",async()=>{
  const first=await f.create("Exact text."),id=first.chapter.id;
  const sent=await f.write(id,"Exact text.","send");
  const latest=await f.write(id,"Other text.");
  expect((await f.head(id,latest.version.id,"Working text.")).statusCode).toBe(200);
  const before=await state(pool);
  const captured=await post(id,body(latest.version.id,"Exact text.",1,"Exact"));
  expect(captured.statusCode,captured.body).toBe(201);
  expect(result(captured)).toMatchObject({created_version:false,version:{id:sent.version.id},draft_current:true});
  for(const name of [" Exact ",undefined]) {
    const r=await post(id,body(latest.version.id,"Exact text.",1,name));
    expect(r.statusCode,r.body).toBe(201);expect(result(r).snapshot).toEqual(result(captured).snapshot);
  }
  const bad=await post(id,body(latest.version.id,"Exact text.",1,"Different"));
  expect(bad.statusCode).toBe(409);expect(bad.json()).toEqual(snapshotConflict("name_exists","This version already has a snapshot name"));
  expect(await state(pool)).toEqual(before);
  const changed=await post(id,body(latest.version.id,"Exact  text.",1));
  expect(changed.statusCode,changed.body).toBe(201);expect(result(changed).created_version).toBe(true);
  const hinted=await f.app.inject({method:"POST",url:"/chapters/"+id+"/versions",headers:alice,payload:{content:"Hinted text.",hints:[{pov:"Alice"}]}});
  expect(hinted.statusCode,hinted.body).toBe(201);
  const h=hinted.json().version.id;
  const exact=await post(id,body(h,"Hinted text."));
  expect(exact.statusCode,exact.body).toBe(201);expect(result(exact)).toMatchObject({created_version:false,version:{id:h}});
  const saved=await state(pool);
  const rejected=await post(id,body(h,"Changed hinted text."));
  expect(rejected.statusCode).toBe(409);expect(rejected.json()).toEqual(snapshotConflict("scene_hints","Changed draft text cannot be captured with saved scene hints"));
  expect(await state(pool)).toEqual(saved);
});
test("AXB-0100 AC3 identity, ownership, shape, Unicode, limits, release and empty guards",async()=>{
  const a=await f.create(), id=a.chapter.id;
  const input=body(a.version.id,"The bell rang.");
  const other=await seedSeries(pool,"usr_bob");
  const outside=await f.app.inject({method:"POST",url:"/books/"+other.bookId+"/chapters",headers:bob,payload:{content:"Private."}});
  expect(outside.statusCode).toBe(201);
  const foreign=outside.json().chapter.id;
  expect((await post(id,input,{})).statusCode).toBe(401);
  for(const [target,headers,message] of [[id,bob,"Chapter not found"],[foreign,alice,"Chapter not found"],["ch_000000000000",alice,"Chapter not found"],["x".repeat(65),alice,"Chapter not found"],["%00",alice,"Chapter not found"],["x".repeat(101),alice,"Route not found"]] as const) {
    const r=await post(target,input,headers);expect(r.statusCode,r.body).toBe(404);expect(r.json()).toEqual({error:{code:"not_found",message,details:null}});
  }
  for(const invalid of [{...input,extra:1},{...input,name:null},{...input,base_revision:-1},{...input,base_revision:2147483648},{...input,request_id:"x"},{...input,base_version:"x"},{...input,content:null}]) expect((await post(id,invalid)).statusCode).toBe(400);
  for(const content of ["\u0000","\ud800","x".repeat(1000001)]) {
    const r=await post(id,{...input,content});expect(r.statusCode,r.body).toBe(400);expect(r.json()).toEqual(validation("/content","must be at most 1000000 characters and must not contain NUL or unpaired surrogates"));
  }
  for(const name of ["\u0000","\ud800","x".repeat(200)+"😀"]) {
    const r=await post(id,{...input,name});expect(r.statusCode,r.body).toBe(400);expect(r.json()).toEqual(validation("/name","must be at most 200 characters after whitespace normalization and must not contain NUL or unpaired surrogates"));
  }
  expect((await post(id,JSON.stringify({...input,content:"x".repeat(8388608)}),{...alice,"content-type":"application/json"})).statusCode).toBe(413);
  expect((await post(id,"x",{...alice,"content-type":"text/plain"})).statusCode).toBe(415);
  const empty=await post(id,{...input,content:"---\n\n* * *"});expect(empty.statusCode).toBe(400);expect(empty.json()).toEqual(validation("/content","nothing to capture"));
  await pool.query("UPDATE books SET status='released' WHERE id=$1",[f.bookId]);
  const released=await post(id,input);expect(released.statusCode).toBe(409);expect(released.json()).toEqual(snapshotConflict("released_book","Released chapters require a locked version"));
  await pool.query("UPDATE books SET status='drafting' WHERE id=$1",[f.bookId]);
  const {rows:[versionless]}=await pool.query("INSERT INTO chapters(book_id,order_key) VALUES($1,'0000009999') RETURNING id",[f.bookId]);
  const missing=await post(versionless.id,input);expect(missing.statusCode).toBe(400);expect(missing.json()).toEqual(validation("/base_version","save a chapter version first"));
  expect(await receipts()).toEqual([]);expect(await labels(pool)).toEqual([]);
  const name="x".repeat(199)+"😀";
  const valid=await post(id,{...input,name});expect(valid.statusCode,valid.body).toBe(201);expect(result(valid).snapshot.name).toBe(name);
}, 20000);
test("AXB-0100 AC4 races serialize, stale revision preserves head, exact UUID replay commits once",async()=>{
  const a=await f.create(),id=a.chapter.id;
  expect((await f.head(id,a.version.id,"Head")).statusCode).toBe(200);
  const before=await state(pool);
  const stale=await post(id,body(a.version.id,"New",0));
  expect(stale.statusCode).toBe(409);expect(stale.json().error.details).toEqual({reason:"revision",current_version:a.version.id,current_revision:1});
  expect(await state(pool)).toEqual(before);
  const race=await Promise.all([post(id,body(a.version.id,"New A",1)),post(id,body(a.version.id,"New B",1))]);
  expect(race.map(r=>r.statusCode).sort()).toEqual([201,409]);
  expect(race.find(r=>r.statusCode===409)!.json().error.details.reason).toBe("version");
  const winner=result(race.find(r=>r.statusCode===201)!);
  const next=body(winner.version.id,"Another");
  const same=await Promise.all([post(id,next),post(id,next)]);
  expect(same.map(r=>r.statusCode).sort()).toEqual([200,201]);
  expect(same[0]!.json()).toEqual(same[1]!.json());
  expect(await receipts()).toHaveLength(2);expect(await labels(pool)).toHaveLength(2);
  expect((await state(pool)).versions).toHaveLength(before.versions.length+2);
});
test("AXB-0100 AC5 replay preserves original result, returns live comparison and rejects request mismatch",async()=>{
  const a=await f.create(),id=a.chapter.id;
  const input=body(a.version.id,"Private manuscript",0," Private  label ");
  const first=await post(id,input);expect(first.statusCode,first.body).toBe(201);
  const c=result(first);
  const sent=await f.write(id,"Later","send");
  expect((await f.head(id,sent.version.id,"Later edits")).statusCode).toBe(200);
  const before=await state(pool), named=await labels(pool), stored=await receipts();
  const replay=await post(id,{...input,name:"Private label"});
  expect(replay.statusCode,replay.body).toBe(200);
  expect(result(replay)).toEqual({...c,draft_current:false,active_version_id:sent.version.id,sync:{state:"edited",same:false}});
  const mismatch=await post(id,{...input,content:"Different"});
  expect(mismatch.statusCode).toBe(409);expect(mismatch.json()).toEqual(snapshotConflict("request_mismatch","Snapshot request ID already used"));
  expect(await state(pool)).toEqual(before);expect(await labels(pool)).toEqual(named);expect(await receipts()).toEqual(stored);
  const logger=vi.spyOn(f.app.log,"error");
  try { const r=await post(id,{...input,name:"Other private label"});expect(r.statusCode).toBe(409);expect(logger).not.toHaveBeenCalled(); }
  finally {logger.mockRestore();}
});

test("D15: D14 reuse binds a D13 label to its original lifecycle identity",async()=>{
  const a=await f.create(),id=a.chapter.id;
  const b=await f.write(id,"The bell rang.");
  const named=await f.name(id,b.version.id,"Before the bell");
  expect(named.statusCode).toBe(201);
  const initial=(await f.history(id)).json().versions.find((v:{id:string})=>v.id===b.version.id);
  const input=body(b.version.id,"The bell rang.",0,"Before the bell");
  const captured=await post(id,input);
  expect(captured.statusCode,captured.body).toBe(201);
  expect(result(captured).snapshot).toEqual(initial.snapshot);
  expect((await receipts())[0].snapshot_id).toBe(initial.snapshot_lifecycle.snapshot_id);
  const url="/chapters/"+id+"/versions/"+b.version.id+"/snapshot-label";
  const removed=await f.app.inject({method:"POST",url,headers:alice,payload:{action:"remove",snapshot_id:initial.snapshot_lifecycle.snapshot_id,expected_token:initial.snapshot_lifecycle.state_token}});
  expect(removed.statusCode).toBe(200);
  const replay=await post(id,input);
  expect(replay.statusCode).toBe(409);expect(replay.json()).toEqual(snapshotConflict("snapshot_removed","Snapshot name was removed"));
  expect((await post(id,{...input,content:"Mismatch"})).json()).toEqual(snapshotConflict("request_mismatch","Snapshot request ID already used"));
  const undo=await f.app.inject({method:"POST",url,headers:alice,payload:{action:"undo",snapshot_id:initial.snapshot_lifecycle.snapshot_id,expected_token:removed.json().snapshot_lifecycle.state_token,name:initial.snapshot.name}});
  expect(undo.statusCode).toBe(200);
  const restored=await post(id,input);expect(restored.statusCode).toBe(200);expect(restored.json()).toEqual(captured.json());
});
