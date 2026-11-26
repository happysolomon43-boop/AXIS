import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type { ChapterHistory } from "../src/corpus/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { fixture,state,alice,bob,labels } from "./namedCutsFixtures.js";
const pool=makePool();
let f:Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{await resetDb(pool);f=await fixture(pool);});
afterEach(async()=>{await f.app.close();await resetDb(pool);});
afterAll(()=>pool.end());
test("AXB-0093 AC1 same ordered History with exact additive metadata and release guard",async()=>{
  const initial=await f.create("Initial"),id=initial.chapter.id;
  const empty=await f.write(id,"---"),sent=await f.write(id,"Sent text","send"),older=await f.write(id,"Older save"),newest=await f.write(id,"Newest save");
  const named=await f.name(id,older.version.id,"Before the bell");expect(named.statusCode).toBe(201);
  const before=await state(pool);
  const r=await f.history(id);expect(r.statusCode,r.body).toBe(200);expect(r.headers["cache-control"]).toBe("no-store");
  const h=r.json<ChapterHistory>();
  expect(Object.keys(h).sort()).toEqual(["active_version_id","chapter","versions"]);
  expect(h.chapter).toEqual(initial.chapter);expect(h.active_version_id).toBe(sent.version.id);
  const expected=[newest,older,sent,empty,initial].map(x=>x.version);
  expect(h.versions.map(v=>v.id)).toEqual(expected.map(v=>v.id));
  expect(h.versions.map(v=>v.word_count)).toEqual([2,2,2,0,1]);
  expect(h.versions.map(v=>v.can_name_snapshot)).toEqual([true,false,false,false,false]);
  expect(h.versions.map(v=>v.snapshot)).toEqual([null,named.json().snapshot,null,null,null]);
  for(let i=0;i<expected.length;i++){
    const v=expected[i]!,row=h.versions[i]!;
    const at=(await pool.query<{at:Date}>("SELECT at FROM ledger WHERE series_id=$1 AND l_seq=$2",[f.seriesId,v.l_seq])).rows[0]!.at.toISOString();
    expect(row).toEqual({...v,at,word_count:row.word_count,snapshot:row.snapshot,can_name_snapshot:row.can_name_snapshot});
  }
  expect(await state(pool)).toEqual(before);
  await pool.query("UPDATE books SET status='released' WHERE id=$1",[f.bookId]);
  const released=(await f.history(id)).json<ChapterHistory>();
  expect(released.versions.every(v=>!v.can_name_snapshot)).toBe(true);
  expect(released.versions[1]!.snapshot).toEqual(named.json().snapshot);
});
test("AXB-0093 AC2 empty, ownership and failing read preserve rows",async()=>{
  const first=await f.create(),v=await f.write(first.chapter.id,"Name me");
  expect((await f.name(first.chapter.id,v.version.id,"Private")).statusCode).toBe(201);
  const empty=(await pool.query("INSERT INTO chapters(book_id,order_key) VALUES($1,'0000002000') RETURNING id,book_id,order_key",[f.bookId])).rows[0];
  expect((await f.history(empty.id)).json()).toEqual({chapter:empty,active_version_id:null,versions:[]});
  const url="/chapters/"+first.chapter.id+"/history";
  for(const [headers,status] of [[bob,404],[{},401]] as const){
    const r=await f.app.inject({method:"GET",url,headers});expect(r.statusCode).toBe(status);expect(r.body).not.toContain("Private");
  }
  const before=await state(pool),names=await labels(pool);
  const fake={async connect(){const c=await pool.connect();return {release:c.release.bind(c),query:async(sql:string,params?:unknown[])=>{
    if(sql.includes("LEFT JOIN named_cuts")) throw new Error("read failed");
    return c.query(sql,params);
  }} as unknown as PoolClient;}};
  const bad=buildApp({pool:fake as unknown as Pool});
  try{
    const r=await bad.inject({method:"GET",url,headers:alice});expect(r.statusCode).toBe(500);expect(r.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});
    expect(await state(pool)).toEqual(before);expect(await labels(pool)).toEqual(names);
  }finally{await bad.close();}
});
