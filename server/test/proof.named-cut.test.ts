import { afterAll, expect, test } from "vitest";
import type { ChapterHistory } from "../src/corpus/repo.js";
import type { DraftDetail } from "../src/drafts/repository.js";
import { makePool, resetDb } from "./helpers.js";
import { fixture, state, labels, alice } from "./namedCutsFixtures.js";
const pool=makePool();
afterAll(()=>pool.end());
test("AXB-0096 AC2 lost naming reply, later Send and head, explicit replay",async()=>{
  await resetDb(pool);
  const f=await fixture(pool);
  try{
    const initial=await f.create("The gate shut.");
    const a=await f.write(initial.chapter.id,"The bell rang."),id=a.chapter.id;
    const before=await state(pool);
    // Transport captures committed response but the caller never receives it.
    const dropped=await f.name(id,a.version.id,"Before the bell");
    expect(dropped.statusCode,dropped.body).toBe(201);
    const captured=dropped.json();
    expect(await state(pool)).toEqual(before);
    const b=await f.write(id,"The gate opened.","send");
    expect((await f.head(id,b.version.id,"The gate opened slowly.")).statusCode).toBe(200);
    const after=await state(pool);
    expect(after.counts!.ledger).toBe(before.counts!.ledger+1);
    expect(after.counts!.versions).toBe(before.counts!.versions+1);
    expect(after.counts!.active).toBe(before.counts!.active+1);
    const h=(await f.history(id)).json<ChapterHistory>();
    expect(h.active_version_id).toBe(b.version.id);
    expect(h.versions.find(v=>v.id===a.version.id)?.snapshot).toEqual(captured.snapshot);
    const retry=await f.name(id,a.version.id,"Before the bell");
    expect(retry.statusCode).toBe(200);expect(retry.json()).toEqual(captured);
    expect(await labels(pool)).toEqual([expect.objectContaining({chapter_id:id,version_id:a.version.id,l_seq:String(a.version.l_seq),label:"Before the bell",created_at:new Date(captured.snapshot.created_at)})]);
    const draft=await f.app.inject({method:"GET",url:"/chapters/"+id+"/draft",headers:alice});
    expect(draft.statusCode).toBe(200);expect(draft.json<DraftDetail>().draft).toMatchObject({base_version:b.version.id,revision:1,content:"The gate opened slowly."});
    expect(await state(pool)).toEqual(after);
  }finally{await f.app.close();await resetDb(pool);}
  expect(await labels(pool)).toEqual([]);
  expect((await pool.query("SELECT filename FROM schema_migrations")).rowCount).toBe(18);
});
