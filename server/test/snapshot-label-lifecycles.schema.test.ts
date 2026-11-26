import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {afterAll, beforeEach, expect,test} from "vitest";
import {makePool,resetDb} from "./helpers.js";
import {alice,fixture,labels,state} from "./namedCutsFixtures.js";
const pool=makePool();
beforeEach(()=>resetDb(pool));afterAll(()=>pool.end());
const filename="0014_snapshot_label_lifecycles.sql";
const up=()=>readFile(new URL("../db/migrations/"+filename,import.meta.url),"utf8");
const down=()=>readFile(new URL("../db/rollback/0014_snapshot_label_lifecycles.down.sql",import.meta.url),"utf8");
test("AXB-0106 AC1–AC3: backfill, constraints, compatible and incompatible rollback, orphan abort",async()=>{
 const f=await fixture(pool);
 try{
  const a=await f.create(),id=a.chapter.id,b=await f.write(id,"The bell rang.");
  const req={request_id:randomUUID(),content:"The bell rang.",base_version:b.version.id,base_revision:0,name:"Before the bell"};
  expect((await f.app.inject({method:"POST",url:"/chapters/"+id+"/snapshots",headers:alice,payload:req})).statusCode).toBe(201);
  const original=await labels(pool),corpus=await state(pool);
  const c=await pool.connect();
  try{
   await c.query("BEGIN");
   const rows=async(table:string)=>(await c.query("SELECT * FROM "+table)).rows;
   const before=await rows("snapshot_capture_requests");
   const marker=(await rows("snapshot_label_lifecycles"))[0];
   expect(before[0].snapshot_id).toBe(marker.snapshot_id);
   expect(marker).toMatchObject({chapter_id:id,version_id:b.version.id,previous_token:null,removed_name_hash:null,removed_created_at:null});
   const bad=async(sql:string,values:unknown[],code:string)=>{
    await c.query("SAVEPOINT probe");try{await expect(c.query(sql,values)).rejects.toMatchObject({code});}
    finally{await c.query("ROLLBACK TO SAVEPOINT probe");await c.query("RELEASE SAVEPOINT probe");}
   };
   await bad("INSERT INTO snapshot_label_lifecycles(chapter_id,version_id) VALUES($1,$2)",[id,b.version.id],"23505");
   await bad("INSERT INTO snapshot_label_lifecycles(chapter_id,version_id) VALUES($1,$2)",[id,"ver_000000000000"],"23503");
   await bad("UPDATE snapshot_label_lifecycles SET removed_name_hash=$1",["a".repeat(64)],"23514");
   await bad("UPDATE snapshot_label_lifecycles SET removed_name_hash='A',removed_created_at=now()",[],"23514");
   await bad("UPDATE snapshot_label_lifecycles SET previous_token=state_token",[],"23514");
   await c.query("SAVEPOINT incompatible");
   await c.query("UPDATE snapshot_label_lifecycles SET snapshot_id=gen_random_uuid()");
   await bad(await down(),[],"AX002");
   expect(await rows("snapshot_capture_requests")).toEqual(before);
   await c.query("ROLLBACK TO SAVEPOINT incompatible");
   await c.query("SAVEPOINT removed");
   await c.query("DELETE FROM named_cuts");
   await c.query("UPDATE snapshot_label_lifecycles SET removed_name_hash=$1,removed_created_at=now()",["a".repeat(64)]);
   await bad(await down(),[],"AX002");expect(await rows("named_cuts")).toEqual([]);
   await c.query("ROLLBACK TO SAVEPOINT removed");
   await c.query(await down());
   expect(await rows("named_cuts")).toEqual(original);
   const {snapshot_id:_,...legacy}=before[0];expect(await rows("snapshot_capture_requests")).toEqual([legacy]);
   expect((await c.query("SELECT to_regclass('snapshot_label_lifecycles') AS name")).rows).toEqual([{name:null}]);
   await c.query("SAVEPOINT orphan");
   await c.query("DELETE FROM named_cuts");
   await bad(await up(),[],"23502");
   expect((await c.query("SELECT to_regclass('snapshot_label_lifecycles') AS name")).rows).toEqual([{name:null}]);
   expect((await c.query("SELECT filename FROM schema_migrations WHERE filename=$1",[filename])).rows).toEqual([]);
   await c.query("ROLLBACK TO SAVEPOINT orphan");
   await c.query(await up());await c.query("INSERT INTO schema_migrations(filename) VALUES($1)",[filename]);
   expect(await rows("named_cuts")).toEqual(original);
   const backfilled=(await rows("snapshot_label_lifecycles"))[0];
   expect((await rows("snapshot_capture_requests"))[0]).toEqual({...legacy,snapshot_id:backfilled.snapshot_id});
   await c.query("INSERT INTO named_cuts(chapter_id,version_id,series_id,l_seq,label) VALUES($1,$2,$3,$4,$5)",[id,a.version.id,f.seriesId,a.version.l_seq,"New label"]);
   expect(await rows("snapshot_label_lifecycles")).toHaveLength(2);
   expect((await rows("schema_migrations"))).toHaveLength(14);
  }finally{try{await c.query("ROLLBACK");}finally{c.release();}}
  expect(await state(pool)).toEqual(corpus);expect(await labels(pool)).toEqual(original);
 }finally{await f.app.close();}
});
