import { afterAll, beforeEach, expect, test } from "vitest";
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
    expect(Number((await pool.query("SELECT count(*) AS n FROM schema_migrations")).rows[0].n)).toBe(16);
  }finally{await f.app.close();}
});
